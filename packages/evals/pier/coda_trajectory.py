"""Streaming Coda terminal-event projection to ATIF and paged Tool evidence.

`write_coda_trajectory` is intentionally independent of Pier's runtime types so
the trial artifact finalizer can call it for normal and salvaged partial runs.
The input JSONL is consumed one line at a time; only the active Turn is retained
while completed ATIF steps and redacted Tool evidence are spooled to disk.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO

ATIF_SCHEMA_VERSION = "ATIF-v1.7"
TOOL_EVIDENCE_SCHEMA_VERSION = "coda-tool-evidence-v1"
TRAJECTORY_PROJECTION_VERSION = 1
DEFAULT_EVIDENCE_PAGE_BYTES = 16 * 1024
DEFAULT_ATIF_ARGUMENT_BYTES = 4 * 1024
DEFAULT_ATIF_RESULT_BYTES = 8 * 1024

__all__ = [
    "ATIF_SCHEMA_VERSION",
    "TOOL_EVIDENCE_SCHEMA_VERSION",
    "EvidenceDescriptor",
    "TrajectoryArtifactSummary",
    "iter_tool_evidence_pages",
    "read_tool_evidence",
    "sanitize_json",
    "sanitize_text",
    "write_coda_trajectory",
]

_REDACTED = "[REDACTED]"
_SENSITIVE_KEY_SUFFIXES = (
    "apikey",
    "accesstoken",
    "refreshtoken",
    "authtoken",
    "password",
    "passwd",
    "secret",
    "credential",
    "privatekey",
    "clientsecret",
    "cookie",
    "setcookie",
)
_SENSITIVE_KEYS = {
    "authorization",
    "proxyauthorization",
    "authentication",
    "token",
    "key",
}
_ANSI_SEQUENCE = re.compile(
    r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*(?:\x1b\\)|[@-_])"
    r"|\x9b[0-?]*[ -/]*[@-~]|\x9d[^\x07\x9c]*(?:\x07|\x9c)",
    re.DOTALL,
)
_CONTROL_CHARACTER = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_PRIVATE_KEY = re.compile(
    r"-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----.*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----",
    re.IGNORECASE | re.DOTALL,
)
_AUTHORIZATION = re.compile(
    r"(?i)(\bauthorization\b\s*[:=]\s*(?:bearer|basic)?\s*)[^\s,;]+"
)
_BEARER = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}")
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)(\b(?:[A-Z0-9_]*(?:API_?KEY|ACCESS_?TOKEN|REFRESH_?TOKEN|AUTH_?TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|PRIVATE_?KEY|CLIENT_?SECRET)|token|password|secret)\b\s*[:=]\s*)"
    r"(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"
)
_KNOWN_TOKEN = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16}|"
    r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b"
)
_URL_CREDENTIAL = re.compile(r"([A-Za-z][A-Za-z0-9+.-]*://[^\s/:@]+:)[^\s/@]+(@)")


@dataclass(frozen=True)
class EvidenceDescriptor:
    """Stable location and integrity metadata for one redacted evidence item."""

    ref: str
    sha256: str
    byte_length: int
    page_count: int

    def atif_fields(self) -> dict[str, Any]:
        return {
            "evidence_ref": self.ref,
            "evidence_path": "tool-evidence.jsonl",
            "evidence_sha256": self.sha256,
            "evidence_byte_length": self.byte_length,
            "evidence_page_count": self.page_count,
        }


@dataclass(frozen=True)
class TrajectoryArtifactSummary:
    trajectory_path: Path
    tool_evidence_path: Path
    session_id: str
    complete: bool
    step_count: int
    tool_call_count: int
    terminal_tool_count: int
    pending_tool_count: int
    event_count: int
    parse_error_count: int
    evidence_sha256: str


@dataclass
class _ReadDiagnostics:
    line_count: int = 0
    parse_error_count: int = 0


@dataclass
class _CandidateCall:
    provider_tool_call_id: str
    tool_name: str
    arguments: Any
    source_index: int


@dataclass
class _Attempt:
    turn_id: str
    attempt_id: str | None
    event_sequence: int
    timestamp: str | None
    message: str
    reasoning_content: str | None
    metrics: dict[str, int]
    outcome: str | None
    discarded: bool
    calls: list[_CandidateCall]
    llm_call_count: int = 1


@dataclass
class _Invocation:
    tool_call_id: str
    invocation_id: str | None
    provider_tool_call_id: str
    tool_name: str
    turn_id: str
    source_index: int
    call_sequence: int
    started: bool
    synthetic: bool
    arguments: dict[str, Any]
    call_evidence: EvidenceDescriptor
    terminal_sequence: int | None = None
    terminal_timestamp: str | None = None
    status: str = "pending"
    settlement: str | None = None
    outcome: str | None = None
    rejection_reason: str | None = None
    exit_code: int | float | None = None
    signal: str | int | None = None
    timed_out: bool | None = None
    truncated: bool | None = None
    completeness: str = "missing-terminal"
    output_ref: str | None = None
    result_content: str = ""
    result_evidence: EvidenceDescriptor | None = None
    terminal: bool = False


@dataclass
class _Turn:
    turn_id: str
    attempts: list[_Attempt] = field(default_factory=list)
    invocations: dict[str, _Invocation] = field(default_factory=dict)


def _record(value: Any) -> Mapping[str, Any] | None:
    return value if isinstance(value, Mapping) else None


def _value(value: Mapping[str, Any] | None, *names: str) -> Any:
    if value is None:
        return None
    for name in names:
        if name in value:
            return value[name]
    return None


def _safe_string(value: Any, default: str = "") -> str:
    return sanitize_text(value) if isinstance(value, str) else default


def _sensitive_key(value: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", value.lower())
    return normalized in _SENSITIVE_KEYS or normalized.endswith(_SENSITIVE_KEY_SUFFIXES)


def sanitize_text(value: str) -> str:
    """Redact credential-shaped text and neutralize terminal control bytes."""

    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = _ANSI_SEQUENCE.sub("[CONTROL-SEQUENCE]", value)
    value = _CONTROL_CHARACTER.sub(
        lambda match: f"[CTRL-{ord(match.group(0)):02X}]",
        value,
    )
    value = _PRIVATE_KEY.sub(_REDACTED, value)
    value = _AUTHORIZATION.sub(lambda match: f"{match.group(1)}{_REDACTED}", value)
    value = _BEARER.sub(f"Bearer {_REDACTED}", value)
    value = _SECRET_ASSIGNMENT.sub(lambda match: f"{match.group(1)}{_REDACTED}", value)
    value = _KNOWN_TOKEN.sub(_REDACTED, value)
    return _URL_CREDENTIAL.sub(
        lambda match: f"{match.group(1)}{_REDACTED}{match.group(2)}", value
    )


def sanitize_json(value: Any, *, _depth: int = 0) -> Any:
    """Return deterministic, JSON-safe, recursively redacted evidence data."""

    if _depth > 64:
        return "[MAX-DEPTH]"
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else "[NON-FINITE-NUMBER]"
    if isinstance(value, str):
        return sanitize_text(value)
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for raw_key, item in value.items():
            key = sanitize_text(str(raw_key))
            result[key] = (
                _REDACTED
                if _sensitive_key(key)
                else sanitize_json(item, _depth=_depth + 1)
            )
        return result
    if isinstance(value, (list, tuple)):
        return [sanitize_json(item, _depth=_depth + 1) for item in value]
    return sanitize_text(str(value))


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("ascii")


def _write_json_line(stream: TextIO, hasher: Any, value: Mapping[str, Any]) -> None:
    line = (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        + "\n"
    )
    stream.write(line)
    hasher.update(line.encode("utf-8"))


def _evidence_ref(tool_call_id: str, kind: str) -> str:
    digest = hashlib.sha256(tool_call_id.encode("utf-8", errors="replace")).hexdigest()
    return f"{TOOL_EVIDENCE_SCHEMA_VERSION}/{digest}/{kind}"


class _ToolEvidenceWriter:
    def __init__(self, path: Path, page_bytes: int) -> None:
        if page_bytes < 256:
            raise ValueError("Tool evidence pages must be at least 256 bytes")
        path.parent.mkdir(parents=True, exist_ok=True)
        # The writer owns this handle until finalize/abort atomically installs or removes it.
        temporary = tempfile.NamedTemporaryFile(  # noqa: SIM115
            mode="w",
            encoding="utf-8",
            newline="\n",
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
            delete=False,
        )
        self.path = path
        self.temporary_path = Path(temporary.name)
        self._stream = temporary
        self._hasher = hashlib.sha256()
        self.page_bytes = page_bytes
        self.item_count = 0
        self.terminal_tool_count = 0
        self._invocations: set[str] = set()
        self._refs: set[str] = set()
        self._closed = False
        self._write(
            {
                "schema_version": TOOL_EVIDENCE_SCHEMA_VERSION,
                "record_type": "header",
                "content_encoding": "utf-8-json",
                "page_bytes": page_bytes,
                "redacted": True,
            }
        )

    def _write(self, value: Mapping[str, Any]) -> None:
        _write_json_line(self._stream, self._hasher, value)

    def write_item(
        self,
        *,
        tool_call_id: str,
        invocation_id: str | None,
        kind: str,
        value: Any,
        index: Mapping[str, Any],
    ) -> EvidenceDescriptor:
        ref = _evidence_ref(tool_call_id, kind)
        if ref in self._refs:
            raise ValueError(f"Duplicate Tool evidence reference: {ref}")
        self._refs.add(ref)
        sanitized = sanitize_json(value)
        content = _canonical_bytes(sanitized)
        digest = hashlib.sha256(content).hexdigest()
        pages = [
            content[offset : offset + self.page_bytes].decode("ascii")
            for offset in range(0, len(content), self.page_bytes)
        ] or [""]
        safe_index = sanitize_json(index)
        manifest = {
            "schema_version": TOOL_EVIDENCE_SCHEMA_VERSION,
            "record_type": "item",
            "ref": ref,
            "kind": kind,
            "invocation_id": sanitize_text(invocation_id)
            if invocation_id is not None
            else None,
            "tool_call_id": sanitize_text(tool_call_id),
            "sha256": digest,
            "byte_length": len(content),
            "page_count": len(pages),
            **(safe_index if isinstance(safe_index, dict) else {}),
        }
        self._write(manifest)
        for page_index, data in enumerate(pages):
            self._write(
                {
                    "schema_version": TOOL_EVIDENCE_SCHEMA_VERSION,
                    "record_type": "page",
                    "ref": ref,
                    "page_index": page_index,
                    "page_count": len(pages),
                    "data": data,
                }
            )
        self.item_count += 1
        if invocation_id is not None:
            self._invocations.add(invocation_id)
        if kind == "result" and index.get("terminal") is True:
            self.terminal_tool_count += 1
        return EvidenceDescriptor(
            ref=ref,
            sha256=digest,
            byte_length=len(content),
            page_count=len(pages),
        )

    def finalize(self, *, complete: bool, pending_tool_count: int) -> str:
        if self._closed:
            raise RuntimeError("Tool evidence writer is already closed")
        self._write(
            {
                "schema_version": TOOL_EVIDENCE_SCHEMA_VERSION,
                "record_type": "summary",
                "complete": complete,
                "item_count": self.item_count,
                "invocation_count": len(self._invocations),
                "terminal_tool_count": self.terminal_tool_count,
                "pending_tool_count": pending_tool_count,
            }
        )
        self._stream.flush()
        os.fsync(self._stream.fileno())
        self._stream.close()
        self._closed = True
        os.replace(self.temporary_path, self.path)
        return self._hasher.hexdigest()

    def abort(self) -> None:
        if not self._closed:
            self._stream.close()
            self._closed = True
        try:
            self.temporary_path.unlink()
        except FileNotFoundError:
            pass


def iter_tool_evidence_pages(
    path: str | Path,
    ref: str,
    *,
    start_page: int = 0,
    max_pages: int | None = None,
) -> Iterator[dict[str, Any]]:
    """Stream a stable evidence ref's pages without loading the sidecar."""

    if start_page < 0:
        raise ValueError("start_page must be non-negative")
    if max_pages is not None and max_pages < 1:
        raise ValueError("max_pages must be positive")
    yielded = 0
    with Path(path).open(encoding="utf-8") as stream:
        for line in stream:
            record = json.loads(line)
            if (
                not isinstance(record, dict)
                or record.get("record_type") != "page"
                or record.get("ref") != ref
            ):
                continue
            page_index = record.get("page_index")
            if not isinstance(page_index, int) or page_index < start_page:
                continue
            yield record
            yielded += 1
            if max_pages is not None and yielded >= max_pages:
                return


