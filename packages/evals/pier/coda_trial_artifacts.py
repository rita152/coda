"""Transactional artifact recovery for one Coda Pier trial.

The adapter owns process control; this module owns durable status, terminal-event
reduction, workspace salvage, and ATIF projection. ``read_terminal_events``,
``recover_usage``, and ``CodaTrialArtifacts.write_trajectory`` are the extension
seam for richer trajectory projection. Everything in ``finalize`` is safe to
invoke again after an interrupted or failed cleanup.
"""

from __future__ import annotations

import json
import math
import os
import shlex
import tempfile
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Protocol

from coda_trajectory import TrajectoryArtifactSummary, write_coda_trajectory

STATUS_SCHEMA_VERSION = "coda-adapter-status-v3"
EVIDENCE_SCHEMA_VERSION = "coda-artifact-evidence-v1"
FINALIZE_MARKER = "CODA_FINALIZE_V1"
TRANSIENT_EVENT_TYPES = {
    "attempt_start",
    "message_start",
    "message_update",
    "tool_execution_progress",
}


class ExecResult(Protocol):
    return_code: int
    stdout: str | None
    stderr: str | None


class ArtifactEnvironment(Protocol):
    async def exec(
        self,
        *,
        command: str,
        cwd: str | None = None,
        timeout_sec: float | None = None,
        **kwargs: Any,
    ) -> ExecResult: ...


class ArtifactContext(Protocol):
    n_input_tokens: int
    n_cache_tokens: int
    n_output_tokens: int
    cost_usd: float | None
    n_agent_steps: int
    peak_context_tokens: int | None
    metadata: dict[str, Any]


