from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import types
import unittest
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Awaitable, Callable


EVALS_DIR = Path(__file__).resolve().parents[2]
PIER_DIR = EVALS_DIR / "pier"
sys.path.insert(0, str(PIER_DIR))


class StubBaseAgent:
    def __init__(
        self,
        *,
        logs_dir: Path,
        model_name: str | None = None,
        **_: Any,
    ) -> None:
        self.logs_dir = logs_dir
        self.model_name = model_name


class StubAgentContext:
    def __init__(self) -> None:
        self.n_input_tokens = 0
        self.n_cache_tokens = 0
        self.n_output_tokens = 0
        self.cost_usd: float | None = None
        self.n_agent_steps = 0
        self.peak_context_tokens: int | None = None
        self.metadata: dict[str, Any] = {}


class StubNetworkAllowlist:
    def __init__(self, *, domains: list[str]) -> None:
        self.domains = domains


def _install_pier_stubs() -> None:
    modules = {
        "pier": types.ModuleType("pier"),
        "pier.agents": types.ModuleType("pier.agents"),
        "pier.agents.base": types.ModuleType("pier.agents.base"),
        "pier.environments": types.ModuleType("pier.environments"),
        "pier.environments.base": types.ModuleType("pier.environments.base"),
        "pier.models": types.ModuleType("pier.models"),
        "pier.models.agent": types.ModuleType("pier.models.agent"),
        "pier.models.agent.context": types.ModuleType("pier.models.agent.context"),
        "pier.models.agent.network": types.ModuleType("pier.models.agent.network"),
    }
    modules["pier.agents.base"].BaseAgent = StubBaseAgent
    modules["pier.environments.base"].BaseEnvironment = object
    modules["pier.models.agent.context"].AgentContext = StubAgentContext
    modules["pier.models.agent.network"].NetworkAllowlist = StubNetworkAllowlist
    sys.modules.update(modules)


_install_pier_stubs()

from coda_agent import CodaAgent, RUN_MARKER  # noqa: E402
from coda_trial_artifacts import (  # noqa: E402
    ArtifactFinalizationError,
    CodaTrialArtifacts,
    STATUS_SCHEMA_VERSION,
)


@dataclass
class FakeExecResult:
    return_code: int
    stdout: str = ""
    stderr: str = ""


RunFixture = Callable[[], Awaitable[None]]


