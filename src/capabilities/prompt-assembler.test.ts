import { describe, expect, it } from 'bun:test';
import type {
  AgentMessage,
  JSONSchema,
  ModelRef,
  RunId,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import { createPromptAssembler } from './prompt-assembler.js';
import type {
  CapabilityCatalogEntry,
  EffectivePolicySnapshot,
  PromptAssemblyInput,
  RuleSnapshot,
  ToolCatalogSnapshot,
  TurnPolicyContext,
} from './types.js';

const WORKSPACE_ID = 'ws_test' as WorkspaceId;
const THREAD_ID = 'th_test' as ThreadId;
const RUN_ID = 'run_test' as RunId;
const TURN_ID = 'turn_test' as TurnId;

function owner(overrides: Partial<TurnPolicyContext> = {}): TurnPolicyContext {
  return {
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    cwd: '/repo',
    ...overrides,
  };
}

function ruleSnapshot(
  context: TurnPolicyContext = owner(),
  files: RuleSnapshot['files'] = [],
): RuleSnapshot {
  return {
    revision: 'rules-v1',
    owner: context,
    discovery: {
      knownResourceScopes: ['/repo'],
      budget: { maxFiles: 8, maxFileBytes: 32_768, maxBytes: 65_536, maxPromptTokens: 16_384 },
      diagnostics: [],
    },
    files,
  };
}

function effectivePolicy(rules: RuleSnapshot = ruleSnapshot()): EffectivePolicySnapshot {
  return {
    context: owner(),
    revision: 'policy-v1',
    policyBasisRevision: 'basis-v1',
    ceilingRevision: 'ceiling-v1',
    grantRevision: 'grant-v1',
    constraints: [],
    rules,
  };
}

function entry(input: {
  id: string;
  description?: string;
  schema?: JSONSchema;
  promptSnippet?: string;
}): CapabilityCatalogEntry {
  return {
    id: input.id,
    version: '1',
    implementationDigest: `impl_sha256_${'0'.repeat(64)}`,
    registrationDigest: `capreg_v1_${'1'.repeat(64)}`,
    description: input.description ?? `${input.id} description`,
    inputSchema: input.schema ?? { type: 'object' },
    ...(input.promptSnippet !== undefined && { promptSnippet: input.promptSnippet }),
    executionMode: 'parallel',
    metadata: {},
    policy: { kind: 'plan', resources: [] },
    validate: (value) => ({ ok: true, value }),
    resolveResources: async () => ({ ok: true, resources: [] }),
    execute: async () => ({ content: [] }),
  };
}

function catalog(entries: readonly CapabilityCatalogEntry[]): ToolCatalogSnapshot {
  const index = new Map(entries.map((candidate) => [candidate.id, candidate]));
  return {
    revision: 1,
    entries,
    resolve: (id) => index.get(id),
    prepare: async () => ({ ok: false, code: 'unknown_capability', message: 'unused' }),
  };
}

function input(overrides: Partial<PromptAssemblyInput> = {}): PromptAssemblyInput {
  const model = { provider: 'openai', api: 'openai-chat', model: 'gpt-test' } satisfies ModelRef;
  return {
    basePrompt: { owner: owner(), model, revision: 'base-v1', content: 'BASE' },
    outboundMessages: [
      {
        role: 'user',
        id: 'u_1',
        timestamp: 1,
        content: [{ type: 'text', text: 'hello' }],
        source: 'prompt',
      },
    ],
    effectivePolicy: effectivePolicy(),
    model: { ref: model, limits: { context: 10_000, output: 1_000 } },
    catalog: catalog([]),
    ...overrides,
  };
}

describe('PromptAssembler', () => {
  it('assembles base, stable catalog snippets, and root-to-narrow rules into a detached frozen Context', () => {
    const schema: JSONSchema = { type: 'object', properties: { path: { type: 'string' } } };
    const messages: AgentMessage[] = [
      {
        role: 'user',
        id: 'u_1',
        timestamp: 1,
        content: [{ type: 'text', text: 'hello' }],
        source: 'prompt',
      },
    ];
    const files: RuleSnapshot['files'] = [
      {
        path: '/repo/A&GENTS.md',
        scope: '/repo/**',
        contentDigest: 'sha-root',
        content: 'ROOT_RULE\n',
      },
      {
        path: '/repo/pkg/"AGENTS".md',
        scope: '/repo/pkg/<app>/**',
        contentDigest: 'sha-child',
        content: 'CHILD_RULE',
      },
    ];
    const result = createPromptAssembler().assemble(input({
      outboundMessages: messages,
      effectivePolicy: effectivePolicy(ruleSnapshot(owner(), files)),
      catalog: catalog([
        entry({ id: 'read', schema, promptSnippet: 'Read before editing.' }),
        entry({ id: 'plan', promptSnippet: '' }),
        entry({ id: 'write', promptSnippet: 'Write only verified content.' }),
      ]),
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.systemPrompt).toBe(
      'BASE\n\n' +
      '# Tool usage notes\n\n' +
      'Read before editing.\n\n' +
      'Write only verified content.\n\n' +
      '# Project rules\n\n' +
      'These repository instructions are ordered from broader to narrower scope. ' +
      'When instructions conflict, the later, narrower scope takes precedence.\n\n' +
      '<project_rule source="/repo/A&amp;GENTS.md" scope="/repo/**">\n' +
      'ROOT_RULE\n' +
      '</project_rule>\n\n' +
      '<project_rule source="/repo/pkg/&quot;AGENTS&quot;.md" scope="/repo/pkg/&lt;app&gt;/**">\n' +
      'CHILD_RULE\n' +
      '</project_rule>',
    );
    expect(result.context.tools?.map((tool) => tool.name)).toEqual(['read', 'plan', 'write']);
    expect(result.context.tools?.[0]).toEqual({
      name: 'read',
      description: 'read description',
      parameters: schema,
    });
    expect(result.context.messages).toEqual(messages);

    expect(Object.isFrozen(result.context)).toBe(true);
    expect(Object.isFrozen(result.context.messages)).toBe(true);
    expect(Object.isFrozen(result.context.messages[0])).toBe(true);
    expect(Object.isFrozen(result.context.messages[0]?.content)).toBe(true);
    expect(Object.isFrozen(result.context.tools)).toBe(true);
    expect(Object.isFrozen(result.context.tools?.[0]?.parameters)).toBe(true);

    (messages[0]!.content[0] as { type: 'text'; text: string }).text = 'changed';
    ((schema.properties as Record<string, unknown>).path as Record<string, unknown>).type = 'number';
    (files[0] as { content: string }).content = 'CHANGED_RULE';
    expect(result.context.messages[0]?.content[0]).toEqual({ type: 'text', text: 'hello' });
    expect(
      ((result.context.tools?.[0]?.parameters.properties as Record<string, unknown>).path as Record<string, unknown>)
        .type,
    ).toBe('string');
    expect(result.context.systemPrompt).toContain('ROOT_RULE');
    expect(result.context.systemPrompt).not.toContain('CHANGED_RULE');
  });

  it('preserves the snapshot-provided entry and rule order instead of re-sorting live values', () => {
    const files: RuleSnapshot['files'] = [
      { path: '/z', scope: '/z/**', contentDigest: 'z', content: 'Z_RULE' },
      { path: '/a', scope: '/a/**', contentDigest: 'a', content: 'A_RULE' },
    ];
    const result = createPromptAssembler().assemble(input({
      effectivePolicy: effectivePolicy(ruleSnapshot(owner(), files)),
      catalog: catalog([
        entry({ id: 'z-tool', promptSnippet: 'Z_NOTE' }),
        entry({ id: 'a-tool', promptSnippet: 'A_NOTE' }),
      ]),
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.tools?.map((tool) => tool.name)).toEqual(['z-tool', 'a-tool']);
    expect(result.context.systemPrompt?.indexOf('Z_NOTE')).toBeLessThan(
      result.context.systemPrompt?.indexOf('A_NOTE') ?? -1,
    );
    expect(result.context.systemPrompt?.indexOf('Z_RULE')).toBeLessThan(
      result.context.systemPrompt?.indexOf('A_RULE') ?? -1,
    );
  });

  it('rejects every owner or model-ref mismatch as invalid_prompt_context', () => {
    const contextCases: PromptAssemblyInput[] = [
      input({ basePrompt: { ...input().basePrompt, owner: owner({ cwd: '/other' }) } }),
      input({
        effectivePolicy: effectivePolicy(ruleSnapshot(owner({ turnId: 'turn_other' as TurnId }))),
      }),
      input({
        model: { ref: { provider: 'other', api: 'openai-chat', model: 'gpt-test' } },
      }),
      input({
        model: { ref: { provider: 'openai', api: 'openai-responses', model: 'gpt-test' } },
      }),
      input({
        model: { ref: { provider: 'openai', api: 'openai-chat', model: 'gpt-other' } },
      }),
    ];

    for (const candidate of contextCases) {
      expect(createPromptAssembler().assemble(candidate)).toMatchObject({
        ok: false,
        code: 'invalid_prompt_context',
      });
    }
  });

  it('returns invalid_prompt_input for non-strict messages, schemas, and duplicate capability ids', () => {
    const nonJsonMessage = input().outboundMessages[0] as AgentMessage & { extra?: unknown };
    nonJsonMessage.extra = undefined;
    const cyclicSchema: JSONSchema = {};
    cyclicSchema.self = cyclicSchema;

    const cases = [
      input({ outboundMessages: [nonJsonMessage] }),
      input({ catalog: catalog([entry({ id: 'cyclic', schema: cyclicSchema })]) }),
      input({ catalog: catalog([entry({ id: 'same' }), entry({ id: 'same' })]) }),
    ];

    for (const candidate of cases) {
      expect(createPromptAssembler().assemble(candidate)).toMatchObject({
        ok: false,
        code: 'invalid_prompt_input',
      });
    }
  });
});