class ArtifactFinalizationError(RuntimeError):
    """Artifact cleanup completed with one or more recorded failures."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = tuple(errors)
        super().__init__("; ".join(errors))


@dataclass(frozen=True)
class EventLog:
    events: tuple[dict[str, Any], ...]
    malformed_lines: int
    omitted_transient_events: int
    scan_complete: bool
    run_end_present: bool
    run_evidence: dict[str, Any] | None

    @property
    def status(self) -> str:
        if self.scan_complete and self.run_end_present and self.run_evidence is not None:
            return "complete"
        if (
            self.events
            or self.omitted_transient_events > 0
            or self.malformed_lines > 0
            or not self.scan_complete
        ):
            return "partial"
        return "missing"


@dataclass(frozen=True)
class RecoveredUsage:
    source: str
    status: str
    cost_status: str
    attempts: int
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    total_cost_usd: float | None
    known_cost_usd: float
    priced_attempts: int
    unpriced_attempts: int


@dataclass(frozen=True)
class WorkspaceSalvage:
    commit_exit_code: int
    committed: bool
    outcome: str
    patch_exit_code: int
    patch_bytes: int
    current_head: str | None


@dataclass(frozen=True)
class ArtifactFinalizationResult:
    status: dict[str, Any]
    events: EventLog
    usage: RecoveredUsage
    workspace: WorkspaceSalvage | None


class CodaTrialArtifacts:
    """Own the durable artifacts and idempotent cleanup for one Pier trial."""

    def __init__(
        self,
        *,
        logs_dir: Path,
        instruction: str,
        model_name: str | None,
        reasoning_effort: str,
        harness_revision: str,
        max_output_tokens: int,
        run_budget_enabled: bool,
        max_turns: int,
        allow_all_commands: bool,
        event_stream_mode: str = "semantic",
        run_control_work_sec: int | None = None,
        run_control_grace_sec: int | None = None,
        run_control_stationary_turns: int | None = None,
        adapter_finalize_margin_sec: int | None = None,
        pier_hard_timeout_sec: int | None = None,
        workspace_dir: str = "/app",
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.logs_dir = logs_dir
        self.instruction = instruction
        self.model_name = model_name
        self.reasoning_effort = reasoning_effort
        self.harness_revision = harness_revision
        self.max_output_tokens = max_output_tokens
        self.run_budget_enabled = run_budget_enabled
        self.max_turns = max_turns
        self.allow_all_commands = allow_all_commands
        self.event_stream_mode = event_stream_mode
        self.run_control_work_sec = run_control_work_sec
        self.run_control_grace_sec = run_control_grace_sec
        self.run_control_stationary_turns = run_control_stationary_turns
        self.adapter_finalize_margin_sec = adapter_finalize_margin_sec
        self.pier_hard_timeout_sec = pier_hard_timeout_sec
        self.workspace_dir = workspace_dir
        self._now = now or (lambda: datetime.now(UTC))

    @property
    def status_path(self) -> Path:
        return self.logs_dir / "adapter-status.json"

    def prepare(self) -> dict[str, Any]:
        """Create status and append-only inputs before the Coda process starts."""

        self.logs_dir.mkdir(parents=True, exist_ok=True)
        _atomic_write_text(self.logs_dir / "instruction.md", self.instruction)
        events_path = self.logs_dir / "coda.jsonl"
        descriptor = os.open(events_path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(descriptor)

        existing = self._load_status()
        if existing.get("schema_version") == STATUS_SCHEMA_VERSION:
            return existing

        now = self._timestamp()
        status: dict[str, Any] = {
            "schema_version": STATUS_SCHEMA_VERSION,
            "phase": "prepared",
            "outcome": "pending",
            "timestamps": {"prepared_at": now, "updated_at": now},
            "coda_exit_code": None,
            "commit_exit_code": None,
            "committed": False,
            "cleanup_errors": [],
            "finalize_attempts": 0,
            "run": {
                "outcome": "pending",
                "error_type": None,
                "error": None,
            },
            "run_control": None,
            "workspace": {
                "initial_head": None,
                "current_head": None,
                "outcome": "pending",
                "patch_exit_code": None,
                "patch_bytes": 0,
            },
            "events": {
                "status": "missing",
                "event_count": 0,
                "malformed_lines": 0,
                "omitted_transient_events": 0,
                "scan_complete": False,
                "run_end_present": False,
                "run_evidence_present": False,
            },
            "artifacts": {
                "events": "coda.jsonl",
                "trajectory": None,
                "tool_evidence": None,
                "evidence": None,
                "patch": None,
                "model_patch": None,
            },
            "trajectory": {
                "status": "pending",
                "step_count": 0,
                "tool_call_count": 0,
                "terminal_tool_count": 0,
                "pending_tool_count": 0,
                "parse_error_count": 0,
            },
        }
        self._write_status(status)
        return status

    def record_initial_head(self, initial_head: str) -> None:
        status = self._require_status()
        workspace = _mapping(status.get("workspace"))
        workspace["initial_head"] = initial_head
        status["workspace"] = workspace
        self._write_status(status)

    def mark_running(self) -> None:
        status = self._require_status()
        status["phase"] = "running"
        status["outcome"] = "pending"
        timestamps = _mapping(status.get("timestamps"))
        timestamps.setdefault("started_at", self._timestamp())
        status["timestamps"] = timestamps
        self._write_status(status)

    def record_run_completed(self, coda_exit_code: int) -> None:
        status = self._require_status()
        status["coda_exit_code"] = int(coda_exit_code)
        status["run"] = {
            "outcome": "completed",
            "error_type": None,
            "error": None,
        }
        timestamps = _mapping(status.get("timestamps"))
        timestamps.setdefault("run_finished_at", self._timestamp())
        status["timestamps"] = timestamps
        self._write_status(status)

    def record_run_exception(self, error: BaseException) -> None:
        status = self._require_status()
        outcome = classify_run_exception(error)
        status["run"] = {
            "outcome": outcome,
            "error_type": type(error).__name__,
            "error": _safe_error(error),
        }
        timestamps = _mapping(status.get("timestamps"))
        timestamps.setdefault("run_finished_at", self._timestamp())
        status["timestamps"] = timestamps
        status["outcome"] = outcome
        self._write_status(status)

    def record_cleanup_failure(self, error: BaseException | str) -> None:
        """Record a bounded-cleanup failure even if async finalization was cut off."""

        status = self._require_status()
        message = _safe_error(error)
        status["cleanup_errors"] = _append_unique(status.get("cleanup_errors"), message)
        run_outcome = _mapping(status.get("run")).get("outcome")
        if run_outcome not in {"timed_out", "cancelled"}:
            status["outcome"] = "artifact_error"
        status["phase"] = "terminal"
        timestamps = _mapping(status.get("timestamps"))
        timestamps["finalized_at"] = self._timestamp()
        status["timestamps"] = timestamps
        self._write_status(status)

    async def finalize(
        self,
        *,
        environment: ArtifactEnvironment,
        agent_dir: str,
        context: ArtifactContext,
        timeout_sec: float,
    ) -> ArtifactFinalizationResult:
        """Salvage Git and event artifacts, then atomically publish terminal status."""

        status = self._require_status()
        status["phase"] = "finalizing"
        status["finalize_attempts"] = _non_negative_int(status.get("finalize_attempts")) + 1
        timestamps = _mapping(status.get("timestamps"))
        timestamps.setdefault("finalize_started_at", self._timestamp())
        status["timestamps"] = timestamps
        self._write_status(status)

        errors: list[str] = []
        workspace: WorkspaceSalvage | None = None
        deadline = time.monotonic() + timeout_sec
        try:
            workspace = await self._salvage_workspace(
                environment=environment,
                agent_dir=agent_dir,
                initial_head=_optional_string(_mapping(status.get("workspace")).get("initial_head")),
                timeout_sec=max(0.1, timeout_sec * 0.6),
            )
            if workspace.commit_exit_code != 0:
                errors.append(f"workspace commit failed with exit {workspace.commit_exit_code}")
            if workspace.patch_exit_code != 0:
                errors.append(f"workspace patch extraction failed with exit {workspace.patch_exit_code}")
        except BaseException as error:
            errors.append(f"workspace salvage failed: {_safe_error(error)}")

        event_log = read_terminal_events(
            self.logs_dir / "coda.jsonl",
            deadline=max(time.monotonic(), deadline - min(0.25, timeout_sec * 0.1)),
        )
        usage = recover_usage(event_log)
        run_control = _run_control_report(event_log.events)
        artifact_paths = {
            "events": "coda.jsonl",
            "trajectory": None,
            "tool_evidence": None,
            "evidence": None,
            "patch": None,
            "model_patch": None,
        }
        trajectory_summary: TrajectoryArtifactSummary | None = None

        try:
            populate_context(context, event_log, usage, status, workspace)
        except Exception as error:
            errors.append(f"context recovery failed: {_safe_error(error)}")

        try:
            trajectory_summary = self.write_trajectory(event_log, context)
            artifact_paths["trajectory"] = "trajectory.json"
            artifact_paths["tool_evidence"] = "tool-evidence.jsonl"
        except Exception as error:
            errors.append(f"trajectory recovery failed: {_safe_error(error)}")

        try:
            self.write_evidence(event_log, usage)
            artifact_paths["evidence"] = "artifact-evidence.json"
        except Exception as error:
            errors.append(f"evidence recovery failed: {_safe_error(error)}")

        if workspace is not None and workspace.patch_exit_code == 0:
            artifact_paths["patch"] = "workspace.patch"
            artifact_paths["model_patch"] = "artifacts/model.patch"

        status = self._require_status()
        status["run_control"] = run_control
        if workspace is not None:
            status["commit_exit_code"] = workspace.commit_exit_code
            status["committed"] = workspace.committed
            workspace_status = _mapping(status.get("workspace"))
            workspace_status.update(
                {
                    "current_head": workspace.current_head,
                    "outcome": workspace.outcome,
                    "patch_exit_code": workspace.patch_exit_code,
                    "patch_bytes": workspace.patch_bytes,
                }
            )
            status["workspace"] = workspace_status
        else:
            status["commit_exit_code"] = -1

        status["events"] = {
            "status": event_log.status,
            "event_count": len(event_log.events),
            "malformed_lines": event_log.malformed_lines,
            "omitted_transient_events": event_log.omitted_transient_events,
            "scan_complete": event_log.scan_complete,
            "run_end_present": event_log.run_end_present,
            "run_evidence_present": event_log.run_evidence is not None,
        }
        status["artifacts"] = artifact_paths
        status["trajectory"] = (
            {
                "status": "complete" if trajectory_summary.complete else "partial",
                "step_count": trajectory_summary.step_count,
                "tool_call_count": trajectory_summary.tool_call_count,
                "terminal_tool_count": trajectory_summary.terminal_tool_count,
                "pending_tool_count": trajectory_summary.pending_tool_count,
                "parse_error_count": trajectory_summary.parse_error_count,
                "evidence_sha256": trajectory_summary.evidence_sha256,
            }
            if trajectory_summary is not None
            else {
                "status": "missing",
                "step_count": 0,
                "tool_call_count": 0,
                "terminal_tool_count": 0,
                "pending_tool_count": 0,
                "parse_error_count": event_log.malformed_lines,
            }
        )
        status["cleanup_errors"] = _append_unique(status.get("cleanup_errors"), *errors)
        status["outcome"] = _terminal_outcome(status, event_log, workspace, errors)
        status["phase"] = "terminal"
        timestamps = _mapping(status.get("timestamps"))
        timestamps["finalized_at"] = self._timestamp()
        status["timestamps"] = timestamps
        self._write_status(status)

        result = ArtifactFinalizationResult(
            status=status,
            events=event_log,
            usage=usage,
            workspace=workspace,
        )
        if errors:
            raise ArtifactFinalizationError(errors)
        return result

    async def _salvage_workspace(
        self,
        *,
        environment: ArtifactEnvironment,
        agent_dir: str,
        initial_head: str | None,
        timeout_sec: float,
    ) -> WorkspaceSalvage:
        result = await environment.exec(
            command=self._workspace_salvage_command(agent_dir, initial_head),
            cwd=self.workspace_dir,
            timeout_sec=timeout_sec,
        )
        marker = _parse_finalize_marker(result.stdout)
        if marker is None:
            detail = (result.stderr or result.stdout or "missing finalization marker").strip()
            raise RuntimeError(
                f"workspace salvage command failed ({result.return_code}): {detail[:500]}"
            )
        return marker

    def _workspace_salvage_command(self, agent_dir: str, initial_head: str | None) -> str:
        workspace = shlex.quote(self.workspace_dir)
        quoted_agent_dir = shlex.quote(agent_dir)
        quoted_initial_head = shlex.quote(initial_head or "")
        commit_log = shlex.quote(f"{agent_dir}/commit.log")
        patch_path = shlex.quote(f"{agent_dir}/workspace.patch")
        patch_temporary = shlex.quote(f"{agent_dir}/.workspace.patch.tmp")
        artifact_dir = shlex.quote(f"{agent_dir}/artifacts")
        model_patch = shlex.quote(f"{agent_dir}/artifacts/model.patch")
        model_patch_temporary = shlex.quote(f"{agent_dir}/artifacts/.model.patch.tmp")
        return f"""
