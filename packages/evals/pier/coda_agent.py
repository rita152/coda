"""Pier 0.3.1 adapter for evaluating the Coda Coding Agent.

The adapter copies a prebuilt Linux runtime into the task container, gives only
the model request process Pier's filtered-egress proxy variables, preserves Coda
JSONL, and transactionally salvages workspace and event artifacts for DeepSWE.
"""

from __future__ import annotations

import asyncio
import shlex
from pathlib import Path
from types import TracebackType
from typing import Any

from coda_trial_artifacts import ArtifactFinalizationError, CodaTrialArtifacts
from pier.agents.base import BaseAgent
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.network import NetworkAllowlist


PREPARE_MARKER = "CODA_PREPARE_V1"
RUN_MARKER = "CODA_RUN_V1"


class CodaAgent(BaseAgent):
    SUPPORTS_ATIF = True
    WORKSPACE_DIR = "/app"
    DEFAULT_FINALIZE_TIMEOUT_SEC = 30.0
    DEFAULT_CANCEL_FINALIZE_TIMEOUT_SEC = 5.0

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        runtime_dir: str | Path | None = None,
        reasoning_effort: str = "max",
        max_output_tokens: int = 32_768,
        event_stream_mode: str = "semantic",
        max_turns: int = 64,
        run_budget_enabled: bool = True,
        allow_all_commands: bool = False,
        harness_revision: str = "unknown",
        extra_env: dict[str, str] | None = None,
        agent_timeout_sec: float | None = None,
        artifact_finalize_timeout_sec: float = DEFAULT_FINALIZE_TIMEOUT_SEC,
        cancel_finalize_timeout_sec: float = DEFAULT_CANCEL_FINALIZE_TIMEOUT_SEC,
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
        if event_stream_mode not in {"raw", "semantic"}:
            raise ValueError("CodaAgent event_stream_mode must be raw or semantic")
        self._event_stream_mode = event_stream_mode
        self._run_budget_enabled = bool(run_budget_enabled)
        if self._run_budget_enabled and max_turns < 1:
            raise ValueError("CodaAgent max_turns must be positive")
        self._max_turns = int(max_turns)
        self._allow_all_commands = bool(allow_all_commands)
        self._harness_revision = harness_revision
        self._extra_env = dict(extra_env or {})
        self._agent_timeout_sec = int(agent_timeout_sec) if agent_timeout_sec else None
        if artifact_finalize_timeout_sec <= 0:
            raise ValueError("CodaAgent artifact_finalize_timeout_sec must be positive")
        if cancel_finalize_timeout_sec <= 0:
            raise ValueError("CodaAgent cancel_finalize_timeout_sec must be positive")
        self._artifact_finalize_timeout_sec = float(artifact_finalize_timeout_sec)
        self._cancel_finalize_timeout_sec = float(cancel_finalize_timeout_sec)

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
                f"Coda runtime validation failed ({result.return_code}): "
                f"{result.stderr or result.stdout}"
            )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("CodaAgent model_name must use provider/model form")

        artifacts = self._trial_artifacts(instruction)
        artifacts.prepare()
        agent_dir = environment.env_paths.agent_dir.as_posix()
        run_error: BaseException | None = None
        run_traceback: TracebackType | None = None

        try:
            preparation = await environment.exec(
                command=self._repository_preflight_command(),
                cwd=self.WORKSPACE_DIR,
                timeout_sec=min(self._artifact_finalize_timeout_sec, 30.0),
            )
            if preparation.return_code != 0:
                raise RuntimeError(
                    f"Coda repository preparation failed ({preparation.return_code}): "
                    f"{preparation.stderr or preparation.stdout}"
                )
            initial_head = self._marker_value(preparation.stdout, PREPARE_MARKER)
            if not initial_head:
                raise RuntimeError("Coda repository preparation did not report initial HEAD")
            artifacts.record_initial_head(initial_head)
            artifacts.mark_running()

            result = await environment.exec(
                command=self._coda_command(agent_dir),
                cwd=self.WORKSPACE_DIR,
                env=environment.agent_process_env(self._process_env()),
                timeout_sec=self._agent_timeout_sec,
            )
            coda_status = self._marker_value(result.stdout, RUN_MARKER)
            coda_exit_code = int(coda_status) if coda_status is not None else -1
            artifacts.record_run_completed(coda_exit_code)
        except BaseException as error:
            run_error = error
            run_traceback = error.__traceback__
            try:
                artifacts.record_run_exception(error)
            except BaseException:
                pass

        try:
            finalize_error = await self._finalize(
                artifacts=artifacts,
                environment=environment,
                agent_dir=agent_dir,
                context=context,
                externally_cancelled=isinstance(run_error, asyncio.CancelledError),
            )
        except BaseException as error:
            finalize_error = error

        if run_error is not None:
            raise run_error.with_traceback(run_traceback)
        if finalize_error is not None:
            raise finalize_error

    async def _finalize(
        self,
        *,
        artifacts: CodaTrialArtifacts,
        environment: BaseEnvironment,
        agent_dir: str,
        context: AgentContext,
        externally_cancelled: bool,
    ) -> BaseException | None:
        timeout_sec = (
            self._cancel_finalize_timeout_sec
            if externally_cancelled
            else self._artifact_finalize_timeout_sec
        )
        task = asyncio.create_task(
            artifacts.finalize(
                environment=environment,
                agent_dir=agent_dir,
                context=context,
                timeout_sec=timeout_sec,
            )
        )
        task.add_done_callback(self._consume_cleanup_result)
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=timeout_sec)
            return None
        except BaseException as error:
            if not task.done():
                task.cancel()
                self._record_cleanup_failure(
                    artifacts,
                    f"artifact finalization exceeded {timeout_sec:g}s",
                )
            elif not isinstance(error, ArtifactFinalizationError):
                self._record_cleanup_failure(artifacts, error)
            return error

    @staticmethod
    def _record_cleanup_failure(
        artifacts: CodaTrialArtifacts,
        error: BaseException | str,
    ) -> None:
        try:
            artifacts.record_cleanup_failure(error)
        except BaseException:
            pass

    @staticmethod
    def _consume_cleanup_result(task: asyncio.Task[Any]) -> None:
        try:
            task.exception()
        except BaseException:
            pass

    def _trial_artifacts(self, instruction: str) -> CodaTrialArtifacts:
        return CodaTrialArtifacts(
            logs_dir=self.logs_dir,
            instruction=instruction,
            model_name=self.model_name,
            reasoning_effort=self._reasoning_effort,
            harness_revision=self._harness_revision,
            max_output_tokens=self._max_output_tokens,
            run_budget_enabled=self._run_budget_enabled,
            max_turns=self._max_turns,
            allow_all_commands=self._allow_all_commands,
            workspace_dir=self.WORKSPACE_DIR,
        )

    def _repository_preflight_command(self) -> str:
        workspace = shlex.quote(self.WORKSPACE_DIR)
        return f"""
set -e
git -C {workspace} config user.name coda-evals
git -C {workspace} config user.email coda-evals@localhost
initial_head=$(git -C {workspace} rev-parse HEAD)
printf '{PREPARE_MARKER}\t%s\n' "$initial_head"
""".strip()

    def _coda_command(self, agent_dir: str) -> str:
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
        return f"""
set +e
{shlex.quote(node)} {shlex.quote(entry)} \\
  --print --json --json-mode {shlex.quote(self._event_stream_mode)} --no-color \\
  --workspace {shlex.quote(self.WORKSPACE_DIR)} \\
  --model {shlex.quote(self.model_name or '')} \\
  --reasoning {shlex.quote(self._reasoning_effort)} \\
  --max-output-tokens {self._max_output_tokens} \\
  {run_budget_args} \\
  {permission_args} \\
  --trust-project --no-session \\
  < {shlex.quote(f'{agent_dir}/instruction.md')} \\
  >> {shlex.quote(f'{agent_dir}/coda.jsonl')} \\
  2> {shlex.quote(f'{agent_dir}/coda.stderr')}
coda_status=$?
printf '{RUN_MARKER}\t%s\n' "$coda_status"
exit 0
""".strip()

    def _process_env(self) -> dict[str, str]:
        return {
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

    @staticmethod
    def _marker_value(output: str | None, marker: str) -> str | None:
        for line in reversed((output or "").splitlines()):
            prefix = f"{marker}\t"
            if line.startswith(prefix):
                return line[len(prefix) :]
        return None
