// Bash 紧凑展示的纯函数回归：命令 token、续行与输出首尾保留。

import { describe, expect, it } from 'bun:test';
import {
  bashCommandFromArgs,
  highlightBashCommand,
  layoutBashCommand,
  previewBashOutput,
} from './bash-presentation.js';
import { displayWidth } from './renderer.js';

describe('bash presentation', () => {
  it('extracts commands only from string arguments', () => {
    expect(bashCommandFromArgs({ command: 'git status' })).toBe('git status');
    expect(bashCommandFromArgs({ command: 1 })).toBeUndefined();
    expect(bashCommandFromArgs(undefined)).toBeUndefined();
  });

  it('highlights executables, flags, quoted strings and shell operators', () => {
    expect(highlightBashCommand('git status --short && bun -e "console.log(1)"')).toEqual([
      { text: 'git', tone: 'command' },
      { text: ' status ', tone: 'normal' },
      { text: '--short', tone: 'flag' },
      { text: ' ', tone: 'normal' },
      { text: '&&', tone: 'operator' },
      { text: ' ', tone: 'normal' },
      { text: 'bun', tone: 'command' },
      { text: ' ', tone: 'normal' },
      { text: '-e', tone: 'flag' },
      { text: ' ', tone: 'normal' },
      { text: '"console.log(1)"', tone: 'string' },
    ]);
  });

  it('limits command continuations while retaining a visible omission marker', () => {
    const layout = layoutBashCommand(
      'one two three four five six seven eight nine ten eleven twelve',
      8,
      8,
      (value) => value.length,
    );

    expect(layout.lines).toHaveLength(4); // header + two continuations + omission marker
    expect(layout.lines.at(-1)?.[0]?.text).toBe(`… +${layout.omittedContinuationLines}`);
    expect(displayWidth(layout.lines.at(-1)?.map((token) => token.text).join('') ?? ''))
      .toBeLessThanOrEqual(8);
    expect(layout.omittedContinuationLines).toBeGreaterThan(0);
  });

  it('never splits a ZWJ grapheme while wrapping a long token', () => {
    const layout = layoutBashCommand(
      '👩‍💻👩‍💻',
      2,
      2,
      displayWidth,
      10,
    );
    const lines = layout.lines.map((line) => line.map((token) => token.text).join(''));

    expect(lines).toEqual(['👩‍💻', '👩‍💻']);
    expect(lines.every((line) => displayWidth(line) <= 2)).toBe(true);
  });

  it('keeps two head and two tail rows, excluding the bash exit-code trailer', () => {
    const output = [
      'head one',
      'head two',
      ...Array.from({ length: 9 }, (_, index) => `middle ${index + 1}`),
      'tail one',
      'tail two',
      'exit code 0',
    ].join('\n');

    expect(previewBashOutput(output)).toEqual({
      lines: ['head one', 'head two', 'tail one', 'tail two'],
      omittedLines: 9,
    });
  });
});