set +e
initial_head={quoted_initial_head}
had_changes=false
if ! git -C {workspace} diff --quiet || ! git -C {workspace} diff --cached --quiet || \\
   test -n "$(git -C {workspace} ls-files --others --exclude-standard)"; then
  had_changes=true
fi
commit_status=0
if test "$had_changes" = true; then
  git -C {workspace} add -A
  git -C {workspace} commit -m 'Coda DeepSWE submission' > {commit_log} 2>&1
  commit_status=$?
fi
current_head=$(git -C {workspace} rev-parse HEAD 2>/dev/null)
committed=false
if test -n "$initial_head" && test "$current_head" != "$initial_head"; then
  committed=true
fi
if test "$commit_status" -ne 0; then
  workspace_outcome=commit_failed
elif test "$committed" = true; then
  workspace_outcome=committed
elif test "$had_changes" = true; then
  workspace_outcome=uncommitted
else
  workspace_outcome=no_changes
fi
mkdir -p {quoted_agent_dir} {artifact_dir}
patch_base="$initial_head"
if test -z "$patch_base" || ! git -C {workspace} cat-file -e "$patch_base^{{commit}}" 2>/dev/null; then
  patch_base=HEAD
fi
git -C {workspace} diff --binary "$patch_base" -- > {patch_temporary}
patch_status=$?
patch_bytes=0
if test "$patch_status" -eq 0; then
  mv {patch_temporary} {patch_path}
  cp {patch_path} {model_patch_temporary}
  mv {model_patch_temporary} {model_patch}
  patch_bytes=$(wc -c < {patch_path} | tr -d ' ')
