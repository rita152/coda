// plan 工具的紧凑展示投影：将整表替换快照排成可重排的 checklist，
// 保持 Codex TUI 的标题、树状缩进和三态视觉层级；不承载 Runtime 事实。

import type { PlanStep } from '../protocol/index.js';

const PLAN_GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : undefined;

export interface PlanProgress {
  readonly completed: number;
  readonly total: number;
}

export interface PlanPresentationLine {
  /** undefined 仅用于空计划的说明行。 */
  readonly status: PlanStep['status'] | undefined;
  /** 由调用方按 muted 样式绘制的树状缩进。 */
  readonly prefix: string;
  /** 首行才有状态标记；续行保留同列的空白。 */
  readonly marker: string;
  readonly text: string;
}

export interface PlanPresentation {
  readonly title: 'Updated Plan';
  readonly progress: PlanProgress | undefined;
  readonly lines: readonly PlanPresentationLine[];
}

function planGraphemes(value: string): readonly string[] {
  return PLAN_GRAPHEME_SEGMENTER === undefined
    ? [...value]
    : [...PLAN_GRAPHEME_SEGMENTER.segment(value)].map((segment) => segment.segment);
}

function normalizePlanStep(value: string): string {
  return value.replace(/[\t\r\n]+/gu, ' ').replace(/ +/gu, ' ').trim();
}

function takePlanFragment(
  value: string,
  maxWidth: number,
  measureWidth: (value: string) => number,
): string {
  let fragment = '';
  for (const grapheme of planGraphemes(value)) {
    const candidate = `${fragment}${grapheme}`;
    if (fragment !== '' && measureWidth(candidate) > maxWidth) break;
    fragment = candidate;
    if (measureWidth(fragment) >= maxWidth) break;
  }
  return fragment;
}

/** 以首行与续行不同的宽度排版短任务说明；超长连续 CJK/URL 也不会溢出。 */
function wrapPlanStep(
  value: string,
  firstLineWidth: number,
  continuationLineWidth: number,
  measureWidth: (value: string) => number,
): readonly string[] {
  const words = normalizePlanStep(value).split(' ').filter((word) => word !== '');
  if (words.length === 0) return ['(empty step)'];

  const firstWidth = Math.max(1, firstLineWidth);
  const continuationWidth = Math.max(1, continuationLineWidth);
  const lines: string[] = [];
  let current = '';

  const currentLimit = (): number => lines.length === 0 ? firstWidth : continuationWidth;
  const appendToEmptyLine = (word: string): void => {
    let remaining = word;
    while (remaining !== '') {
      const limit = currentLimit();
      if (measureWidth(remaining) <= limit) {
        current = remaining;
        return;
      }
      const fragment = takePlanFragment(remaining, limit, measureWidth);
      // 一个宽字符也可能比极窄终端的可用宽度大；此时仍要向前推进。
      const safeFragment = fragment === '' ? planGraphemes(remaining)[0] ?? '' : fragment;
      if (safeFragment === '') return;
      lines.push(safeFragment);
      remaining = remaining.slice(safeFragment.length);
    }
  };

  for (const word of words) {
    if (current === '') {
      appendToEmptyLine(word);
      continue;
    }
    const candidate = `${current} ${word}`;
    if (measureWidth(candidate) <= currentLimit()) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = '';
    appendToEmptyLine(word);
  }
  if (current !== '') lines.push(current);
  return lines;
}

export function planProgress(steps: readonly PlanStep[]): PlanProgress | undefined {
  if (steps.length === 0) return undefined;
  return {
    completed: steps.filter((step) => step.status === 'completed').length,
    total: steps.length,
  };
}

export function formatPlanProgress(progress: PlanProgress | undefined): string | undefined {
  return progress === undefined ? undefined : `${progress.completed}/${progress.total} complete`;
}

/** Unicode 与无色/ASCII 终端都保留三种可辨别的状态。 */
export function planMarker(status: PlanStep['status'], ascii = false): string {
  if (ascii) {
    switch (status) {
      case 'completed': return '[x]';
      case 'in_progress': return '[>]';
      case 'pending': return '[ ]';
    }
  }
  return status === 'completed' ? '✔' : '□';
}

/**
 * 将整张 plan 快照排为 Codex 风格的单个树状 checklist。
 * 第一条使用 `└` 承接标题，后续条目和折行严格对齐到状态文本列。
 */
export function layoutPlan(
  steps: readonly PlanStep[],
  width: number,
  measureWidth: (value: string) => number,
  ascii = false,
): PlanPresentation {
  const progress = planProgress(steps);
  if (steps.length === 0) {
    return {
      title: 'Updated Plan',
      progress,
      lines: [{ status: undefined, prefix: ascii ? '  \\ ' : '  └ ', marker: '', text: '(no steps provided)' }],
    };
  }

  const lines: PlanPresentationLine[] = [];
  const availableWidth = Math.max(1, width);
  for (const [index, step] of steps.entries()) {
    const marker = planMarker(step.status, ascii);
    const firstPrefix = index === 0 ? (ascii ? '  \\ ' : '  └ ') : '    ';
    const continuationPrefix = ' '.repeat(
      Math.max(0, measureWidth(firstPrefix) + measureWidth(`${marker} `)),
    );
    const wrapped = wrapPlanStep(
      step.step,
      availableWidth - measureWidth(firstPrefix) - measureWidth(`${marker} `),
      availableWidth - measureWidth(continuationPrefix),
      measureWidth,
    );
    wrapped.forEach((text, lineIndex) => {
      lines.push({
        status: step.status,
        prefix: lineIndex === 0 ? firstPrefix : continuationPrefix,
        marker: lineIndex === 0 ? marker : '',
        text,
      });
    });
  }
  return { title: 'Updated Plan', progress, lines };
}

/** 稳定的无样式文本投影，供 transcript 搜索、锚点与 plain renderer 使用。 */
export function planPlainText(steps: readonly PlanStep[], ascii = false): string {
  const presentation = layoutPlan(steps, Number.MAX_SAFE_INTEGER, (value) => value.length, ascii);
  const progress = formatPlanProgress(presentation.progress);
  const header = progress === undefined
    ? presentation.title
    : `${presentation.title}${ascii ? ' | ' : ' · '}${progress}`;
  return [
    header,
    ...presentation.lines.map((line) =>
      `${line.prefix}${line.marker === '' ? '' : `${line.marker} `}${line.text}`),
  ].join('\n');
}
