import type {
  ApprovalPresentation,
  RuntimeReviewSnapshot,
  RuntimeThreadListItem,
  WorkspaceRuntimeSnapshot,
} from '../protocol/index.js';
import { sanitizeTerminalText } from './terminal-sanitize.js';

export function filterSessionItems(
  items: readonly RuntimeThreadListItem[],
  query: string,
): readonly RuntimeThreadListItem[] {
  const terms = query.toLocaleLowerCase('en-US').split(/\s+/u).filter(Boolean);
  return [...items]
    .filter((item) => {
      const haystack = [
        item.thread.threadId,
        item.thread.title,
        item.thread.state,
        item.thread.archivedAt === undefined ? 'active' : 'archived',
        item.workspaceId,
        item.cwd,
        item.preview,
        new Date(item.updatedAt).toISOString(),
      ].filter((value): value is string => value !== undefined)
        .join('\n')
        .toLocaleLowerCase('en-US');
      return terms.every((term) => haystack.includes(term));
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function formatReviewSnapshot(snapshot: RuntimeReviewSnapshot): readonly string[] {
  const lines: string[] = [
    `Review · ${snapshot.reasoning.length} reasoning block(s) · ${snapshot.tools.length} tool call(s)`,
  ];
  for (const item of snapshot.reasoning) {
    lines.push(
      `reasoning · ${item.status} · ${duration(item.durationMs)}`,
      item.content === '' ? '  (empty)' : indent(item.content),
    );
  }
  for (const tool of snapshot.tools) {
    lines.push(
      `tool ${tool.name}${tool.target === undefined ? '' : ` · ${tool.target}`} · ` +
        `${tool.status} · ${duration(tool.durationMs)}`,
      `  arguments: ${safeJson(tool.args)}`,
    );
    if (tool.summary !== undefined) lines.push(`  summary: ${tool.summary}`);
    if (tool.output !== '') lines.push(indent(tool.output));
    if (tool.result !== undefined) lines.push(`  result: ${safeJson(tool.result)}`);
  }
  return lines.map(sanitizeTerminalText);
}

export function formatPermissionSnapshot(snapshot: WorkspaceRuntimeSnapshot): readonly string[] {
  const { permissions } = snapshot;
  return [
    `Permissions · ${permissions.mode}`,
    `policy revision: ${permissions.policyRevision}`,
    `ceiling revision: ${permissions.ceiling.revision}`,
    `constraints: ${permissions.ceiling.constraints.length === 0
      ? '(none)'
      : safeJson(permissions.ceiling.constraints)}`,
  ].map(sanitizeTerminalText);
}

export function formatApprovalPresentation(
  presentation: Readonly<ApprovalPresentation>,
): readonly string[] {
  return [
    `? approval · ${presentation.capability.id}@${presentation.capability.version}`,
    `target: ${presentation.normalizedResources.length === 0
      ? '(no resources)'
      : safeJson(presentation.normalizedResources)}`,
    `risk: ${presentation.risk.description}`,
    `allow once: invocation ${presentation.allowOnce.invocationId} · tool ${presentation.allowOnce.toolCallId}`,
    ...(presentation.allowAlways === undefined
      ? []
      : [`allow always scope: ${safeJson(presentation.allowAlways)}`]),
    `policy ${presentation.revisions.effectivePolicy} · basis ${presentation.revisions.policyBasis} · ` +
      `catalog ${presentation.revisions.catalog} · grants ${presentation.revisions.grants}`,
    presentation.allowAlways === undefined
      ? 'y allow once · n deny · Esc abort'
      : 'y allow once · a allow always · n deny · Esc abort',
  ].map(sanitizeTerminalText);
}

export function approvalAllowsAlways(
  presentation: Readonly<ApprovalPresentation>,
): boolean {
  return presentation.allowAlways !== undefined;
}

function duration(value: number | undefined): string {
  if (value === undefined) return 'in progress';
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function indent(value: string): string {
  return value.split('\n').map((line) => `  ${line}`).join('\n');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}
