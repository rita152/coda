// plan 工具:模型自维护的任务清单(规格见 docs/07-tools.md §2.8)。
// 整表替换语义(opencode todowrite / codex update_plan 同构):模型每次重申完整列表,
// 状态不会漂移;列表随每次 tool result 重新进入上下文,是防长任务跑偏的机制。
// plan_update 旁路事件由 loop 在 finalize 阶段识别 details 后发出(工具不依赖事件总线)。

import { z } from 'zod';
import type { PlanStep } from '../protocol/index.js';
import type { ToolExecutionInput, ToolOutput } from './types.js';

export const planParameters = z.object({
  steps: z
    .array(
      z.object({
        step: z.string().min(1).describe('Short description of this step'),
        status: z.enum(['pending', 'in_progress', 'completed']).describe('Current status of this step'),
      }),
    )
    .describe('The complete updated plan (full replacement of the previous list)'),
});

export type PlanArgs = z.infer<typeof planParameters>;

/** loop 识别此形态后发 plan_update(docs/07 §2.8);UI/持久化用,不发给模型。 */
export interface PlanDetails {
  steps: PlanStep[];
}

export const PLAN_DESCRIPTION =
  'Maintain the task plan as a checklist. Send the COMPLETE updated list every time (full replacement). ' +
  'Use for tasks with 3+ steps; keep exactly one step in_progress while working.';

export const PLAN_PROMPT_SNIPPET =
  'Plan tool usage: use it only for tasks with 3 or more steps. Mark a step in_progress before starting it ' +
  'and completed immediately after finishing — never batch updates or mark steps completed in advance. ' +
  'Keep at most one step in_progress at a time. If blocked, keep the step in_progress and add a new step ' +
  'describing the blocker.';

export async function executePlan(
  { args }: ToolExecutionInput<PlanArgs>,
): Promise<ToolOutput<PlanDetails>> {
    const steps = args.steps as PlanStep[];
    const lines = steps.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`);
    const inProgress = steps.filter((s) => s.status === 'in_progress').length;
    // 多个 in_progress 不报错但提醒(docs/07 §2.8:「至多一个 in_progress」违反时输出提醒)
    if (inProgress > 1) {
      lines.push(`Reminder: ${inProgress} steps are in_progress — keep at most one step in_progress at a time.`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') || '(empty plan)' }],
      details: { steps },
    };
}