class FakeEnvironment:
    def __init__(
        self,
        logs_dir: Path,
        run_fixture: RunFixture,
        *,
        hang_finalize: bool = False,
    ) -> None:
        self.env_paths = SimpleNamespace(agent_dir=logs_dir)
        self._run_fixture = run_fixture
        self._hang_finalize = hang_finalize
        self.status_at_launch: dict[str, Any] | None = None

    def agent_process_env(self, value: dict[str, str]) -> dict[str, str]:
        return value

    async def exec(
        self,
        *,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: float | None = None,
        **_: Any,
    ) -> FakeExecResult:
        del timeout_sec
        if f"printf '{RUN_MARKER}" in command:
            self.status_at_launch = json.loads(
                (self.env_paths.agent_dir / "adapter-status.json").read_text(
                    encoding="utf-8"
                )
            )
            await self._run_fixture()
            return FakeExecResult(0, f"{RUN_MARKER}\t0\n")
        if self._hang_finalize and "CODA_FINALIZE_V1" in command:
            await asyncio.Future()

        process = await asyncio.create_subprocess_exec(
            "/bin/sh",
            "-c",
            command,
            cwd=cwd,
            env={**os.environ, **(env or {})},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        return FakeExecResult(
            process.returncode or 0,
            stdout.decode("utf-8", errors="replace"),
            stderr.decode("utf-8", errors="replace"),
        )


class CodaAgentArtifactTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.logs_dir = self.root / "agent"
        self.workspace = self.root / "workspace"
        self.runtime = self.root / "runtime"
        self.logs_dir.mkdir()
        self.workspace.mkdir()
        self.runtime.mkdir()
        self._git("init", "-q")
        self._git("config", "user.name", "fixture")
        self._git("config", "user.email", "fixture@localhost")
        (self.workspace / "README.md").write_text("base\n", encoding="utf-8")
        self._git("add", "README.md")
        self._git("commit", "-q", "-m", "fixture base")
        self.initial_head = self._git("rev-parse", "HEAD").strip()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    async def test_internal_timeout_salvages_partial_artifacts_and_usage(self) -> None:
        async def timeout_fixture() -> None:
            (self.workspace / "timed-out.txt").write_text(
                "valuable partial work\n", encoding="utf-8"
            )
            events = self._partial_events()
            invocation = {
                "id": "inv-timeout-read",
                "resultMessageId": "result-timeout-read",
                "providerToolCallId": "provider-timeout-read",
                "toolName": "read",
                "arguments": {"path": "README.md"},
                "sourceIndex": 0,
                "replaySafety": "safe",
            }
            candidate = events[-1]["candidate"]["message"]
            candidate["content"].append(
                {
                    "type": "toolCall",
                    "id": invocation["providerToolCallId"],
                    "name": invocation["toolName"],
                    "arguments": invocation["arguments"],
                }
            )
            candidate["stopReason"] = "toolUse"
            events.extend(
                [
                    {
                        "schemaVersion": 2,
                        "type": "tool_execution_start",
                        "runId": "run-1",
                        "sequence": 6,
                        "timestamp": 1_310,
                        "turnId": "turn-2",
                        "invocation": invocation,
                    },
                    {
                        "schemaVersion": 2,
                        "type": "tool_execution_end",
                        "runId": "run-1",
                        "sequence": 7,
                        "timestamp": 1_320,
                        "turnId": "turn-2",
                        "invocation": invocation,
                        "settlement": "returned",
                        "outcome": "success",
                        "result": {
                            "id": invocation["resultMessageId"],
                            "message": {
                                "role": "toolResult",
                                "toolCallId": invocation["providerToolCallId"],
                                "toolName": invocation["toolName"],
                                "content": [
                                    {
                                        "type": "text",
                                        "text": "1: base",
                                    }
                                ],
                                "observation": {
                                    "status": "ok",
                                    "truncated": False,
                                    "facts": {
                                        "path": "README.md",
                                        "lineStart": 1,
                                        "lineEnd": 1,
                                        "totalLines": 1,
                                    },
                                },
                                "isError": False,
                                "timestamp": 1_320,
                            },
                        },
                    },
                ]
            )
            self._write_events(events, truncated_tail=True)
            raise TimeoutError("fixture internal deadline")

        context = StubAgentContext()
        environment = FakeEnvironment(self.logs_dir, timeout_fixture)
        agent = self._agent()

        with self.assertRaisesRegex(TimeoutError, "fixture internal deadline"):
            await agent.run("repair the fixture", environment, context)

        self.assertIsNotNone(environment.status_at_launch)
        launch_status = environment.status_at_launch or {}
        self.assertEqual(launch_status["schema_version"], STATUS_SCHEMA_VERSION)
        self.assertEqual(launch_status["phase"], "running")
        self.assertIsNone(launch_status["coda_exit_code"])

        status = self._status()
        self.assertEqual(status["phase"], "terminal")
        self.assertEqual(status["outcome"], "timed_out")
        self.assertEqual(status["events"]["status"], "partial")
        self.assertFalse(status["events"]["run_end_present"])
        self.assertEqual(status["events"]["malformed_lines"], 1)
        self.assertEqual(status["artifacts"]["tool_evidence"], "tool-evidence.jsonl")
        self.assertEqual(status["trajectory"]["status"], "partial")
        self.assertEqual(status["trajectory"]["parse_error_count"], 1)
        self.assertEqual(status["commit_exit_code"], 0)
        self.assertTrue(status["committed"])
        self.assertEqual(status["workspace"]["outcome"], "committed")
        self.assertEqual(status["cleanup_errors"], [])
        self.assertIn("prepared_at", status["timestamps"])
        self.assertIn("started_at", status["timestamps"])
        self.assertIn("finalized_at", status["timestamps"])

        current_head = self._git("rev-parse", "HEAD").strip()
        self.assertNotEqual(current_head, self.initial_head)
        committed_patch = self._git("diff", self.initial_head, current_head, "--")
        self.assertIn("timed-out.txt", committed_patch)
        self.assertIn("valuable partial work", committed_patch)
        self.assertIn("timed-out.txt", self._artifact("workspace.patch"))
        self.assertIn("timed-out.txt", self._artifact("artifacts/model.patch"))

        trajectory = self._json_artifact("trajectory.json")
        self.assertEqual(trajectory["schema_version"], "ATIF-v1.7")
        self.assertEqual(trajectory["agent"]["extra"]["artifact_status"], "partial")
        self.assertFalse(trajectory["agent"]["extra"]["run_end_present"])
        self.assertEqual(len(trajectory["steps"]), 3)
        self.assertTrue((self.logs_dir / "tool-evidence.jsonl").is_file())
        tool_step = trajectory["steps"][2]
        self.assertEqual(tool_step["tool_calls"][0]["function_name"], "read")
        self.assertEqual(tool_step["tool_calls"][0]["tool_call_id"], "inv-timeout-read")
        tool_result = tool_step["observation"]["results"][0]
        self.assertEqual(tool_result["source_call_id"], "inv-timeout-read")
        evidence_ref = tool_result["extra"]["evidence_ref"]
        evidence_records = [
            json.loads(line)
            for line in (self.logs_dir / "tool-evidence.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        self.assertTrue(any(record.get("ref") == evidence_ref for record in evidence_records))
        evidence = self._json_artifact("artifact-evidence.json")
        self.assertEqual(evidence["status"], "partial")
        self.assertEqual(evidence["source"], "terminal_events")
        self.assertEqual(evidence["usage"]["attempts_observed"], 2)
        self.assertAlmostEqual(evidence["usage"]["known_cost_usd"], 0.3)

        self.assertEqual(context.n_input_tokens, 36)
        self.assertEqual(context.n_cache_tokens, 5)
        self.assertEqual(context.n_output_tokens, 12)
        self.assertEqual(context.n_agent_steps, 2)
        self.assertEqual(context.peak_context_tokens, 23)
        self.assertIsNone(context.cost_usd)
        self.assertEqual(context.metadata["run_outcome"], "partial")
        self.assertEqual(context.metadata["resource_status"], "partial")
        self.assertAlmostEqual(context.metadata["known_cost_usd"], 0.3)

        artifacts = self._artifacts()
        second_context = StubAgentContext()
        await artifacts.finalize(
            environment=environment,
            agent_dir=self.logs_dir.as_posix(),
            context=second_context,
            timeout_sec=2,
        )
        self.assertEqual(self._git("rev-parse", "HEAD").strip(), current_head)
        repeated_status = self._status()
        self.assertEqual(repeated_status["finalize_attempts"], 2)
        self.assertEqual(repeated_status["outcome"], "timed_out")
        self.assertEqual(repeated_status["workspace"]["outcome"], "committed")
        self.assertEqual(list(self.logs_dir.rglob("*.tmp")), [])

    async def test_external_cancellation_gets_short_shielded_cleanup(self) -> None:
        started = asyncio.Event()

        async def cancelled_fixture() -> None:
            (self.workspace / "cancelled.txt").write_text(
                "work before cancellation\n", encoding="utf-8"
            )
            self._write_events(self._partial_events())
            started.set()
            await asyncio.Future()

        context = StubAgentContext()
        environment = FakeEnvironment(self.logs_dir, cancelled_fixture)
        task = asyncio.create_task(
            self._agent(cancel_finalize_timeout_sec=2).run(
                "repair before cancellation", environment, context
            )
        )
        await asyncio.wait_for(started.wait(), timeout=1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

        status = self._status()
        self.assertEqual(status["phase"], "terminal")
        self.assertEqual(status["outcome"], "cancelled")
        self.assertTrue(status["committed"])
        self.assertEqual(status["events"]["status"], "partial")
        self.assertIn("cancelled.txt", self._artifact("workspace.patch"))
        self.assertEqual(context.metadata["resource_source"], "terminal_events")

    async def test_timeout_cleanup_is_bounded_and_preserves_original_timeout(self) -> None:
        async def timeout_fixture() -> None:
            self._write_events(self._partial_events())
            raise TimeoutError("primary timeout")

        context = StubAgentContext()
        environment = FakeEnvironment(
            self.logs_dir,
            timeout_fixture,
            hang_finalize=True,
        )
        started_at = time.monotonic()
        with self.assertRaisesRegex(TimeoutError, "primary timeout"):
            await self._agent(artifact_finalize_timeout_sec=0.2).run(
                "bounded cleanup", environment, context
            )
        self.assertLess(time.monotonic() - started_at, 1)
        await asyncio.sleep(0)

        status = self._status()
        self.assertEqual(status["phase"], "terminal")
        self.assertEqual(status["outcome"], "timed_out")
        self.assertTrue(
            any("finalization exceeded" in error for error in status["cleanup_errors"])
        )

    async def test_normal_no_change_run_keeps_backward_compatible_artifacts(self) -> None:
        async def completed_fixture() -> None:
            self._write_events(self._complete_events())

        context = StubAgentContext()
        environment = FakeEnvironment(self.logs_dir, completed_fixture)
        await self._agent().run("inspect only", environment, context)

        status = self._status()
        self.assertEqual(status["outcome"], "success")
        self.assertEqual(status["coda_exit_code"], 0)
        self.assertEqual(status["commit_exit_code"], 0)
        self.assertFalse(status["committed"])
        self.assertEqual(status["workspace"]["outcome"], "no_changes")
        self.assertEqual(status["trajectory"]["status"], "complete")
        self.assertEqual(status["artifacts"]["tool_evidence"], "tool-evidence.jsonl")

        trajectory = self._json_artifact("trajectory.json")
        self.assertEqual(trajectory["schema_version"], "ATIF-v1.7")
        self.assertEqual(trajectory["session_id"], "run-1")
        self.assertEqual(trajectory["agent"]["name"], "coda")
        self.assertEqual(trajectory["steps"][0]["source"], "user")
        self.assertEqual(trajectory["final_metrics"]["total_cost_usd"], 0.3)
        self.assertEqual(context.n_input_tokens, 36)
        self.assertEqual(context.n_output_tokens, 12)
        self.assertAlmostEqual(context.cost_usd or 0, 0.3)
        self.assertEqual(context.metadata["run_outcome"], "success")
        self.assertEqual(context.metadata["artifact_status"], "complete")

    async def test_process_without_run_end_is_never_fabricated_as_success(self) -> None:
        async def partial_fixture() -> None:
            self._write_events(self._partial_events())

        context = StubAgentContext()
        environment = FakeEnvironment(self.logs_dir, partial_fixture)
        await self._agent().run("finish abruptly", environment, context)

        status = self._status()
        self.assertEqual(status["coda_exit_code"], 0)
        self.assertEqual(status["outcome"], "partial")
        self.assertEqual(status["events"]["status"], "partial")
        self.assertEqual(context.metadata["run_outcome"], "partial")
        self.assertIsNone(context.cost_usd)

    async def test_complete_run_with_unavailable_cost_does_not_fabricate_zero(self) -> None:
        async def completed_fixture() -> None:
            events = self._complete_events()
            cost = events[-1]["usage"]["cost"]
            cost.update(
                {
                    "status": "unavailable",
                    "totalUsd": None,
                    "knownTotalUsd": 0,
                    "pricedAttempts": 0,
                    "unpricedAttempts": 2,
                }
            )
            self._write_events(events)

        context = StubAgentContext()
        environment = FakeEnvironment(self.logs_dir, completed_fixture)
        await self._agent().run("complete without prices", environment, context)

        self.assertIsNone(context.cost_usd)
        self.assertEqual(context.metadata["cost_status"], "unavailable")
        self.assertEqual(context.metadata["resource_status"], "partial")
        evidence = self._json_artifact("artifact-evidence.json")
        self.assertIsNone(evidence["usage"]["total_cost_usd"])
        self.assertEqual(evidence["usage"]["cost_status"], "unavailable")

    async def test_commit_failure_retains_status_events_patch_and_trajectory(self) -> None:
        hook = self.workspace / ".git/hooks/pre-commit"
        hook.write_text("#!/bin/sh\nexit 7\n", encoding="utf-8")
        hook.chmod(0o755)

        async def completed_fixture() -> None:
            (self.workspace / "uncommitted.txt").write_text(
                "salvage despite commit failure\n", encoding="utf-8"
            )
            self._write_events(self._complete_events())

        context = StubAgentContext()
        environment = FakeEnvironment(self.logs_dir, completed_fixture)
        with self.assertRaises(ArtifactFinalizationError):
            await self._agent().run("trigger commit failure", environment, context)

        status = self._status()
        self.assertEqual(status["phase"], "terminal")
        self.assertEqual(status["outcome"], "commit_failed")
        self.assertNotEqual(status["commit_exit_code"], 0)
        self.assertFalse(status["committed"])
        self.assertEqual(status["workspace"]["outcome"], "commit_failed")
        self.assertTrue(
            any("workspace commit failed" in error for error in status["cleanup_errors"])
        )
        self.assertIn("uncommitted.txt", self._artifact("workspace.patch"))
        self.assertEqual(self._json_artifact("artifact-evidence.json")["status"], "complete")
        self.assertEqual(self._json_artifact("trajectory.json")["schema_version"], "ATIF-v1.7")
        self.assertTrue((self.logs_dir / "coda.jsonl").is_file())

    def _agent(self, **kwargs: Any) -> CodaAgent:
        options = {"artifact_finalize_timeout_sec": 2, **kwargs}
        agent = CodaAgent(
            logs_dir=self.logs_dir,
            model_name="provider/model",
            runtime_dir=self.runtime,
            harness_revision="fixture-revision",
            **options,
        )
        agent.WORKSPACE_DIR = self.workspace.as_posix()
        return agent

    def _artifacts(self) -> CodaTrialArtifacts:
        return CodaTrialArtifacts(
            logs_dir=self.logs_dir,
            instruction="repair the fixture",
            model_name="provider/model",
            reasoning_effort="max",
            harness_revision="fixture-revision",
            max_output_tokens=32_768,
            run_budget_enabled=True,
            max_turns=64,
            allow_all_commands=False,
            workspace_dir=self.workspace.as_posix(),
        )

    def _partial_events(self) -> list[dict[str, Any]]:
        return [
            {
                "schemaVersion": 2,
                "type": "run_start",
                "runId": "run-1",
                "sequence": 1,
                "timestamp": 1_000,
            },
            {
                "schemaVersion": 2,
                "type": "turn_start",
                "runId": "run-1",
                "turnId": "turn-1",
                "sequence": 2,
                "timestamp": 1_100,
            },
            self._attempt_event(3, "turn-1", "attempt-1", 10, 5, 2, 1, 0.1),
            {
                "schemaVersion": 2,
                "type": "turn_start",
                "runId": "run-1",
                "turnId": "turn-2",
                "sequence": 4,
                "timestamp": 1_300,
            },
            self._attempt_event(5, "turn-2", "attempt-2", 20, 7, 3, 0, 0.2),
        ]

    def _complete_events(self) -> list[dict[str, Any]]:
        events = self._partial_events()
        events.extend(
            [
                {
                    "schemaVersion": 2,
                    "type": "run_end",
                    "runId": "run-1",
                    "sequence": 6,
                    "timestamp": 1_500,
                    "outcome": "success",
                },
                {
                    "schemaVersion": 1,
                    "type": "run_evidence",
                    "runId": "run-1",
                    "outcome": "success",
                    "startedAt": 1_000,
                    "completedAt": 1_500,
                    "elapsedMs": 500,
                    "paths": {
                        "inspected": ["README.md"],
                        "changed": [],
                        "omitted": {"inspected": 0, "changed": 0},
                    },
                    "commands": [],
                    "toolIssues": [],
                    "unresolvedFailures": [],
                    "usage": {
                        "attempts": 2,
                        "retries": 0,
                        "discardedAttempts": 0,
                        "inputTokens": 30,
                        "outputTokens": 12,
                        "cacheReadTokens": 5,
                        "cacheWriteTokens": 1,
                        "cacheWrite1hTokens": 0,
                        "reasoningTokens": 0,
                        "totalTokens": 48,
                        "cost": {
                            "currency": "USD",
                            "status": "complete",
                            "totalUsd": 0.3,
                            "knownTotalUsd": 0.3,
                            "pricedAttempts": 2,
                            "unpricedAttempts": 0,
                        },
                    },
                    "omitted": {
                        "commands": 0,
                        "toolIssues": 0,
                        "unresolvedFailures": 0,
                    },
                },
            ]
        )
        return events

    @staticmethod
    def _attempt_event(
        sequence: int,
        turn_id: str,
        attempt_id: str,
        input_tokens: int,
        output_tokens: int,
        cache_read: int,
        cache_write: int,
        cost: float,
    ) -> dict[str, Any]:
        return {
            "schemaVersion": 2,
            "type": "attempt_end",
            "runId": "run-1",
            "turnId": turn_id,
            "attemptId": attempt_id,
            "messageId": f"message-{attempt_id}",
            "sequence": sequence,
            "timestamp": 1_000 + sequence * 50,
            "attempt": 1,
            "outcome": "success",
            "discarded": False,
            "candidate": {
                "id": f"candidate-{attempt_id}",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": f"partial response {attempt_id}"}
                    ],
                    "stopReason": "stop",
                    "usage": {
                        "input": input_tokens,
                        "output": output_tokens,
                        "cacheRead": cache_read,
                        "cacheWrite": cache_write,
                        "totalTokens": input_tokens
                        + output_tokens
                        + cache_read
                        + cache_write,
                        "cost": {
                            "input": 0,
                            "output": 0,
                            "cacheRead": 0,
                            "cacheWrite": 0,
                            "total": cost,
                        },
                    },
                },
            },
        }

    def _write_events(
        self, events: list[dict[str, Any]], *, truncated_tail: bool = False
    ) -> None:
        with (self.logs_dir / "coda.jsonl").open("a", encoding="utf-8") as stream:
            for event in events:
                stream.write(json.dumps(event) + "\n")
            if truncated_tail:
                stream.write('{"type":"message_update"')

    def _git(self, *arguments: str) -> str:
        process = subprocess.run(
            ["git", "-C", self.workspace.as_posix(), *arguments],
            text=True,
            capture_output=True,
            check=False,
        )
        if process.returncode != 0:
            self.fail(
                f"git {' '.join(arguments)} failed ({process.returncode}): {process.stderr}"
            )
        return process.stdout

    def _status(self) -> dict[str, Any]:
        return self._json_artifact("adapter-status.json")

    def _json_artifact(self, relative_path: str) -> dict[str, Any]:
        value = json.loads((self.logs_dir / relative_path).read_text(encoding="utf-8"))
        self.assertIsInstance(value, dict)
        return value

    def _artifact(self, relative_path: str) -> str:
        return (self.logs_dir / relative_path).read_text(encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
