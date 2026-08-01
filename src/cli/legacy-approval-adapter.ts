// CLI-owned static phase-2 policy adapter. It computes allow/deny/ask proposals and applies
// durable legacy pattern effects, but never emits events or owns an approval waiter.

import path from 'node:path';
import type { ToolCallPart } from '../protocol/index.js';
import { strictJsonSnapshot } from '../protocol/index.js';
import {
  canonicalizePath,
  isPathInside,
  resolveToolWorkdir,
} from '../shared/index.js';
import type { ToolDefinition } from '../tools/types.js';
import type {
  LegacyApprovalAdapter,
  LegacyApprovalAdapterFactory,
  LegacyApprovalApplyResult,
  LegacyApprovalPreflightResult,
} from '../runtime/index.js';
import { analyzeBashCommand, analyzeBashPaths } from './bash-analyze.js';
import {
  DOOM_LOOP_NOTE,
  DOOM_LOOP_THRESHOLD,
  stableStringify,
} from './approval-policy.js';

export type StaticLegacyApprovalMode = 'interactive' | 'allow' | 'deny';

export interface StaticLegacyApprovalAdapterFactoryOptions {
  readonly mode: StaticLegacyApprovalMode;
  readonly projectRoot: string;
  readonly tools: readonly ToolDefinition[];
}