else
  rm -f {patch_temporary} {model_patch_temporary}
fi
printf '{FINALIZE_MARKER}\t%s\t%s\t%s\t%s\t%s\t%s\n' \\
  "$commit_status" "$committed" "$workspace_outcome" "$patch_status" "$patch_bytes" "$current_head"
exit 0
""".strip()

    def write_trajectory(
        self, event_log: EventLog, context: ArtifactContext
    ) -> TrajectoryArtifactSummary:
        """Project retained terminal events into ATIF and paged Tool evidence."""

        return write_coda_trajectory(
            event_log.events,
            self.logs_dir,
            instruction=self.instruction,
            agent_version=self.harness_revision,
            model_name=self.model_name,
            reasoning_effort=self.reasoning_effort,
            agent_extra={
                "reasoning_effort": self.reasoning_effort,
                "max_output_tokens": self.max_output_tokens,
                "run_budget_enabled": self.run_budget_enabled,
                "max_turns": self.max_turns if self.run_budget_enabled else None,
                "allow_all_commands": self.allow_all_commands,
                "event_stream_mode": self.event_stream_mode,
                "run_control_work_sec": self.run_control_work_sec,
                "run_control_grace_sec": self.run_control_grace_sec,
                "run_control_stationary_turns": self.run_control_stationary_turns,
                "adapter_finalize_margin_sec": self.adapter_finalize_margin_sec,
                "pier_hard_timeout_sec": self.pier_hard_timeout_sec,
                "run_control": _run_control_report(event_log.events),
                "artifact_status": event_log.status,
                "run_end_present": event_log.run_end_present,
                "event_scan_complete": event_log.scan_complete,
                "malformed_event_lines": event_log.malformed_lines,
            },
            final_metrics={
                "total_prompt_tokens": context.n_input_tokens,
                "total_completion_tokens": context.n_output_tokens,
                "total_cached_tokens": context.n_cache_tokens,
                "total_cost_usd": context.cost_usd,
            },
            source_line_count=len(event_log.events)
            + event_log.omitted_transient_events
            + event_log.malformed_lines,
            source_parse_error_count=event_log.malformed_lines,
            source_scan_complete=event_log.scan_complete,
        )

    def write_evidence(self, event_log: EventLog, usage: RecoveredUsage) -> None:
        """Write the versioned completeness/resource recovery sidecar."""

        run_id = next(
            (
                str(event.get("runId"))
                for event in event_log.events
                if event.get("runId") is not None
            ),
            "unknown",
        )
        evidence = {
            "schema_version": EVIDENCE_SCHEMA_VERSION,
            "status": event_log.status,
            "source": usage.source,
            "run_id": run_id,
            "run_end_present": event_log.run_end_present,
            "run_evidence_present": event_log.run_evidence is not None,
            "event_count": len(event_log.events),
            "malformed_event_lines": event_log.malformed_lines,
            "omitted_transient_events": event_log.omitted_transient_events,
            "event_scan_complete": event_log.scan_complete,
            "usage": {
                "status": usage.status,
                "cost_status": usage.cost_status,
                "attempts_observed": usage.attempts,
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
                "cache_read_tokens": usage.cache_read_tokens,
                "cache_write_tokens": usage.cache_write_tokens,
                "total_cost_usd": usage.total_cost_usd,
                "known_cost_usd": usage.known_cost_usd,
                "priced_attempts": usage.priced_attempts,
                "unpriced_attempts": usage.unpriced_attempts,
            },
        }
        _atomic_write_json(self.logs_dir / "artifact-evidence.json", evidence)

    def _load_status(self) -> dict[str, Any]:
        try:
            value = json.loads(self.status_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}
        return value if isinstance(value, dict) else {}

    def _require_status(self) -> dict[str, Any]:
        status = self._load_status()
        if status.get("schema_version") != STATUS_SCHEMA_VERSION:
            raise RuntimeError("Coda adapter status is missing or incompatible")
        return status

    def _write_status(self, status: dict[str, Any]) -> None:
        timestamps = _mapping(status.get("timestamps"))
        timestamps["updated_at"] = self._timestamp()
        status["timestamps"] = timestamps
        _atomic_write_json(self.status_path, status)

    def _timestamp(self) -> str:
        value = self._now()
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def read_terminal_events(path: Path, *, deadline: float | None = None) -> EventLog:
    """Read complete JSON objects while tolerating a truncated final JSONL record."""

    events: list[dict[str, Any]] = []
    malformed_lines = 0
    omitted_transient_events = 0
    scan_complete = True
    try:
        with path.open("r", encoding="utf-8", errors="replace") as stream:
            for line in stream:
                if deadline is not None and time.monotonic() >= deadline:
                    scan_complete = False
                    break
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    if line.strip():
                        malformed_lines += 1
                    continue
                if isinstance(value, dict):
                    if value.get("type") in TRANSIENT_EVENT_TYPES:
                        omitted_transient_events += 1
                    else:
                        events.append(value)
                else:
                    malformed_lines += 1
    except FileNotFoundError:
        pass

    run_end_present = any(event.get("type") == "run_end" for event in events)
    run_evidence = next(
        (event for event in reversed(events) if event.get("type") == "run_evidence"),
        None,
    )
    return EventLog(
        tuple(events),
        malformed_lines,
        omitted_transient_events,
        scan_complete,
        run_end_present,
        run_evidence,
    )


def recover_usage(event_log: EventLog) -> RecoveredUsage:
    evidence_usage = _mapping(
        event_log.run_evidence.get("usage") if event_log.run_evidence is not None else None
    )
    if event_log.run_evidence is not None and evidence_usage:
        cost = _mapping(evidence_usage.get("cost"))
        total_usd = _non_negative_float(cost.get("totalUsd"))
        known_total_usd = _non_negative_float(cost.get("knownTotalUsd"))
        if known_total_usd is None:
            known_total_usd = total_usd or 0.0
        priced = _non_negative_int(cost.get("pricedAttempts"))
        unpriced = _non_negative_int(cost.get("unpricedAttempts"))
        cost_status = cost.get("status")
        if cost_status not in {"complete", "partial", "unavailable"}:
            cost_status = "complete" if total_usd is not None else "unavailable"
        resource_status = (
            "complete"
            if event_log.status == "complete" and cost_status == "complete"
            else "partial"
        )
        return RecoveredUsage(
            source="run_evidence",
            status=resource_status,
            cost_status=str(cost_status),
            attempts=_non_negative_int(evidence_usage.get("attempts")),
            input_tokens=_non_negative_int(evidence_usage.get("inputTokens")),
            output_tokens=_non_negative_int(evidence_usage.get("outputTokens")),
            cache_read_tokens=_non_negative_int(evidence_usage.get("cacheReadTokens")),
            cache_write_tokens=_non_negative_int(evidence_usage.get("cacheWriteTokens")),
            total_cost_usd=total_usd if cost_status == "complete" else None,
            known_cost_usd=known_total_usd,
            priced_attempts=priced,
            unpriced_attempts=unpriced,
        )

    attempts: dict[str, dict[str, Any]] = {}
    for index, event in enumerate(event_log.events):
        if event.get("type") != "attempt_end":
            continue
        identifier = event.get("attemptId")
        key = str(identifier) if identifier is not None else f"event-{index}"
        attempts[key] = event

    input_tokens = 0
    output_tokens = 0
    cache_read_tokens = 0
    cache_write_tokens = 0
    known_cost_usd = 0.0
    priced_attempts = 0
    for event in attempts.values():
        candidate = _mapping(event.get("candidate"))
        message = _mapping(candidate.get("message"))
        usage = _mapping(message.get("usage"))
        input_tokens += _non_negative_int(usage.get("input"))
        output_tokens += _non_negative_int(usage.get("output"))
        cache_read_tokens += _non_negative_int(usage.get("cacheRead"))
        cache_write_tokens += _non_negative_int(usage.get("cacheWrite"))
        total = _non_negative_float(_mapping(usage.get("cost")).get("total"))
        if total is not None:
            known_cost_usd += total
            priced_attempts += 1

    attempt_count = len(attempts)
    if attempt_count == 0:
        usage_status = "missing"
        cost_status = "missing"
    elif priced_attempts == attempt_count:
        usage_status = "partial" if event_log.status != "complete" else "complete"
        cost_status = "partial" if event_log.status != "complete" else "complete"
    else:
        usage_status = "partial"
        cost_status = "partial" if priced_attempts else "unavailable"
    return RecoveredUsage(
        source="terminal_events" if attempt_count else "missing",
        status=usage_status,
        cost_status=cost_status,
        attempts=attempt_count,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=cache_read_tokens,
        cache_write_tokens=cache_write_tokens,
        total_cost_usd=known_cost_usd if cost_status == "complete" else None,
        known_cost_usd=known_cost_usd,
        priced_attempts=priced_attempts,
        unpriced_attempts=attempt_count - priced_attempts,
    )


def populate_context(
    context: ArtifactContext,
    event_log: EventLog,
    usage: RecoveredUsage,
    status: dict[str, Any],
    workspace: WorkspaceSalvage | None,
) -> None:
    context.n_input_tokens = (
        usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens
    )
    context.n_cache_tokens = usage.cache_read_tokens
    context.n_output_tokens = usage.output_tokens
    context.cost_usd = usage.total_cost_usd

    turn_ids = {
        str(event.get("turnId"))
        for event in event_log.events
        if event.get("type") == "attempt_end" and event.get("turnId") is not None
    }
    turn_starts = sum(1 for event in event_log.events if event.get("type") == "turn_start")
    context.n_agent_steps = max(turn_starts, len(turn_ids))
    context.peak_context_tokens = _peak_context_tokens(event_log.events)

    evidence = event_log.run_evidence or {}
    paths = _mapping(evidence.get("paths"))
    rejected = [
        event for event in event_log.events if event.get("type") == "tool_execution_rejected"
    ]
    run_outcome = evidence.get("outcome")
    if event_log.status != "complete":
        run_outcome = "partial" if event_log.events else None
    context.metadata = {
        "coda_exit_code": _number_or_default(status.get("coda_exit_code"), -1),
        "commit_exit_code": workspace.commit_exit_code
        if workspace is not None
        else _number_or_default(status.get("commit_exit_code"), -1),
        "committed": workspace.committed
        if workspace is not None
        else status.get("committed") is True,
        "run_outcome": run_outcome,
        "elapsed_ms": _non_negative_int(evidence.get("elapsedMs")),
        "changed_paths": paths.get("changed")
        if isinstance(paths.get("changed"), list)
        else [],
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
        "length_truncation_count": sum(
            1
            for event in event_log.events
            if event.get("type") == "attempt_end"
            and _mapping(_mapping(event.get("candidate")).get("message")).get(
                "stopReason"
            )
            == "length"
        ),
        "budget_exhaustion_limits": [
            str(_mapping(event.get("exhaustion"))["limit"])
            for event in event_log.events
            if event.get("type") == "run_budget_exhausted"
            and isinstance(_mapping(event.get("exhaustion")).get("limit"), str)
        ],
        "artifact_status": event_log.status,
        "run_end_present": event_log.run_end_present,
        "resource_source": usage.source,
        "resource_status": usage.status,
        "cost_status": usage.cost_status,
        "observed_attempt_count": usage.attempts,
        "priced_attempt_count": usage.priced_attempts,
        "unpriced_attempt_count": usage.unpriced_attempts,
        "known_cost_usd": usage.known_cost_usd,
        "run_control": _run_control_report(event_log.events),
    }


def _run_control_report(events: tuple[dict[str, Any], ...]) -> dict[str, Any] | None:
    for event in reversed(events):
        if event.get("type") not in {"run_evidence", "run_end"}:
            continue
        run_control = event.get("runControl")
        if isinstance(run_control, dict):
            return dict(run_control)
    return None


def classify_run_exception(error: BaseException) -> str:
    import asyncio

    if isinstance(error, asyncio.CancelledError):
        return "cancelled"
    if isinstance(error, TimeoutError) or "timeout" in type(error).__name__.lower():
        return "timed_out"
    return "failed"


def _terminal_outcome(
    status: dict[str, Any],
    event_log: EventLog,
    workspace: WorkspaceSalvage | None,
    errors: list[str],
) -> str:
    run_outcome = _mapping(status.get("run")).get("outcome")
    if run_outcome in {"timed_out", "cancelled"}:
        return str(run_outcome)
    if workspace is not None and workspace.commit_exit_code != 0:
        return "commit_failed"
    if errors:
        return "artifact_error"
    if run_outcome == "failed":
        return "failed"
    if event_log.status != "complete":
        return "partial"
    coda_exit_code = _number_or_default(status.get("coda_exit_code"), -1)
    evidence_outcome = (event_log.run_evidence or {}).get("outcome")
    if coda_exit_code == 0 and evidence_outcome == "success":
        return "success"
    return "failed"


def _parse_finalize_marker(output: str | None) -> WorkspaceSalvage | None:
    for line in reversed((output or "").splitlines()):
        fields = line.split("\t")
        if len(fields) != 7 or fields[0] != FINALIZE_MARKER:
            continue
        try:
            return WorkspaceSalvage(
                commit_exit_code=int(fields[1]),
                committed=fields[2] == "true",
                outcome=fields[3],
                patch_exit_code=int(fields[4]),
                patch_bytes=max(0, int(fields[5])),
                current_head=fields[6] or None,
            )
        except ValueError:
            return None
    return None


def _peak_context_tokens(events: tuple[dict[str, Any], ...]) -> int | None:
    values: list[int] = []
    for event in events:
        if event.get("type") != "attempt_end":
            continue
        candidate = _mapping(event.get("candidate"))
        message = _mapping(candidate.get("message"))
        usage = _mapping(message.get("usage"))
        values.append(
            _non_negative_int(usage.get("input"))
            + _non_negative_int(usage.get("cacheRead"))
            + _non_negative_int(usage.get("cacheWrite"))
        )
    return max(values) if values else None


def _mapping(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _number_or_default(value: Any, default: int) -> int:
    return int(value) if isinstance(value, (int, float)) and value >= 0 else default


def _non_negative_int(value: Any) -> int:
    return int(value) if isinstance(value, (int, float)) and value >= 0 else 0


def _non_negative_float(value: Any) -> float | None:
    if not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) and number >= 0 else None


def _append_unique(value: Any, *messages: str) -> list[str]:
    existing = [str(item) for item in value] if isinstance(value, list) else []
    for message in messages:
        if message and message not in existing:
            existing.append(message)
    return existing


def _safe_error(error: BaseException | str) -> str:
    text = error if isinstance(error, str) else f"{type(error).__name__}: {error}"
    return " ".join(str(text).replace("\x00", "").split())[:500]


def _atomic_write_json(path: Path, value: Any) -> None:
    payload = json.dumps(
        value,
        indent=2,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
    ) + "\n"
    _atomic_write_text(path, payload)


def _atomic_write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
