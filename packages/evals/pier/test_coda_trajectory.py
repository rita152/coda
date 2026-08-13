from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from coda_trajectory import (
    TOOL_EVIDENCE_SCHEMA_VERSION,
    iter_tool_evidence_pages,
    read_tool_evidence,
    write_coda_trajectory,
)


def invocation(
    index: int, *, tool_name: str = "bash", arguments: Any = None
) -> dict[str, Any]:
    return {
        "id": f"inv-{index}",
        "resultMessageId": f"result-{index}",
        "providerToolCallId": f"provider-{index}",
        "toolName": tool_name,
        "arguments": arguments
        if arguments is not None
        else {"command": f"printf command-{index}"},
        "sourceIndex": index,
        "replaySafety": "never",
    }


def attempt_event(
    sequence: int, calls: list[dict[str, Any]], *, turn_id: str = "turn-1"
) -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "type": "attempt_end",
        "runId": "run-trajectory",
        "sequence": sequence,
        "timestamp": 1_700_000_000_000 + sequence,
        "turnId": turn_id,
        "attemptId": f"attempt-{turn_id}",
        "messageId": f"message-{turn_id}",
        "attempt": 1,
        "outcome": "success",
        "discarded": False,
        "candidate": {
            "id": f"message-{turn_id}",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "Use the requested tools."},
                    {"type": "text", "text": "Running diagnostics."},
                    *[
                        {
                            "type": "toolCall",
                            "id": call["providerToolCallId"],
                            "name": call["toolName"],
                            "arguments": call["arguments"],
                        }
                        for call in calls
                    ],
                ],
                "api": "openai-completions",
                "provider": "test",
                "model": "test-model",
                "usage": {
                    "input": 10,
                    "output": 4,
                    "cacheRead": 3,
                    "cacheWrite": 2,
                    "totalTokens": 19,
                },
                "stopReason": "toolUse" if calls else "stop",
                "timestamp": 1_700_000_000_000 + sequence,
            },
        },
    }


def result_message(
    index: int,
    *,
    text: str,
    tool_name: str = "bash",
    status: str = "ok",
    exit_code: int | None = 0,
    signal: str | None = None,
    timed_out: bool = False,
    truncated: bool = False,
    output_ref: str | None = None,
) -> dict[str, Any]:
    facts: dict[str, Any] = {
        "exitCode": exit_code,
        "signal": signal,
        "timedOut": timed_out,
    }
    observation: dict[str, Any] = {
        "status": status,
        "truncated": truncated,
        "facts": facts,
    }
    if output_ref is not None:
        observation["outputRef"] = output_ref
    return {
        "id": f"result-{index}",
        "message": {
            "role": "toolResult",
            "toolCallId": f"provider-{index}",
            "toolName": tool_name,
            "content": [{"type": "text", "text": text}],
            "observation": observation,
            "details": {
                "exitCode": exit_code,
                "signal": signal,
                "timedOut": timed_out,
                "truncated": truncated,
            },
            "isError": status != "ok",
            "timestamp": 1_700_000_000_500 + index,
        },
    }


def terminal_event(
    sequence: int,
    call: dict[str, Any],
    *,
    text: str,
    status: str = "ok",
    settlement: str = "returned",
    exit_code: int | None = 0,
    signal: str | None = None,
    timed_out: bool = False,
    truncated: bool = False,
    output_ref: str | None = None,
) -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "type": "tool_execution_end",
        "runId": "run-trajectory",
        "sequence": sequence,
        "timestamp": 1_700_000_001_000 + sequence,
        "turnId": "turn-1",
        "invocation": call,
        "settlement": settlement,
        "outcome": "success" if status == "ok" else "error",
        "result": result_message(
            call["sourceIndex"],
            text=text,
            tool_name=call["toolName"],
            status=status,
            exit_code=exit_code,
            signal=signal,
            timed_out=timed_out,
            truncated=truncated,
            output_ref=output_ref,
        ),
    }


def base_events() -> list[dict[str, Any]]:
    return [
        {
            "schemaVersion": 2,
            "type": "run_start",
            "runId": "run-trajectory",
            "sequence": 1,
            "timestamp": 1_700_000_000_001,
            "source": "prompt",
        },
        {
            "schemaVersion": 2,
            "type": "turn_start",
            "runId": "run-trajectory",
            "sequence": 2,
            "timestamp": 1_700_000_000_002,
            "turnId": "turn-1",
            "steeringMessages": [],
        },
    ]


class CodaTrajectoryTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.output_dir = Path(self._temporary.name)
        self.event_path = self.output_dir / "coda.jsonl"

    def tearDown(self) -> None:
        self._temporary.cleanup()

    def write_events(
        self, events: list[dict[str, Any]], *, malformed_tail: bool = False
    ) -> None:
        with self.event_path.open("w", encoding="utf-8") as stream:
            for event in events:
                stream.write(json.dumps(event, ensure_ascii=False) + "\n")
            if malformed_tail:
                stream.write('{"type":"attempt_end"')

    def project(self, **overrides: Any):
        options = {
            "instruction": "Fix the issue",
            "agent_version": "test-revision",
            "model_name": "test/model",
            "reasoning_effort": "max",
            "agent_extra": {"run_budget_enabled": True},
            "final_metrics": {
                "total_prompt_tokens": 15,
                "total_completion_tokens": 4,
                "total_cached_tokens": 3,
                "total_cost_usd": 0.01,
            },
        }
        options.update(overrides)
        return write_coda_trajectory(self.event_path, self.output_dir, **options)

    def read_trajectory(self) -> dict[str, Any]:
        return json.loads(
            (self.output_dir / "trajectory.json").read_text(encoding="utf-8")
        )

    def evidence_records(self) -> list[dict[str, Any]]:
        return [
            json.loads(line)
            for line in (self.output_dir / "tool-evidence.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]

    def assert_locked_schema_if_available(self, trajectory: dict[str, Any]) -> None:
        if importlib.util.find_spec("pier") is None:
            return
        from pier.models.trajectories import Trajectory

        Trajectory.model_validate(trajectory)

    def test_parallel_tools_preserve_source_and_terminal_order_with_paged_redacted_evidence(
        self,
    ) -> None:
        first = invocation(
            0,
            arguments={
                "command": "OPENAI_API_KEY='top-secret-value' printf '\u001b[31mfirst\u001b[0m'",
                "headers": {"Authorization": "Bearer bearer-secret-value"},
                "payload": ("argument-body-" * 200) + "argument-tail",
            },
        )
        second = invocation(1, tool_name="read", arguments={"path": "src/example.ts"})
        large_result = "\u001b]0;owned\u0007" + ("result-body-" * 200) + "result-tail"
        events = [
            *base_events(),
            attempt_event(3, [first, second]),
            {
                "schemaVersion": 2,
                "type": "tool_execution_start",
                "runId": "run-trajectory",
                "sequence": 4,
                "timestamp": 1_700_000_000_004,
                "turnId": "turn-1",
                "invocation": first,
            },
            {
                "schemaVersion": 2,
                "type": "tool_execution_start",
                "runId": "run-trajectory",
                "sequence": 5,
                "timestamp": 1_700_000_000_005,
                "turnId": "turn-1",
                "invocation": second,
            },
            terminal_event(
                6,
                second,
                text="failed with password=hunter2",
                status="error",
                exit_code=7,
                signal="SIGTERM",
                timed_out=True,
                truncated=True,
                output_ref="tool-output:second",
            ),
            terminal_event(7, first, text=large_result),
            {
                "schemaVersion": 2,
                "type": "turn_end",
                "runId": "run-trajectory",
                "sequence": 8,
                "timestamp": 1_700_000_000_008,
                "turnId": "turn-1",
                "outcome": "success",
            },
            {
                "schemaVersion": 2,
                "type": "run_end",
                "runId": "run-trajectory",
                "sequence": 9,
                "timestamp": 1_700_000_000_009,
                "outcome": "success",
            },
        ]
        self.write_events(events)

        summary = self.project(
            instruction="Fix it with token=instruction-secret",
            evidence_page_bytes=256,
            atif_argument_bytes=512,
            atif_result_bytes=512,
        )
        trajectory = self.read_trajectory()
        agent_step = trajectory["steps"][1]

        self.assert_locked_schema_if_available(trajectory)

        self.assertTrue(summary.complete)
        self.assertEqual(
            ["inv-0", "inv-1"],
            [call["tool_call_id"] for call in agent_step["tool_calls"]],
        )
        self.assertEqual(
            [0, 1], [call["extra"]["source_index"] for call in agent_step["tool_calls"]]
        )
        self.assertEqual(
            ["bash", "read"],
            [call["function_name"] for call in agent_step["tool_calls"]],
        )
        results = agent_step["observation"]["results"]
        self.assertEqual(
            ["inv-1", "inv-0"], [result["source_call_id"] for result in results]
        )
        failed = results[0]["extra"]
        self.assertEqual("error", failed["status"])
        self.assertEqual("returned", failed["settlement"])
        self.assertEqual(7, failed["exit_code"])
        self.assertEqual("SIGTERM", failed["signal"])
        self.assertTrue(failed["timed_out"])
        self.assertEqual("recoverable-overflow", failed["completeness"])
        self.assertEqual(6, failed["terminal_sequence"])
        self.assertLessEqual(len(results[1]["content"].encode("utf-8")), 512)

        call_extra = agent_step["tool_calls"][0]["extra"]
        self.assertTrue(agent_step["tool_calls"][0]["arguments"]["_coda_truncated"])
        self.assertLessEqual(
            len(
                json.dumps(
                    agent_step["tool_calls"][0]["arguments"],
                    ensure_ascii=True,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("ascii")
            ),
            512,
        )
        call_evidence = read_tool_evidence(
            summary.tool_evidence_path, call_extra["evidence_ref"]
        )
        self.assertEqual("inv-0", call_evidence["invocation"]["id"])
        self.assertEqual(
            "[REDACTED]",
            call_evidence["invocation"]["arguments"]["headers"]["Authorization"],
        )
        self.assertIn("[REDACTED]", call_evidence["invocation"]["arguments"]["command"])
        self.assertTrue(
            call_evidence["invocation"]["arguments"]["payload"].endswith(
                "argument-tail"
            )
        )
        result_extra = results[1]["extra"]
        full_result = read_tool_evidence(
            summary.tool_evidence_path, result_extra["evidence_ref"]
        )
        result_text = full_result["result"]["message"]["content"][0]["text"]
        self.assertTrue(result_text.endswith("result-tail"))
        self.assertIn("[CONTROL-SEQUENCE]", result_text)
        self.assertNotIn("\u001b", result_text)
        self.assertGreater(result_extra["evidence_page_count"], 1)
        page = list(
            iter_tool_evidence_pages(
                summary.tool_evidence_path,
                result_extra["evidence_ref"],
                start_page=1,
                max_pages=1,
            )
        )
        self.assertEqual(1, len(page))
        self.assertEqual(1, page[0]["page_index"])

        serialized = json.dumps(trajectory, ensure_ascii=False)
        evidence_serialized = summary.tool_evidence_path.read_text(encoding="utf-8")
        for secret in (
            "top-secret-value",
            "bearer-secret-value",
            "hunter2",
            "instruction-secret",
        ):
            self.assertNotIn(secret, serialized)
            self.assertNotIn(secret, evidence_serialized)
        result_manifest = next(
            record
            for record in self.evidence_records()
            if record.get("record_type") == "item"
            and record.get("ref") == result_extra["evidence_ref"]
        )
        self.assertEqual(result_extra["evidence_sha256"], result_manifest["sha256"])

    def test_no_run_end_emits_valid_explicitly_partial_pending_result(self) -> None:
        call = invocation(0)
        events = [
            *base_events(),
            attempt_event(3, [call]),
            {
                "schemaVersion": 2,
                "type": "tool_execution_start",
                "runId": "run-trajectory",
                "sequence": 4,
                "timestamp": 1_700_000_000_004,
                "turnId": "turn-1",
                "invocation": call,
            },
        ]
        self.write_events(events, malformed_tail=True)

        summary = self.project()
        trajectory = self.read_trajectory()
        lifecycle = trajectory["extra"]["coda"]["lifecycle"]
        result = trajectory["steps"][1]["observation"]["results"][0]

        self.assert_locked_schema_if_available(trajectory)

        self.assertFalse(summary.complete)
        self.assertEqual(1, summary.parse_error_count)
        self.assertEqual(1, summary.pending_tool_count)
        self.assertEqual("partial", lifecycle["status"])
        self.assertFalse(lifecycle["run_end_observed"])
        self.assertEqual("pending", result["extra"]["status"])
        self.assertIsNone(result["extra"]["settlement"])
        self.assertFalse(result["extra"]["terminal"])
        self.assertEqual("missing-terminal", result["extra"]["completeness"])
        pending_evidence = read_tool_evidence(
            summary.tool_evidence_path,
            result["extra"]["evidence_ref"],
        )
        self.assertFalse(pending_evidence["terminal"])
        self.assertIn("Partial Coda trajectory", trajectory["notes"])

    def test_artifact_finalizer_can_supply_one_pass_terminal_event_iterable(
        self,
    ) -> None:
        events = [
            *base_events(),
            attempt_event(3, []),
            {
                "schemaVersion": 2,
                "type": "turn_end",
                "runId": "run-trajectory",
                "sequence": 4,
                "timestamp": 1_700_000_000_004,
                "turnId": "turn-1",
                "outcome": "success",
            },
            {
                "schemaVersion": 2,
                "type": "run_end",
                "runId": "run-trajectory",
                "sequence": 5,
                "timestamp": 1_700_000_000_005,
                "outcome": "success",
            },
        ]
        consumed: list[int] = []

        def terminal_events():
            for event in events:
                consumed.append(event["sequence"])
                yield event

        summary = write_coda_trajectory(
            terminal_events(),
            self.output_dir,
            instruction="Fix the issue",
            agent_version="test-revision",
            model_name="test/model",
            reasoning_effort="max",
            source_line_count=10,
            source_parse_error_count=1,
            source_scan_complete=False,
        )
        trajectory = self.read_trajectory()

        self.assertEqual([1, 2, 3, 4, 5], consumed)
        self.assertFalse(summary.complete)
        self.assertEqual(5, summary.event_count)
        self.assertEqual(1, summary.parse_error_count)
        self.assertFalse(
            trajectory["extra"]["coda"]["lifecycle"]["event_scan_complete"]
        )
        self.assert_locked_schema_if_available(trajectory)

    def test_105_command_fixture_retains_every_terminal_record_despite_compact_run_evidence(
        self,
    ) -> None:
        calls = [invocation(index) for index in range(105)]
        events = [*base_events(), attempt_event(3, calls)]
        sequence = 4
        for call in calls:
            events.append(
                {
                    "schemaVersion": 2,
                    "type": "tool_execution_start",
                    "runId": "run-trajectory",
                    "sequence": sequence,
                    "timestamp": 1_700_000_000_000 + sequence,
                    "turnId": "turn-1",
                    "invocation": call,
                }
            )
            sequence += 1
        terminal_order = list(reversed(calls))
        for call in terminal_order:
            events.append(
                terminal_event(sequence, call, text=f"terminal-{call['sourceIndex']}")
            )
            sequence += 1
        events.extend(
            [
                {
                    "schemaVersion": 2,
                    "type": "turn_end",
                    "runId": "run-trajectory",
                    "sequence": sequence,
                    "timestamp": 1_700_000_000_000 + sequence,
                    "turnId": "turn-1",
                    "outcome": "success",
                },
                {
                    "schemaVersion": 2,
                    "type": "run_end",
                    "runId": "run-trajectory",
                    "sequence": sequence + 1,
                    "timestamp": 1_700_000_000_001 + sequence,
                    "outcome": "success",
                },
                {
                    "schemaVersion": 1,
                    "type": "run_evidence",
                    "runId": "run-trajectory",
                    "commands": [
                        {"invocationId": f"inv-{index}"} for index in range(32)
                    ],
                    "omissions": {"commands": 73},
                },
            ]
        )
        self.write_events(events)

        summary = self.project()
        trajectory = self.read_trajectory()
        step = trajectory["steps"][1]
        terminal_manifests = [
            record
            for record in self.evidence_records()
            if record.get("record_type") == "item"
            and record.get("kind") == "result"
            and record.get("terminal") is True
        ]

        self.assert_locked_schema_if_available(trajectory)

        self.assertTrue(summary.complete)
        self.assertEqual(105, summary.tool_call_count)
        self.assertEqual(105, summary.terminal_tool_count)
        self.assertEqual(105, len(step["tool_calls"]))
        self.assertEqual(105, len(step["observation"]["results"]))
        self.assertEqual(105, len(terminal_manifests))
        self.assertEqual(
            [f"inv-{index}" for index in range(105)],
            [call["tool_call_id"] for call in step["tool_calls"]],
        )
        self.assertEqual(
            [f"inv-{index}" for index in reversed(range(105))],
            [result["source_call_id"] for result in step["observation"]["results"]],
        )
        self.assertEqual(
            TOOL_EVIDENCE_SCHEMA_VERSION,
            trajectory["extra"]["coda"]["tool_evidence"]["schema_version"],
        )

    @unittest.skipUnless(
        importlib.util.find_spec("pier") is not None, "datacurve-pier is not installed"
    )
    def test_output_validates_with_locked_pier_trajectory_model(self) -> None:
        from pier.models.trajectories import Trajectory

        call = invocation(0)
        self.write_events(
            [
                *base_events(),
                attempt_event(3, [call]),
                {
                    "schemaVersion": 2,
                    "type": "tool_execution_start",
                    "runId": "run-trajectory",
                    "sequence": 4,
                    "timestamp": 1_700_000_000_004,
                    "turnId": "turn-1",
                    "invocation": call,
                },
                terminal_event(5, call, text="schema validation"),
                {
                    "schemaVersion": 2,
                    "type": "turn_end",
                    "runId": "run-trajectory",
                    "sequence": 6,
                    "timestamp": 1_700_000_000_006,
                    "turnId": "turn-1",
                    "outcome": "success",
                },
                {
                    "schemaVersion": 2,
                    "type": "run_end",
                    "runId": "run-trajectory",
                    "sequence": 7,
                    "timestamp": 1_700_000_000_007,
                    "outcome": "success",
                },
            ]
        )
        self.project()
        Trajectory.model_validate(self.read_trajectory())


if __name__ == "__main__":
    unittest.main()
