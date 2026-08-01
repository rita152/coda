import { strictJsonSnapshot } from '../protocol/index.js';
import type { Context, ModelRef, ToolSchema } from '../protocol/index.js';
import type {
  PromptAssembler,
  PromptAssemblyInput,
  PromptAssemblyResult,
  TurnPolicyContext,
} from './types.js';

const TOOL_NOTES_HEADER = '# Tool usage notes';
const PROJECT_RULES_HEADER =
  '# Project rules\n\n' +
  'These repository instructions are ordered from broader to narrower scope. ' +
  'When instructions conflict, the later, narrower scope takes precedence.';

export function createPromptAssembler(): PromptAssembler {
  return Object.freeze({
    assemble(input: PromptAssemblyInput): PromptAssemblyResult {
      try {
        const policyContext = input.effectivePolicy.context;
        if (!sameTurnContext(input.basePrompt.owner, policyContext)) {
          return invalidContext('Base prompt owner does not match effective policy context');
        }
        if (!sameTurnContext(input.effectivePolicy.rules.owner, policyContext)) {
          return invalidContext('Rule snapshot owner does not match effective policy context');
        }
        if (!sameModelRef(input.basePrompt.model, input.model.ref)) {
          return invalidContext('Base prompt model does not match prompt model');
        }

        if (!Array.isArray(input.outboundMessages)) {
          return invalidInput('outboundMessages must be an array');
        }
        if (!Array.isArray(input.catalog.entries)) {
          return invalidInput('catalog.entries must be an array');
        }

        const names = new Set<string>();
        const tools: ToolSchema[] = [];
        const snippets: string[] = [];
        for (const entry of input.catalog.entries) {
          if (typeof entry.id !== 'string' || entry.id.length === 0) {
            return invalidInput('catalog entry id must be a non-empty string');
          }
          if (names.has(entry.id)) {
            return invalidInput(`catalog contains duplicate capability id ${JSON.stringify(entry.id)}`);
          }
          names.add(entry.id);
          if (typeof entry.description !== 'string') {
            return invalidInput(`catalog entry ${JSON.stringify(entry.id)} has an invalid description`);
          }
          if (!isRecord(entry.inputSchema)) {
            return invalidInput(`catalog entry ${JSON.stringify(entry.id)} has an invalid input schema`);
          }
          tools.push({
            name: entry.id,
            description: entry.description,
            parameters: entry.inputSchema,
          });
          if (entry.promptSnippet !== undefined) {
            if (typeof entry.promptSnippet !== 'string') {
              return invalidInput(`catalog entry ${JSON.stringify(entry.id)} has an invalid prompt snippet`);
            }
            if (entry.promptSnippet.length > 0) snippets.push(entry.promptSnippet);
          }
        }

        let systemPrompt = input.basePrompt.content;
        if (typeof systemPrompt !== 'string') {
          return invalidInput('base prompt content must be a string');
        }
        if (snippets.length > 0) {
          systemPrompt += `\n\n${TOOL_NOTES_HEADER}\n\n${snippets.join('\n\n')}`;
        }

        const rules = input.effectivePolicy.rules.files;
        if (!Array.isArray(rules)) return invalidInput('rule snapshot files must be an array');
        if (rules.length > 0) {
          const blocks = rules.map((rule, index) => renderRule(rule, index));
          systemPrompt += `\n\n${PROJECT_RULES_HEADER}\n\n${blocks.join('\n\n')}`;
        }

        const context = strictJsonSnapshot({
          systemPrompt,
          messages: input.outboundMessages,
          tools,
        }) as unknown as Readonly<Context>;
        return Object.freeze({ ok: true, context });
      } catch (error) {
        return invalidInput(`Prompt input is not strict JSON: ${formatError(error)}`);
      }
    },
  });
}

function renderRule(
  rule: {
    readonly path: string;
    readonly scope: string;
    readonly content: string;
  },
  index: number,
): string {
  if (typeof rule.path !== 'string' || typeof rule.scope !== 'string' || typeof rule.content !== 'string') {
    throw new TypeError(`rules.files[${index}] must contain string path, scope, and content fields`);
  }
  return (
    `<project_rule source="${xmlAttribute(rule.path)}" scope="${xmlAttribute(rule.scope)}">\n` +
    `${rule.content.trimEnd()}\n` +
    '</project_rule>'
  );
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function sameTurnContext(
  left: Readonly<TurnPolicyContext>,
  right: Readonly<TurnPolicyContext>,
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.turnId === right.turnId &&
    left.cwd === right.cwd
  );
}

function sameModelRef(left: Readonly<ModelRef>, right: Readonly<ModelRef>): boolean {
  return left.provider === right.provider && left.api === right.api && left.model === right.model;
}

function invalidContext(message: string): PromptAssemblyResult {
  return Object.freeze({ ok: false, code: 'invalid_prompt_context', message });
}

function invalidInput(message: string): PromptAssemblyResult {
  return Object.freeze({ ok: false, code: 'invalid_prompt_input', message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
