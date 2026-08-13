"""Pier 0.3.1 adapter for evaluating the Coda Coding Agent.

The adapter copies a prebuilt Linux runtime into the task container, gives only
the model request process Pier's filtered-egress proxy variables, preserves Coda
JSONL, and commits workspace edits for DeepSWE v1.1's collect hook.
"""

from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Any

from pier.agents.base import BaseAgent
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.network import NetworkAllowlist


class CodaAgent(BaseAgent):
    SUPPORTS_ATIF = True

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        runtime_dir: str | Path | None = None,
        reasoning_effort: str = "max",
        max_output_tokens: int = 32_768,
        max_turns: int = 64,
        run_budget_enabled: bool = True,
        allow_all_commands: bool = False,
        harness_revision: str = "unknown",
        extra_env: dict[str, str] | None = None,
        agent_timeout_sec: float | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        if runtime_dir is None:
            raise ValueError("CodaAgent requires runtime_dir")
        self._runtime_dir = Path(runtime_dir)
        self._reasoning_effort = reasoning_effort
        if max_output_tokens < 1:
            raise ValueError("CodaAgent max_output_tokens must be positive")
        self._max_output_tokens = int(max_output_tokens)
        self._run_budget_enabled = bool(run_budget_enabled)
        if self._run_budget_enabled and max_turns < 1:
            raise ValueError("CodaAgent max_turns must be positive")
        self._max_turns = int(max_turns)
        self._allow_all_commands = bool(allow_all_commands)
        self._harness_revision = harness_revision
        self._extra_env = dict(extra_env or {})
        self._agent_timeout_sec = int(agent_timeout_sec) if agent_timeout_sec else None

    @staticmethod
    def name() -> str:
        return "coda"

    def version(self) -> str:
        return self._harness_revision

    def network_allowlist(self) -> NetworkAllowlist:
        return NetworkAllowlist(domains=["opencode.ai"])

    async def setup(self, environment: BaseEnvironment) -> None:
        if not self._runtime_dir.is_dir():
            raise FileNotFoundError(f"Coda runtime directory not found: {self._runtime_dir}")
        await environment.exec(
            command="mkdir -p /installed-agent/coda /tmp/coda-home && chmod 777 /tmp/coda-home",
            user="root",
        )
        await environment.upload_dir(
            source_dir=self._runtime_dir,
            target_dir="/installed-agent/coda",
        )
        result = await environment.exec(
            command=(
                "chmod -R a+rX /installed-agent/coda && "
                "/installed-agent/coda/node/bin/node "
                "/installed-agent/coda/packages/coding-agent/dist/bin.js --version"
            ),
            user="root",
        )
        if result.return_code != 0:
            raise RuntimeError(
                f"Coda runtime validation failed ({result.return_code}): {result.stderr or result.stdout}"
            )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("CodaAgent model_name must use provider/model form")

        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "instruction.md").write_text(instruction, encoding="utf-8")
        agent_dir = environment.env_paths.agent_dir.as_posix()
        node = "/installed-agent/coda/node/bin/node"
        entry = "/installed-agent/coda/packages/coding-agent/dist/bin.js"
        permission_args = (
            "--dangerously-bypass-approvals-and-sandbox"
            if self._allow_all_commands
            else "--sandbox danger-full-access --ask-for-approval never"
        )
        run_budget_args = (
            f"--max-turns {self._max_turns}"
            if self._run_budget_enabled
            else "--no-run-budget"
        )
        command = f"""
set +e
initial_head=$(git -C /app rev-parse HEAD)
git -C /app config user.name coda-evals
git -C /app config user.email coda-evals@localhost
{shlex.quote(node)} {shlex.quote(entry)} \\
  --print --json --no-color \\
  --workspace /app \\
  --model {shlex.quote(self.model_name)} \\
  --reasoning {shlex.quote(self._reasoning_effort)} \\
  --max-output-tokens {self._max_output_tokens} \\
  {run_budget_args} \\
  {permission_args} \\
  --trust-project --no-session \\
  < {shlex.quote(f'{agent_dir}/instruction.md')} \\
  > {shlex.quote(f'{agent_dir}/coda.jsonl')} \\
  2> {shlex.quote(f'{agent_dir}/coda.stderr')}
coda_status=$?
commit_status=0
if ! git -C /app diff --quiet || ! git -C /app diff --cached --quiet || \\
   test -n "$(git -C /app ls-files --others --exclude-standard)"; then
  git -C /app add -A
  git -C /app commit -m 'Coda DeepSWE submission' \\
    > {shlex.quote(f'{agent_dir}/commit.log')} 2>&1
  commit_status=$?
fi
committed=false
if test "$(git -C /app rev-parse HEAD)" != "$initial_head"; then committed=true; fi
printf '{{"coda_exit_code":%s,"commit_exit_code":%s,"committed":%s}}\\n' \\
  "$coda_status" "$commit_status" "$committed" \\
  > {shlex.quote(f'{agent_dir}/adapter-status.json')}
exit 0
""".strip()
        process_env = {
            **self._extra_env,
            "HOME": "/tmp/coda-home",
            "XDG_CONFIG_HOME": "/tmp/coda-home/.config",
            "XDG_DATA_HOME": "/tmp/coda-home/.local/share",
            "XDG_STATE_HOME": "/tmp/coda-home/.local/state",
            "NODE_USE_ENV_PROXY": "1",
            "NODE_USE_SYSTEM_CA": "1",
            "CI": "1",
            "TERM": "dumb",
        }
        await environment.exec(
            command=command,
            cwd="/app",
            env=environment.agent_process_env(process_env),
            timeout_sec=self._agent_timeout_sec,
        )

        events = self._read_events()
        status = self._read_status()
        self._populate_context(context, events, status)
        self._write_trajectory(instruction, events, context)
        if status.get("commit_exit_code", 0) != 0:
            raise RuntimeError(f"Coda workspace commit failed with exit {status['commit_exit_code']}")

    def _read_events(self) -> list[dict[str, Any]]:
        path = self.logs_dir / "coda.jsonl"
        events: list[dict[str, Any]] = []
        if not path.exists():
            return events
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                events.append(value)
        return events

    def _read_status(self) -> dict[str, Any]:
        path = self.logs_dir / "adapter-status.json"
        if not path.exists():
            return {"coda_exit_code": -1, "commit_exit_code": -1, "committed": False}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (json.JSONDecodeError, OSError):
            return {"coda_exit_code": -1, "commit_exit_code": -1, "committed": False}

    def _populate_context(
        self,
        context: AgentContext,
        events: list[dict[str, Any]],
        status: dict[str, Any],
    ) -> None:
        evidence = next(
            (event for event in reversed(events) if event.get("type") == "run_evidence"),
            {},
        )
        usage = evidence.get("usage") if isinstance(evidence.get("usage"), dict) else {}
        input_tokens = self._number(usage.get("inputTokens"))
        cache_read = self._number(usage.get("cacheReadTokens"))
        cache_write = self._number(usage.get("cacheWriteTokens"))
        context.n_input_tokens = input_tokens + cache_read + cache_write
        context.n_cache_tokens = cache_read
        context.n_output_tokens = self._number(usage.get("outputTokens"))
        cost = usage.get("cost") if isinstance(usage.get("cost"), dict) else {}
        total_usd = cost.get("totalUsd")
        context.cost_usd = float(total_usd) if isinstance(total_usd, (int, float)) else None
        context.n_agent_steps = sum(1 for event in events if event.get("type") == "turn_start")
        context.peak_context_tokens = self._peak_context_tokens(events)
        paths = evidence.get("paths") if isinstance(evidence.get("paths"), dict) else {}
        length_truncation_count = sum(
            1
            for event in events
            if event.get("type") == "attempt_end"
            and isinstance(event.get("candidate"), dict)
            and isinstance(event["candidate"].get("message"), dict)
            and event["candidate"]["message"].get("stopReason") == "length"
        )
        budget_exhaustion_limits = [
            str(event["exhaustion"]["limit"])
            for event in events
            if event.get("type") == "run_budget_exhausted"
            and isinstance(event.get("exhaustion"), dict)
            and isinstance(event["exhaustion"].get("limit"), str)
        ]
        rejected = [event for event in events if event.get("type") == "tool_execution_rejected"]
        context.metadata = {
            "coda_exit_code": self._number(status.get("coda_exit_code"), default=-1),
            "commit_exit_code": self._number(status.get("commit_exit_code"), default=-1),
            "committed": status.get("committed") is True,
            "run_outcome": evidence.get("outcome"),
            "elapsed_ms": self._number(evidence.get("elapsedMs")),
            "changed_paths": paths.get("changed") if isinstance(paths.get("changed"), list) else [],
            "tool_issue_count": len(evidence.get("toolIssues", []))
            if isinstance(evidence.get("toolIssues"), list)
            else 0,
            "tool_rejection_count": len(rejected),
            "policy_rejection_count": sum(
                1 for event in rejected if event.get("reason") == "policy"
            ),
            "invalid_tool_call_count": sum(
                1 for event in rejected if event.get("reason") == "invalid"
            ),
            "unresolved_failure_count": len(evidence.get("unresolvedFailures", []))
            if isinstance(evidence.get("unresolvedFailures"), list)
            else 0,
            "length_truncation_count": length_truncation_count,
            "budget_exhaustion_limits": budget_exhaustion_limits,
        }

    def _write_trajectory(
        self,
        instruction: str,
        events: list[dict[str, Any]],
        context: AgentContext,
    ) -> None:
        steps: list[dict[str, Any]] = [{"step_id": 1, "source": "user", "message": instruction}]
        for event in events:
            if event.get("type") != "attempt_end":
                continue
            candidate = event.get("candidate") if isinstance(event.get("candidate"), dict) else {}
            message = candidate.get("message") if isinstance(candidate.get("message"), dict) else {}
            usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
            steps.append(
                {
                    "step_id": len(steps) + 1,
                    "source": "agent",
                    "model_name": self.model_name,
                    "reasoning_effort": self._reasoning_effort,
                    "message": self._message_text(message.get("content")),
                    "llm_call_count": 1,
                    "metrics": {
                        "prompt_tokens": self._number(usage.get("input"))
                        + self._number(usage.get("cacheRead"))
                        + self._number(usage.get("cacheWrite")),
                        "completion_tokens": self._number(usage.get("output")),
                        "cached_tokens": self._number(usage.get("cacheRead")),
                    },
                    "extra": {
                        "outcome": event.get("outcome"),
                        "discarded": event.get("discarded") is True,
                    },
                }
            )
        trajectory = {
            "schema_version": "ATIF-v1.7",
            "session_id": next(
                (str(event.get("runId")) for event in events if event.get("type") == "run_start"),
                "unknown",
            ),
            "agent": {
                "name": "coda",
                "version": self._harness_revision,
                "model_name": self.model_name,
                "extra": {
                    "reasoning_effort": self._reasoning_effort,
                    "max_output_tokens": self._max_output_tokens,
                    "run_budget_enabled": self._run_budget_enabled,
                    "max_turns": self._max_turns if self._run_budget_enabled else None,
                    "allow_all_commands": self._allow_all_commands,
                },
            },
            "steps": steps,
            "final_metrics": {
                "total_prompt_tokens": context.n_input_tokens,
                "total_completion_tokens": context.n_output_tokens,
                "total_cached_tokens": context.n_cache_tokens,
                "total_cost_usd": context.cost_usd,
                "total_steps": len(steps),
            },
        }
        (self.logs_dir / "trajectory.json").write_text(
            json.dumps(trajectory, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
            encoding="utf-8",
        )

    @staticmethod
    def _number(value: Any, default: int = 0) -> int:
        return int(value) if isinstance(value, (int, float)) and value >= 0 else default

    @classmethod
    def _peak_context_tokens(cls, events: list[dict[str, Any]]) -> int | None:
        values: list[int] = []
        for event in events:
            if event.get("type") != "attempt_end":
                continue
            candidate = event.get("candidate") if isinstance(event.get("candidate"), dict) else {}
            message = candidate.get("message") if isinstance(candidate.get("message"), dict) else {}
            usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
            values.append(
                cls._number(usage.get("input"))
                + cls._number(usage.get("cacheRead"))
                + cls._number(usage.get("cacheWrite"))
            )
        return max(values) if values else None

    @staticmethod
    def _message_text(content: Any) -> str:
        if isinstance(content, str):
            return content
        if not isinstance(content, list):
            return ""
        parts: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            text = item.get("text")
            if item.get("type") == "text" and isinstance(text, str):
                parts.append(text)
        return "\n".join(parts)
