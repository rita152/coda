import { describe, expect, test } from 'bun:test';

import {
  canonicalJson,
  cloneStrictJsonValue,
  isWellFormedUnicode,
  StrictJsonError,
  strictJsonSnapshot,
} from './strict-json.js';

describe('strict JSON boundary', () => {
  test('accepts scalar Unicode and rejects both lone-surrogate directions', () => {
    expect(isWellFormedUnicode('')).toBe(true);
    expect(isWellFormedUnicode('A\0😀')).toBe(true);
    expect(isWellFormedUnicode('\ud800')).toBe(false);
    expect(isWellFormedUnicode('\udc00')).toBe(false);
    expect(() => strictJsonSnapshot('\ud800')).toThrow(StrictJsonError);
    expect(() => strictJsonSnapshot('\udc00')).toThrow(StrictJsonError);
  });

  test('preserves legal magic keys without invoking Object.prototype setters', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":"value","":"empty"}') as unknown;
    const snapshot = cloneStrictJsonValue(input);
    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(Object.hasOwn(snapshot as object, '__proto__')).toBe(true);
    expect(canonicalJson(input)).toBe(
      '{"":"empty","__proto__":{"polluted":true},"constructor":"value"}',
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  test('orders keys by UTF-8 bytes and normalizes negative zero', () => {
    expect(canonicalJson({ z: -0, a: 1, '10': true, '2': false })).toBe(
      '{"10":true,"2":false,"a":1,"z":0}',
    );
  });

  test('rejects ill-formed property keys before they can alias through UTF-8 replacement', () => {
    expect(() => canonicalJson({ ['\ud800']: 1 })).toThrow(StrictJsonError);
    expect(() => canonicalJson({ ['\udc00']: 1 })).toThrow(StrictJsonError);
  });

  test('rejects non-JSON values, accessors, holes, cycles, and non-plain instances', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 });
    const sparse = Array.from({ length: 1 });
    delete sparse[0];

    for (const invalid of [
      undefined,
      1n,
      Symbol('x'),
      () => undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { value: undefined },
      [undefined],
      sparse,
      cycle,
      accessor,
      new Date(0),
    ]) {
      expect(() => strictJsonSnapshot(invalid)).toThrow(StrictJsonError);
    }
  });

  test('returns a detached deeply frozen snapshot', () => {
    const input = { nested: { values: [1, 2] } };
    const snapshot = strictJsonSnapshot(input) as Readonly<{
      nested: Readonly<{ values: readonly number[] }>;
    }>;
    input.nested.values.push(3);
    expect(snapshot.nested.values).toEqual([1, 2]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.nested)).toBe(true);
    expect(Object.isFrozen(snapshot.nested.values)).toBe(true);
  });
});