def read_tool_evidence(path: str | Path, ref: str) -> Any:
    """Reconstruct and integrity-check one complete evidence item."""

    manifest: dict[str, Any] | None = None
    pages: dict[int, str] = {}
    with Path(path).open(encoding="utf-8") as stream:
        for line in stream:
            record = json.loads(line)
            if not isinstance(record, dict) or record.get("ref") != ref:
                continue
            if record.get("record_type") == "item":
                manifest = record
            elif record.get("record_type") == "page":
                page_index = record.get("page_index")
                data = record.get("data")
                if isinstance(page_index, int) and isinstance(data, str):
                    pages[page_index] = data
    if manifest is None:
        raise KeyError(ref)
    page_count = manifest.get("page_count")
    if not isinstance(page_count, int) or sorted(pages) != list(range(page_count)):
        raise ValueError(f"Tool evidence pages are incomplete for {ref}")
    content = "".join(pages[index] for index in range(page_count)).encode("ascii")
    if len(content) != manifest.get("byte_length"):
        raise ValueError(f"Tool evidence byte length does not match for {ref}")
    if hashlib.sha256(content).hexdigest() != manifest.get("sha256"):
        raise ValueError(f"Tool evidence hash does not match for {ref}")
    return json.loads(content)


def _bounded_text(value: str, limit: int, descriptor: EvidenceDescriptor) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= limit:
        return value
    marker = f"\n[full redacted value: {descriptor.ref} sha256={descriptor.sha256}]"
    marker_bytes = marker.encode("utf-8")
    available = max(0, limit - len(marker_bytes))
    prefix = encoded[:available]
    while prefix:
        try:
            visible = prefix.decode("utf-8")
            break
        except UnicodeDecodeError:
            prefix = prefix[:-1]
    else:
        visible = ""
    return visible + marker


