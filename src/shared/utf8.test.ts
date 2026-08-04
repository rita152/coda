// UTF-8 byte-order comparison regressions for ASCII, multibyte, prefix, and stable sorting.

import { describe, expect, it } from 'bun:test';
import { compareUtf8 } from './utf8.js';

describe('compareUtf8', () => {
  it('compares ASCII strings by byte value', () => {
    expect(compareUtf8('A', 'a')).toBeLessThan(0);
    expect(compareUtf8('b', 'a')).toBeGreaterThan(0);
    expect(compareUtf8('same', 'same')).toBe(0);
  });

  it('compares multibyte strings by encoded bytes', () => {
    expect(compareUtf8('\u00e9', '\u4e2d')).toBeLessThan(0);
    expect(compareUtf8('\u4e2d', '\ud83d\ude00')).toBeLessThan(0);
  });

  it('orders a complete prefix before the longer string', () => {
    expect(compareUtf8('prefix', 'prefix\u4e2d')).toBeLessThan(0);
    expect(compareUtf8('prefix\u4e2d', 'prefix')).toBeGreaterThan(0);
  });

  it('produces deterministic UTF-8 ordering', () => {
    const values = ['\ud83d\ude00', 'z', '\u4e2d', 'a', '\u00e9', 'aa'];
    expect([...values].sort(compareUtf8)).toEqual(['a', 'aa', 'z', '\u00e9', '\u4e2d', '\ud83d\ude00']);
    expect([...values].reverse().sort(compareUtf8)).toEqual(
      [...values].sort(compareUtf8),
    );
  });
});