/** Creates one immutable factory; each opened adapter gets isolated doom-loop state. */
export function createStaticLegacyApprovalAdapterFactory(
  options: StaticLegacyApprovalAdapterFactoryOptions,
): LegacyApprovalAdapterFactory {
  const projectRoot = path.resolve(options.projectRoot);
  const projectRootReal = canonicalizePath(projectRoot);
  const kinds = new Map(options.tools.map((tool) => [tool.name, tool.kind ?? 'execute']));

  return {
    async open(input): Promise<LegacyApprovalAdapter> {
      if (input.patterns.workspaceId !== input.workspaceId) {
        throw new Error('Legacy approval repository workspace mismatch');
      }
      let closed = false;
      let lastHash: string | undefined;
      let repeatCount = 0;

      const assertOpen = (): void => {
        if (closed) throw new Error('Legacy approval adapter is closed');
      };
      const isInsideRoot = (candidate: string): boolean => {
        try {
          return isPathInside(
            projectRootReal,
            canonicalizePath(path.resolve(projectRoot, candidate)),
          );
        } catch {
          return false;
        }
      };
      const ask = async (
        description: string,
        patterns: readonly string[],
        forceConfirm: boolean,
      ): Promise<LegacyApprovalPreflightResult> => {
        const normalized = [...new Set(patterns)].sort();
        if (!forceConfirm && normalized.length > 0) {
          const stored = new Set((await input.patterns.snapshot()).patterns);
          if (normalized.every((pattern) => stored.has(pattern))) return { kind: 'allow' };
        }
        return snapshot({
          kind: 'ask',
          description,
          proposal: { patterns: normalized, forceConfirm },
        });
      };

      return {
        async preflight(request): Promise<LegacyApprovalPreflightResult> {
          assertOpen();
          if (request.context.workspaceId !== input.workspaceId
            || request.context.threadId !== input.threadId) {
            return { kind: 'deny', reason: 'Legacy approval identity mismatch' };
          }
          if (options.mode === 'allow') return { kind: 'allow' };

          if (!isRecord(request.args)) {
            return { kind: 'deny', reason: 'Legacy tool arguments must be an object' };
          }
          const call: ToolCallPart = snapshot({
            type: 'tool_call',
            id: request.context.toolCallId,
            name: request.context.toolName,
            arguments: request.args,
          });
          const hash = call.name + stableStringify(call.arguments);
          if (hash === lastHash) repeatCount += 1;
          else {
            lastHash = hash;
            repeatCount = 1;
          }
          const doomLoop = repeatCount >= DOOM_LOOP_THRESHOLD;
          const withLoopNote = (description: string): string =>
            doomLoop ? `${description}\n${DOOM_LOOP_NOTE}` : description;
          const kind = kinds.get(call.name) ?? 'execute';
          if (!doomLoop && (kind === 'read' || kind === 'search' || kind === 'plan')) {
            return { kind: 'allow' };
          }
          if (options.mode === 'deny') {
            return {
              kind: 'deny',
              reason:
                `Tool "${call.name}" requires approval, but approvals are disabled ` +
                '(--approval-mode deny). Use read-only tools, or ask the user to rerun without deny mode.',
            };
          }

          if (call.name === 'bash') {
            const args = call.arguments as { command?: unknown; workdir?: unknown; description?: unknown };
            const command = typeof args.command === 'string' ? args.command : String(args.command ?? '');
            const analysis = analyzeBashCommand(command);
            if (analysis.denied) return { kind: 'deny', reason: deniedReason(analysis.reason) };
            const workdir = typeof args.workdir === 'string'
              ? resolveToolWorkdir(projectRoot, args.workdir)
              : projectRoot;
            const pathAnalysis = analyzeBashPaths(
              command,
              projectRoot,
              typeof args.workdir === 'string' ? args.workdir : undefined,
            );
            const external = !isInsideRoot(workdir)
              || pathAnalysis.targets.some((target) => !isInsideRoot(target.path));
            const modelNote = typeof args.description === 'string' && args.description !== ''
              ? ` — ${args.description}`
              : '';
            return ask(
              withLoopNote(
                `bash: ${command}${modelNote}` +
                `${external ? ' (accesses paths outside project root)' : ''}` +
                `${pathAnalysis.complete ? '' : ' (contains paths that could not be fully analyzed)'}`,
              ),
              analysis.patterns,
              analysis.forceConfirm || !pathAnalysis.complete || external || doomLoop,
            );
          }

          if (kind === 'edit') {
            const rawPath = (call.arguments as { path?: unknown }).path;
            const target = typeof rawPath === 'string' ? path.resolve(projectRoot, rawPath) : undefined;
            const inside = target !== undefined && isInsideRoot(target);
            return ask(
              withLoopNote(
                `${call.name} ${target ?? stableStringify(call.arguments)}` +
                `${inside ? '' : ' (outside project root)'}`,
              ),
              [`${call.name}:${projectRoot}/**`],
              !inside || doomLoop,
            );
          }

          return ask(
            withLoopNote(`${call.name} ${stableStringify(call.arguments)}`),
            [],
            doomLoop,
          );
        },

        async applyResponse(request): Promise<LegacyApprovalApplyResult> {
          assertOpen();
          if (request.request.workspaceId !== input.workspaceId
            || request.request.threadId !== input.threadId) {
            return {
              ok: false,
              code: 'legacy_approval_conflict',
              message: 'Legacy approval request identity mismatch',
            };
          }
          if (request.decision !== 'allow_always') {
            return {
              ok: true,
              effectiveDecision: request.decision,
              persistedPatterns: [],
            };
          }
          const patterns = [...new Set(request.request.proposal.patterns)].sort();
          if (request.request.proposal.forceConfirm || patterns.length === 0) {
            return {
              ok: true,
              effectiveDecision: 'allow_once',
              persistedPatterns: [],
            };
          }
          const result = await input.patterns.commit({
            responseOpId: request.responseOpId,
            acceptedAt: request.acceptedAt,
            patterns: patterns as [string, ...string[]],
          });
          switch (result.kind) {
            case 'applied':
            case 'duplicate':
              return {
                ok: true,
                effectiveDecision: 'allow_always',
                persistedPatterns: patterns,
              };
            case 'definitely_not_applied':
              return {
                ok: false,
                code: 'legacy_approval_definitely_not_applied',
                message: result.message,
              };
            case 'conflict':
              return {
                ok: false,
                code: 'legacy_approval_conflict',
                message: result.message,
              };
            case 'fenced':
              return {
                ok: false,
                code: 'legacy_approval_fenced',
                message: result.message,
              };
          }
        },

        async close(): Promise<void> {
          closed = true;
        },
      };
    },
  };
}

function deniedReason(detail: string): string {
  return `User denied permission: ${detail}. Do not retry the same call; ask the user or take a different approach.`;
}

function snapshot<T>(value: T): T {
  return strictJsonSnapshot(value) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