def _bounded_arguments(
    value: Any, limit: int, descriptor: EvidenceDescriptor
) -> dict[str, Any]:
    sanitized = sanitize_json(value)
    canonical = _canonical_bytes(sanitized)
    if isinstance(sanitized, dict) and len(canonical) <= limit:
        return sanitized
    bounded: dict[str, Any] = {
        "_coda_truncated": True,
        "_coda_evidence_ref": descriptor.ref,
    }
    preview = canonical.decode("ascii")
    low = 0
    high = len(preview)
    while low < high:
        midpoint = (low + high + 1) // 2
        candidate = {**bounded, "_coda_preview": preview[:midpoint]}
        if len(_canonical_bytes(candidate)) <= limit:
            low = midpoint
        else:
            high = midpoint - 1
    if low > 0:
        bounded["_coda_preview"] = preview[:low]
    if len(_canonical_bytes(bounded)) > limit:
        return {"_coda_truncated": True}
    return bounded


def _iso_timestamp(value: Any) -> str | None:
    if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    seconds = value / 1000 if value >= 100_000_000_000 else value
    try:
        return (
            datetime.fromtimestamp(seconds, tz=timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
    except (OverflowError, OSError, ValueError):
        return None


def _event_sequence(event: Mapping[str, Any], ordinal: int) -> int:
    sequence = _value(event, "sequence", "eventSeq", "event_seq")
    return sequence if isinstance(sequence, int) and sequence >= 0 else ordinal


def _message_parts(content: Any) -> tuple[str, str | None, list[_CandidateCall]]:
    if isinstance(content, str):
        return sanitize_text(content), None, []
    if not isinstance(content, list):
        return "", None, []
    text: list[str] = []
    reasoning: list[str] = []
    calls: list[_CandidateCall] = []
    for item in content:
        block = _record(item)
        if block is None:
            continue
        block_type = _value(block, "type")
        if block_type == "text" and isinstance(block.get("text"), str):
            text.append(sanitize_text(block["text"]))
        elif block_type == "thinking":
            thinking = _value(block, "thinking", "text", "content")
            if isinstance(thinking, str):
                reasoning.append(sanitize_text(thinking))
        elif block_type == "toolCall":
            provider_id = _safe_string(
                _value(block, "id", "toolCallId", "tool_call_id")
            )
            calls.append(
                _CandidateCall(
                    provider_tool_call_id=provider_id,
                    tool_name=_safe_string(
                        _value(block, "name", "toolName", "tool_name"), "unknown"
                    ),
                    arguments=_value(block, "arguments")
                    if _value(block, "arguments") is not None
                    else {},
                    source_index=len(calls),
                )
            )
    return "\n".join(text), "\n".join(reasoning) or None, calls


def _usage_metrics(message: Mapping[str, Any]) -> dict[str, int]:
    usage = _record(message.get("usage")) or {}

    def number(name: str) -> int:
        value = usage.get(name)
        return int(value) if isinstance(value, (int, float)) and value >= 0 else 0

    return {
        "prompt_tokens": number("input") + number("cacheRead") + number("cacheWrite"),
        "completion_tokens": number("output"),
        "cached_tokens": number("cacheRead"),
    }


def _result_message(result: Any) -> Mapping[str, Any]:
    wrapper = _record(result) or {}
    return _record(wrapper.get("message")) or wrapper


def _result_text(result: Any) -> str:
    message = _result_message(result)
    content = message.get("content")
    if isinstance(content, str):
        return sanitize_text(content)
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        block = _record(item)
        if block is None:
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            parts.append(sanitize_text(block["text"]))
        elif block.get("type") == "image":
            mime_type = _safe_string(_value(block, "mimeType", "mime_type"), "unknown")
            parts.append(f"[image: {mime_type}]")
    return "\n".join(parts)


def _first_present(*values: Any) -> Any:
    return next((value for value in values if value is not None), None)


def _terminal_projection(event: Mapping[str, Any]) -> dict[str, Any]:
    result = event.get("result")
    message = _result_message(result)
    observation = _record(message.get("observation"))
    facts = _record(observation.get("facts")) if observation else None
    details = _record(message.get("details"))
    event_type = event.get("type")
    rejection_reason = _safe_string(event.get("reason")) or None
    status = _value(observation, "status")
    if status not in {"ok", "error", "denied", "aborted"}:
        outcome = event.get("outcome")
        if event_type == "tool_execution_rejected":
            status = (
                "denied"
                if rejection_reason == "policy"
                else "aborted"
                if rejection_reason in {"aborted", "not_started"}
                else "error"
            )
        else:
            status = (
                "ok"
                if outcome == "success"
                else "aborted"
                if outcome == "aborted"
                else "error"
            )
    truncated_value = _first_present(
        _value(observation, "truncated"),
        _value(details, "truncated"),
    )
    truncated = truncated_value if isinstance(truncated_value, bool) else None
    output_ref_value = _first_present(
        _value(observation, "outputRef", "output_ref"),
        _value(details, "outputRef", "output_ref"),
    )
    output_ref = (
        sanitize_text(output_ref_value) if isinstance(output_ref_value, str) else None
    )
    explicit_completeness = _first_present(
        _value(observation, "completeness"),
        _value(facts, "completeness"),
    )
    if isinstance(explicit_completeness, str):
        completeness = sanitize_text(explicit_completeness)
    elif truncated is False:
        completeness = "complete"
    elif truncated is True and output_ref:
        completeness = "recoverable-overflow"
    elif truncated is True:
        completeness = "lossy-overflow"
    else:
        completeness = "unknown"
    exit_code = _first_present(
        _value(facts, "exitCode", "exit_code"),
        _value(details, "exitCode", "exit_code"),
        _value(event, "exitCode", "exit_code"),
    )
    if not isinstance(exit_code, (int, float)) or isinstance(exit_code, bool):
        exit_code = None
    signal = _first_present(
        _value(facts, "signal"),
        _value(details, "signal"),
        _value(event, "signal"),
    )
    if not isinstance(signal, (str, int)) or isinstance(signal, bool):
        signal = None
    timed_out_value = _first_present(
        _value(facts, "timedOut", "timed_out"),
        _value(details, "timedOut", "timed_out"),
        _value(event, "timedOut", "timed_out"),
    )
    return {
        "result": result,
        "status": status,
        "settlement": _safe_string(event.get("settlement")) or None,
        "outcome": _safe_string(event.get("outcome")) or None,
        "rejection_reason": rejection_reason,
        "exit_code": exit_code,
        "signal": sanitize_json(signal),
        "timed_out": timed_out_value if isinstance(timed_out_value, bool) else None,
        "truncated": truncated,
        "completeness": completeness,
        "output_ref": output_ref,
    }


def _synthetic_tool_call_id(
    run_id: str,
    turn_id: str,
    attempt_id: str | None,
    provider_tool_call_id: str,
    source_index: int,
) -> str:
    identity = json.dumps(
        [run_id, turn_id, attempt_id, provider_tool_call_id, source_index],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"unobserved-{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:24]}"


class _TrajectoryReducer:
    def __init__(
        self,
        *,
        step_spool: TextIO,
        evidence: _ToolEvidenceWriter,
        model_name: str | None,
        reasoning_effort: str | float | None,
        argument_bytes: int,
        result_bytes: int,
    ) -> None:
        self._step_spool = step_spool
        self._evidence = evidence
        self._model_name = (
            sanitize_text(model_name) if isinstance(model_name, str) else None
        )
        self._reasoning_effort = sanitize_json(reasoning_effort)
        self._argument_bytes = argument_bytes
        self._result_bytes = result_bytes
        self._active_turn: _Turn | None = None
        self.session_id = "unknown"
        self.run_end_observed = False
        self.run_outcome: str | None = None
        self.event_count = 0
        self.non_monotonic_sequence_count = 0
        self._last_sequence: int | None = None
        self.step_count = 1
        self.tool_call_count = 0
        self.pending_tool_count = 0

    def consume(self, event: Mapping[str, Any], ordinal: int) -> None:
        self.event_count += 1
        sequence = _event_sequence(event, ordinal)
        if self._last_sequence is not None and sequence <= self._last_sequence:
            self.non_monotonic_sequence_count += 1
        self._last_sequence = sequence
        event_type = event.get("type")
        if event_type == "run_start":
            run_id = _value(event, "runId", "run_id")
            if isinstance(run_id, str) and run_id:
                self.session_id = sanitize_text(run_id)
            return
        if event_type == "turn_start":
            self._ensure_turn(
                _safe_string(_value(event, "turnId", "turn_id"), "unknown")
            )
            return
        if event_type == "attempt_end":
            self._consume_attempt(event, sequence)
            return
        if event_type in {
            "tool_execution_start",
            "tool_execution_end",
            "tool_execution_rejected",
        }:
            self._consume_tool(event, sequence)
            return
        if event_type == "turn_end":
            turn_id = _safe_string(_value(event, "turnId", "turn_id"), "unknown")
            if self._active_turn is not None and self._active_turn.turn_id == turn_id:
                self._flush_turn()
            return
        if event_type == "run_end":
            self.run_end_observed = True
            self.run_outcome = _safe_string(event.get("outcome")) or None
            self._flush_turn()

    def finish(self) -> None:
        self._flush_turn()

    def _ensure_turn(self, turn_id: str) -> _Turn:
        if self._active_turn is not None and self._active_turn.turn_id != turn_id:
            self._flush_turn()
        if self._active_turn is None:
            self._active_turn = _Turn(turn_id=turn_id)
        return self._active_turn

    def _consume_attempt(self, event: Mapping[str, Any], sequence: int) -> None:
        turn_id = _safe_string(_value(event, "turnId", "turn_id"), "unknown")
        turn = self._ensure_turn(turn_id)
        candidate = _record(event.get("candidate")) or {}
        message = _record(candidate.get("message")) or {}
        text, reasoning, calls = _message_parts(message.get("content"))
        turn.attempts.append(
            _Attempt(
                turn_id=turn_id,
                attempt_id=_safe_string(_value(event, "attemptId", "attempt_id"))
                or None,
                event_sequence=sequence,
                timestamp=_iso_timestamp(
                    _first_present(message.get("timestamp"), event.get("timestamp"))
                ),
                message=text,
                reasoning_content=reasoning,
                metrics=_usage_metrics(message),
                outcome=_safe_string(event.get("outcome")) or None,
                discarded=event.get("discarded") is True,
                calls=calls,
            )
        )

    def _consume_tool(self, event: Mapping[str, Any], sequence: int) -> None:
        invocation = _record(event.get("invocation")) or {}
        turn_id = _safe_string(
            _first_present(
                _value(event, "turnId", "turn_id"),
                _value(invocation, "turnId", "turn_id"),
            ),
            "unknown",
        )
        turn = self._ensure_turn(turn_id)
        invocation_id = _safe_string(
            _value(invocation, "id", "invocationId", "invocation_id")
        )
        if not invocation_id:
            invocation_id = _synthetic_tool_call_id(
                self.session_id,
                turn_id,
                None,
                _safe_string(
                    _value(invocation, "providerToolCallId", "provider_tool_call_id")
                ),
                int(_value(invocation, "sourceIndex", "source_index") or 0),
            )
        current = turn.invocations.get(invocation_id)
        if current is None:
            provider_id = _safe_string(
                _value(invocation, "providerToolCallId", "provider_tool_call_id"),
                invocation_id,
            )
            source_index_value = _value(invocation, "sourceIndex", "source_index")
            source_index = (
                source_index_value
                if isinstance(source_index_value, int) and source_index_value >= 0
                else 0
            )
            tool_name = _safe_string(
                _value(invocation, "toolName", "tool_name"), "unknown"
            )
            raw_arguments = _value(invocation, "arguments")
            call_evidence = self._evidence.write_item(
                tool_call_id=invocation_id,
                invocation_id=invocation_id,
                kind="call",
                value={
                    "event_type": "tool_call",
                    "run_id": self.session_id,
                    "turn_id": turn_id,
                    "event_sequence": sequence,
                    "invocation": invocation,
                },
                index={
                    "event_sequence": sequence,
                    "source_index": source_index,
                    "tool_name": tool_name,
                },
            )
            current = _Invocation(
                tool_call_id=invocation_id,
                invocation_id=invocation_id,
                provider_tool_call_id=provider_id,
                tool_name=tool_name,
                turn_id=turn_id,
                source_index=source_index,
                call_sequence=sequence,
                started=event.get("type") == "tool_execution_start",
                synthetic=False,
                arguments=_bounded_arguments(
                    raw_arguments if raw_arguments is not None else {},
                    self._argument_bytes,
                    call_evidence,
                ),
                call_evidence=call_evidence,
            )
            turn.invocations[invocation_id] = current
        elif event.get("type") == "tool_execution_start":
            current.started = True
            current.call_sequence = min(current.call_sequence, sequence)
        if event.get("type") not in {"tool_execution_end", "tool_execution_rejected"}:
            return
        terminal = _terminal_projection(event)
        result_evidence = self._evidence.write_item(
            tool_call_id=current.tool_call_id,
            invocation_id=current.invocation_id,
            kind="result",
            value={
                "event_type": event.get("type"),
                "run_id": self.session_id,
                "turn_id": turn_id,
                "event_sequence": sequence,
                "invocation": invocation,
                "settlement": terminal["settlement"],
                "outcome": terminal["outcome"],
                "rejection_reason": terminal["rejection_reason"],
                "result": terminal["result"],
            },
            index={
                "event_sequence": sequence,
                "source_index": current.source_index,
                "tool_name": current.tool_name,
                "terminal": True,
                "status": terminal["status"],
                "settlement": terminal["settlement"],
                "exit_code": terminal["exit_code"],
                "signal": terminal["signal"],
                "timed_out": terminal["timed_out"],
                "completeness": terminal["completeness"],
            },
        )
        current.terminal_sequence = sequence
        current.terminal_timestamp = _iso_timestamp(event.get("timestamp"))
        current.status = terminal["status"]
        current.settlement = terminal["settlement"]
        current.outcome = terminal["outcome"]
        current.rejection_reason = terminal["rejection_reason"]
        current.exit_code = terminal["exit_code"]
        current.signal = terminal["signal"]
        current.timed_out = terminal["timed_out"]
        current.truncated = terminal["truncated"]
        current.completeness = terminal["completeness"]
        current.output_ref = terminal["output_ref"]
        current.result_content = _bounded_text(
            _result_text(terminal["result"]),
            self._result_bytes,
            result_evidence,
        )
        current.result_evidence = result_evidence
        current.terminal = True

    def _unobserved_invocation(
        self, attempt: _Attempt, call: _CandidateCall
    ) -> _Invocation:
        tool_call_id = _synthetic_tool_call_id(
            self.session_id,
            attempt.turn_id,
            attempt.attempt_id,
            call.provider_tool_call_id,
            call.source_index,
        )
        call_evidence = self._evidence.write_item(
            tool_call_id=tool_call_id,
            invocation_id=None,
            kind="call",
            value={
                "event_type": "unobserved_tool_call",
                "run_id": self.session_id,
                "turn_id": attempt.turn_id,
                "attempt_id": attempt.attempt_id,
                "event_sequence": attempt.event_sequence,
                "provider_tool_call_id": call.provider_tool_call_id,
                "tool_name": call.tool_name,
                "source_index": call.source_index,
                "arguments": call.arguments,
            },
            index={
                "event_sequence": attempt.event_sequence,
                "source_index": call.source_index,
                "tool_name": call.tool_name,
                "lifecycle_observed": False,
            },
        )
        return _Invocation(
            tool_call_id=tool_call_id,
            invocation_id=None,
            provider_tool_call_id=call.provider_tool_call_id,
            tool_name=call.tool_name,
            turn_id=attempt.turn_id,
            source_index=call.source_index,
            call_sequence=attempt.event_sequence,
            started=False,
            synthetic=True,
            arguments=_bounded_arguments(
                call.arguments, self._argument_bytes, call_evidence
            ),
            call_evidence=call_evidence,
            completeness="missing-lifecycle",
        )

    def _ensure_pending_result(self, invocation: _Invocation) -> None:
        if invocation.result_evidence is not None:
            return
        descriptor = self._evidence.write_item(
            tool_call_id=invocation.tool_call_id,
            invocation_id=invocation.invocation_id,
            kind="result",
            value={
                "event_type": "pending_tool_result",
                "run_id": self.session_id,
                "turn_id": invocation.turn_id,
                "invocation_id": invocation.invocation_id,
                "provider_tool_call_id": invocation.provider_tool_call_id,
                "tool_name": invocation.tool_name,
                "source_index": invocation.source_index,
                "terminal": False,
                "status": "pending",
                "settlement": None,
                "completeness": invocation.completeness,
            },
            index={
                "event_sequence": None,
                "source_index": invocation.source_index,
                "tool_name": invocation.tool_name,
                "terminal": False,
                "status": "pending",
                "settlement": None,
                "completeness": invocation.completeness,
            },
        )
        invocation.result_evidence = descriptor
        invocation.result_content = (
            "[Tool result was not observed before the event stream ended]"
        )

    def _flush_turn(self) -> None:
        turn = self._active_turn
        if turn is None:
            return
        self._active_turn = None
        attempts = sorted(turn.attempts, key=lambda attempt: attempt.event_sequence)
        lifecycle = list(turn.invocations.values())
        assigned: set[str] = set()
        bindings: list[list[_Invocation]] = [[] for _ in attempts]
        by_provider: dict[str, list[_Invocation]] = {}
        for invocation in lifecycle:
            by_provider.setdefault(invocation.provider_tool_call_id, []).append(
                invocation
            )
        for candidates in by_provider.values():
            candidates.sort(
                key=lambda item: (
                    item.source_index,
                    item.call_sequence,
                    item.tool_call_id,
                )
            )
        for attempt_index, attempt in enumerate(attempts):
            for call in attempt.calls:
                candidates = [
                    item
                    for item in by_provider.get(call.provider_tool_call_id, [])
                    if item.tool_call_id not in assigned
                ]
                invocation = next(
                    (
                        item
                        for item in candidates
                        if item.source_index == call.source_index
                    ),
                    candidates[0] if candidates else None,
                )
                if invocation is None:
                    invocation = self._unobserved_invocation(attempt, call)
                else:
                    assigned.add(invocation.tool_call_id)
                bindings[attempt_index].append(invocation)
        orphaned = [item for item in lifecycle if item.tool_call_id not in assigned]
        if orphaned:
            orphaned.sort(
                key=lambda item: (
                    item.source_index,
                    item.call_sequence,
                    item.tool_call_id,
                )
            )
            if not attempts:
                attempts.append(
                    _Attempt(
                        turn_id=turn.turn_id,
                        attempt_id=None,
                        event_sequence=min(item.call_sequence for item in orphaned),
                        timestamp=None,
                        message="",
                        reasoning_content=None,
                        metrics={},
                        outcome=None,
                        discarded=False,
                        calls=[],
                        llm_call_count=0,
                    )
                )
                bindings.append([])
            target = next(
                (
                    index
                    for index in range(len(attempts) - 1, -1, -1)
                    if not attempts[index].discarded
                ),
                len(attempts) - 1,
            )
            bindings[target].extend(orphaned)
        for attempt, invocation_bindings in zip(attempts, bindings, strict=True):
            invocation_bindings.sort(
                key=lambda item: (
                    item.source_index,
                    item.call_sequence,
                    item.tool_call_id,
                )
            )
            for invocation in invocation_bindings:
                self._ensure_pending_result(invocation)
            self._write_attempt_step(attempt, invocation_bindings)

    def _write_attempt_step(
        self, attempt: _Attempt, invocations: list[_Invocation]
    ) -> None:
        self.step_count += 1
        step: dict[str, Any] = {
            "step_id": self.step_count,
            "source": "agent",
            "message": attempt.message,
            "llm_call_count": attempt.llm_call_count,
            "extra": {
                "turn_id": attempt.turn_id,
                "attempt_id": attempt.attempt_id,
                "event_sequence": attempt.event_sequence,
                "outcome": attempt.outcome,
                "discarded": attempt.discarded,
            },
        }
        if attempt.timestamp is not None:
            step["timestamp"] = attempt.timestamp
        if self._model_name is not None:
            step["model_name"] = self._model_name
        if attempt.llm_call_count > 0:
            if self._reasoning_effort is not None:
                step["reasoning_effort"] = self._reasoning_effort
            if attempt.reasoning_content:
                step["reasoning_content"] = attempt.reasoning_content
            step["metrics"] = attempt.metrics
        if invocations:
            self.tool_call_count += len(invocations)
            step["tool_calls"] = [self._atif_tool_call(item) for item in invocations]
            results = sorted(
                invocations,
                key=lambda item: (
                    item.terminal_sequence is None,
                    item.terminal_sequence
                    if item.terminal_sequence is not None
                    else item.call_sequence,
                    item.source_index,
                ),
            )
            step["observation"] = {
                "results": [self._atif_result(item) for item in results]
            }
        self._step_spool.write(
            json.dumps(
                step,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            )
            + "\n"
        )

    @staticmethod
    def _atif_tool_call(invocation: _Invocation) -> dict[str, Any]:
        return {
            "tool_call_id": invocation.tool_call_id,
            "function_name": invocation.tool_name,
            "arguments": invocation.arguments,
            "extra": {
                "invocation_id": invocation.invocation_id,
                "provider_tool_call_id": invocation.provider_tool_call_id,
                "turn_id": invocation.turn_id,
                "source_index": invocation.source_index,
                "event_sequence": invocation.call_sequence,
                "started": invocation.started,
                "synthetic_tool_call_id": invocation.synthetic,
                **invocation.call_evidence.atif_fields(),
            },
        }

    def _atif_result(self, invocation: _Invocation) -> dict[str, Any]:
        if not invocation.terminal:
            self.pending_tool_count += 1
        descriptor = invocation.result_evidence
        if descriptor is None:
            raise RuntimeError("Tool result evidence was not finalized")
        return {
            "source_call_id": invocation.tool_call_id,
            "content": invocation.result_content,
            "extra": {
                "invocation_id": invocation.invocation_id,
                "tool_name": invocation.tool_name,
                "turn_id": invocation.turn_id,
                "source_index": invocation.source_index,
                "start_sequence": invocation.call_sequence
                if invocation.started
                else None,
                "terminal_sequence": invocation.terminal_sequence,
                "terminal_timestamp": invocation.terminal_timestamp,
                "terminal": invocation.terminal,
                "status": invocation.status,
                "settlement": invocation.settlement,
                "outcome": invocation.outcome,
                "rejection_reason": invocation.rejection_reason,
                "exit_code": invocation.exit_code,
                "signal": invocation.signal,
                "timed_out": invocation.timed_out,
                "truncated": invocation.truncated,
                "completeness": invocation.completeness,
                "output_ref": invocation.output_ref,
                **descriptor.atif_fields(),
            },
        }


def _iter_jsonl_events(
    path: Path, diagnostics: _ReadDiagnostics
) -> Iterator[Mapping[str, Any]]:
    if not path.exists():
        return
    with path.open(encoding="utf-8", errors="replace") as stream:
        for line in stream:
            diagnostics.line_count += 1
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                diagnostics.parse_error_count += 1
                continue
            if isinstance(value, Mapping):
                yield value
            else:
                diagnostics.parse_error_count += 1


def _normalize_final_metrics(
    value: Mapping[str, Any] | None, step_count: int
) -> dict[str, Any]:
    source = value or {}
    result: dict[str, Any] = {"total_steps": step_count}
    for name in (
        "total_prompt_tokens",
        "total_completion_tokens",
        "total_cached_tokens",
        "total_cost_usd",
        "extra",
    ):
        if name in source:
            result[name] = sanitize_json(source[name])
    return result


def _write_trajectory_file(
    *,
    path: Path,
    step_spool_path: Path,
    session_id: str,
    agent: Mapping[str, Any],
    final_metrics: Mapping[str, Any],
    notes: str | None,
    extra: Mapping[str, Any],
) -> None:
    # Kept open while the root object is assembled from the on-disk step spool.
    temporary = tempfile.NamedTemporaryFile(  # noqa: SIM115
        mode="w",
        encoding="utf-8",
        newline="\n",
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
        delete=False,
    )
    temporary_path = Path(temporary.name)
    try:
        temporary.write("{")
        temporary.write(f'"schema_version":{json.dumps(ATIF_SCHEMA_VERSION)},')
        temporary.write(f'"session_id":{json.dumps(session_id, ensure_ascii=False)},')
        temporary.write(
            f'"agent":{json.dumps(agent, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)},'
        )
        temporary.write('"steps":[')
        first = True
        with step_spool_path.open(encoding="utf-8") as step_spool:
            for line in step_spool:
                if not first:
                    temporary.write(",")
                temporary.write(line.rstrip("\n"))
                first = False
        temporary.write("]")
        if notes is not None:
            temporary.write(f',"notes":{json.dumps(notes, ensure_ascii=False)}')
        temporary.write(
            f',"final_metrics":{json.dumps(final_metrics, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)}'
        )
        temporary.write(
            f',"extra":{json.dumps(extra, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)}'
        )
        temporary.write("}\n")
        temporary.flush()
        os.fsync(temporary.fileno())
        temporary.close()
        os.replace(temporary_path, path)
    except BaseException:
        temporary.close()
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass
        raise


def write_coda_trajectory(
    event_source: str | os.PathLike[str] | Iterable[Mapping[str, Any]],
    output_dir: str | Path,
    *,
    instruction: str,
    agent_version: str,
    model_name: str | None,
    reasoning_effort: str | float | None,
    agent_extra: Mapping[str, Any] | None = None,
    final_metrics: Mapping[str, Any] | None = None,
    evidence_page_bytes: int = DEFAULT_EVIDENCE_PAGE_BYTES,
    atif_argument_bytes: int = DEFAULT_ATIF_ARGUMENT_BYTES,
    atif_result_bytes: int = DEFAULT_ATIF_RESULT_BYTES,
    source_line_count: int | None = None,
    source_parse_error_count: int = 0,
    source_scan_complete: bool = True,
) -> TrajectoryArtifactSummary:
    """Generate `trajectory.json` and `tool-evidence.jsonl` from Coda JSONL.

    A path is scanned as JSONL. The Pier artifact finalizer may instead pass its
    already bounded terminal-event iterable plus source diagnostics, avoiding a
    second scan inside the finalization deadline. Both forms remain valid when
    the source stream has no `run_end` or a truncated final JSON line.
    """

    if atif_argument_bytes < 256 or atif_result_bytes < 256:
        raise ValueError("ATIF Tool previews must be at least 256 bytes")
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    trajectory_path = output_dir / "trajectory.json"
    evidence_path = output_dir / "tool-evidence.jsonl"
    source_is_path = isinstance(event_source, (str, os.PathLike))
    if source_is_path:
        diagnostics = _ReadDiagnostics()
        events: Iterable[Mapping[str, Any]] = _iter_jsonl_events(
            Path(event_source), diagnostics
        )
    else:
        diagnostics = _ReadDiagnostics(
            line_count=max(0, source_line_count or 0),
            parse_error_count=max(0, source_parse_error_count),
        )

    if not source_is_path and source_line_count is None:

        def counted_events() -> Iterator[Mapping[str, Any]]:
            for event in event_source:
                diagnostics.line_count += 1
                yield event

        events = counted_events()
    elif not source_is_path:
        events = event_source
    # The reducer incrementally appends steps and closes this handle before assembly.
    step_spool = tempfile.NamedTemporaryFile(  # noqa: SIM115
        mode="w",
        encoding="utf-8",
        newline="\n",
        prefix=".coda-trajectory-steps.",
        suffix=".jsonl",
        dir=output_dir,
        delete=False,
    )
    step_spool_path = Path(step_spool.name)
    evidence = _ToolEvidenceWriter(evidence_path, evidence_page_bytes)
    try:
        user_step = {
            "step_id": 1,
            "source": "user",
            "message": sanitize_text(instruction),
        }
        step_spool.write(
            json.dumps(
                user_step,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            )
            + "\n"
        )
        reducer = _TrajectoryReducer(
            step_spool=step_spool,
            evidence=evidence,
            model_name=model_name,
            reasoning_effort=reasoning_effort,
            argument_bytes=atif_argument_bytes,
            result_bytes=atif_result_bytes,
        )
        for ordinal, event in enumerate(events, start=1):
            reducer.consume(event, ordinal)
        reducer.finish()
        step_spool.flush()
        os.fsync(step_spool.fileno())
        step_spool.close()
        complete = (
            reducer.run_end_observed
            and reducer.pending_tool_count == 0
            and diagnostics.parse_error_count == 0
            and reducer.non_monotonic_sequence_count == 0
            and source_scan_complete
        )
        evidence_sha256 = evidence.finalize(
            complete=complete,
            pending_tool_count=reducer.pending_tool_count,
        )
        safe_agent_extra = sanitize_json(agent_extra or {})
        agent: dict[str, Any] = {
            "name": "coda",
            "version": sanitize_text(agent_version or "unknown"),
            "extra": safe_agent_extra if isinstance(safe_agent_extra, dict) else {},
        }
        if model_name is not None:
            agent["model_name"] = sanitize_text(model_name)
        lifecycle_status = "complete" if complete else "partial"
        notes = None
        if not complete:
            notes = (
                "Partial Coda trajectory: the event stream did not contain a complete, "
                "monotonic Run lifecycle; all observed terminal Tool records and explicitly "
                "pending Tool calls are retained."
            )
        root_extra = {
            "coda": {
                "projection_schema_version": TRAJECTORY_PROJECTION_VERSION,
                "lifecycle": {
                    "status": lifecycle_status,
                    "run_end_observed": reducer.run_end_observed,
                    "run_outcome": reducer.run_outcome,
                    "event_count": reducer.event_count,
                    "jsonl_line_count": diagnostics.line_count,
                    "parse_error_count": diagnostics.parse_error_count,
                    "event_scan_complete": source_scan_complete,
                    "non_monotonic_sequence_count": reducer.non_monotonic_sequence_count,
                    "pending_tool_count": reducer.pending_tool_count,
                },
                "tool_evidence": {
                    "schema_version": TOOL_EVIDENCE_SCHEMA_VERSION,
                    "path": evidence_path.name,
                    "sha256": evidence_sha256,
                    "page_bytes": evidence_page_bytes,
                    "item_count": evidence.item_count,
                    "tool_call_count": reducer.tool_call_count,
                    "terminal_tool_count": evidence.terminal_tool_count,
                    "pending_tool_count": reducer.pending_tool_count,
                },
            }
        }
        _write_trajectory_file(
            path=trajectory_path,
            step_spool_path=step_spool_path,
            session_id=reducer.session_id,
            agent=agent,
            final_metrics=_normalize_final_metrics(final_metrics, reducer.step_count),
            notes=notes,
            extra=root_extra,
        )
        return TrajectoryArtifactSummary(
            trajectory_path=trajectory_path,
            tool_evidence_path=evidence_path,
            session_id=reducer.session_id,
            complete=complete,
            step_count=reducer.step_count,
            tool_call_count=reducer.tool_call_count,
            terminal_tool_count=evidence.terminal_tool_count,
            pending_tool_count=reducer.pending_tool_count,
            event_count=reducer.event_count,
            parse_error_count=diagnostics.parse_error_count,
            evidence_sha256=evidence_sha256,
        )
    except BaseException:
        if not step_spool.closed:
            step_spool.close()
        evidence.abort()
        raise
    finally:
        try:
            step_spool_path.unlink()
        except FileNotFoundError:
            pass
