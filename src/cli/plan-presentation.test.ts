// plan checklist 布局回归：状态层级、窄宽折行与无色终端标记必须稳定。

import { describe, expect, it } from 'bun:test';
import type { PlanStep } from '../protocol/index.js';
import {
  formatPlanProgress,
  layoutPlan,
  planPlainText,
} from './plan-presentation.js';
import { displayWidth } from './renderer.js';

const measure = (value: string): number => value.length;

describe('plan presentation', () => {
  const steps: readonly PlanStep[] = [
    { step: 'Inspect existing rendering', status: 'completed' },
    { step: 'Implement the focused plan card', status: 'in_progress' },
    { step: 'Run the full test suite', status: 'pending' },
  ];

  it('uses the Codex-style title, progress, tree connector, and three states', () => {
    const presentation = layoutPlan(steps, 80, measure);

    expect(presentation.title).toBe('Updated Plan');
    expect(formatPlanProgress(presentation.progress)).toBe('1/3 complete');
    expect(presentation.lines).toEqual([
      { status: 'completed', prefix: '  └ ', marker: '✔', text: 'Inspect existing rendering' },
      { status: 'in_progress', prefix: '    ', marker: '□', text: 'Implement the focused plan card' },
      { status: 'pending', prefix: '    ', marker: '□', text: 'Run the full test suite' },
    ]);
  });

  it('keeps wrapped text aligned to the status text column and makes ASCII states explicit', () => {
    const presentation = layoutPlan(
      [{ step: 'inspect the narrow terminal layout before rendering', status: 'in_progress' }],
      20,
      measure,
      true,
    );

    expect(presentation.lines).toEqual([
      { status: 'in_progress', prefix: '  \\ ', marker: '[>]', text: 'inspect the' },
      { status: 'in_progress', prefix: '        ', marker: '', text: 'narrow' },
      { status: 'in_progress', prefix: '        ', marker: '', text: 'terminal' },
      { status: 'in_progress', prefix: '        ', marker: '', text: 'layout' },
      { status: 'in_progress', prefix: '        ', marker: '', text: 'before' },
      { status: 'in_progress', prefix: '        ', marker: '', text: 'rendering' },
    ]);
  });

  it('wraps wide CJK graphemes without crossing the configured terminal width', () => {
    const presentation = layoutPlan(
      [{ step: '检查计划展示宽度', status: 'pending' }],
      10,
      displayWidth,
    );

    expect(presentation.lines).toEqual([
      { status: 'pending', prefix: '  └ ', marker: '□', text: '检查' },
      { status: 'pending', prefix: '      ', marker: '', text: '计划' },
      { status: 'pending', prefix: '      ', marker: '', text: '展示' },
      { status: 'pending', prefix: '      ', marker: '', text: '宽度' },
    ]);
    for (const line of presentation.lines) {
      expect(displayWidth(`${line.prefix}${line.marker === '' ? '' : `${line.marker} `}${line.text}`))
        .toBeLessThanOrEqual(10);
    }
  });

  it('provides a stable unstyled transcript projection, including the empty state', () => {
    expect(planPlainText(steps, true)).toBe(
      'Updated Plan | 1/3 complete\n' +
        '  \\ [x] Inspect existing rendering\n' +
        '    [>] Implement the focused plan card\n' +
        '    [ ] Run the full test suite',
    );
    expect(planPlainText([])).toBe('Updated Plan\n  └ (no steps provided)');
  });
});
