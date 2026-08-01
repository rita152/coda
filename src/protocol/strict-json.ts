// Strict JSON value boundary shared by protocol admission and authoritative commits.
// Unlike JSON.stringify(), this rejects values that would be dropped, coerced, or invoke code.

export type StrictJsonPrimitive = null | boolean | number | string;
export type StrictJsonValue =
  | StrictJsonPrimitive
  | readonly StrictJsonValue[]
  | { readonly [key: string]: StrictJsonValue };

export type StrictJsonErrorReason =
  | 'accessor_property'
  | 'array_hole'
  | 'bigint'
  | 'cycle'
  | 'function'
  | 'ill_formed_unicode'
  | 'non_enumerable_property'
  | 'non_finite_number'
  | 'non_plain_object'
  | 'symbol'
  | 'symbol_key'
  | 'undefined'
  | 'unsupported_type';

export class StrictJsonError extends TypeError {
  override readonly name = 'StrictJsonError';

  constructor(
    readonly reason: StrictJsonErrorReason,
    readonly path: string,
  ) {
    super(`Invalid strict JSON value at ${path}: ${reason}`);
  }
}

/** True when every UTF-16 code unit belongs to a valid Unicode scalar sequence. */
export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

/** Validate, detach, and deeply freeze a strict JSON value. */
export function strictJsonSnapshot(value: unknown): Readonly<StrictJsonValue> {
  return deepFreezeStrictJson(cloneStrictJson(value, '$', new Set<object>()));
}

/** Validate and detach a strict JSON value without freezing the returned snapshot. */
export function cloneStrictJsonValue(value: unknown): StrictJsonValue {
  return cloneStrictJson(value, '$', new Set<object>());
}

/** Serialize with plain-object keys ordered by their raw UTF-8 bytes. */
export function canonicalJson(value: unknown): string {
  const snapshot = cloneStrictJsonValue(value);
  return serializeCanonical(snapshot);
}

/** Full lowercase SHA-256 of the canonical UTF-8 representation. */
export function canonicalJsonSha256(value: unknown): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(value)));
}

export function sha256Hex(value: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

function cloneStrictJson(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): StrictJsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (!isWellFormedUnicode(value)) throw new StrictJsonError('ill_formed_unicode', path);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new StrictJsonError('non_finite_number', path);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'undefined') throw new StrictJsonError('undefined', path);
  if (typeof value === 'bigint') throw new StrictJsonError('bigint', path);
  if (typeof value === 'symbol') throw new StrictJsonError('symbol', path);
  if (typeof value === 'function') throw new StrictJsonError('function', path);
  if (typeof value !== 'object') throw new StrictJsonError('unsupported_type', path);

  if (ancestors.has(value)) throw new StrictJsonError('cycle', path);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return cloneArray(value, path, ancestors);
    return cloneObject(value, path, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function cloneArray(value: unknown[], path: string, ancestors: Set<object>): StrictJsonValue[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new StrictJsonError('non_plain_object', path);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') throw new StrictJsonError('symbol_key', path);
    if (key === 'length') continue;
    if (!isArrayIndex(key, value.length)) {
      throw new StrictJsonError('non_plain_object', propertyPath(path, key));
    }
  }

  const result: StrictJsonValue[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined) throw new StrictJsonError('array_hole', `${path}[${index}]`);
    assertDataDescriptor(descriptor, `${path}[${index}]`);
    result.push(cloneStrictJson(descriptor.value, `${path}[${index}]`, ancestors));
  }
  return result;
}

function cloneObject(
  value: object,
  path: string,
  ancestors: Set<object>,
): { [key: string]: StrictJsonValue } {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new StrictJsonError('non_plain_object', path);
  }

  // A null prototype is required here: assignment to a legal JSON key such as
  // "__proto__" must create data, never invoke Object.prototype's setter.
  const result = Object.create(null) as { [key: string]: StrictJsonValue };
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') throw new StrictJsonError('symbol_key', path);
    if (!isWellFormedUnicode(key)) {
      throw new StrictJsonError('ill_formed_unicode', propertyPath(path, key));
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined) continue;
    assertDataDescriptor(descriptor, propertyPath(path, key));
    result[key] = cloneStrictJson(descriptor.value, propertyPath(path, key), ancestors);
  }
  return result;
}

function assertDataDescriptor(descriptor: PropertyDescriptor, path: string): asserts descriptor is PropertyDescriptor & {
  value: unknown;
} {
  if ('get' in descriptor || 'set' in descriptor) {
    throw new StrictJsonError('accessor_property', path);
  }
  if (descriptor.enumerable !== true) {
    throw new StrictJsonError('non_enumerable_property', path);
  }
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function propertyPath(parent: string, key: string): string {
  return `${parent}[${JSON.stringify(key)}]`;
}

function deepFreezeStrictJson<T extends StrictJsonValue>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreezeStrictJson(child);
    Object.freeze(value);
  }
  return value;
}

function serializeCanonical(value: StrictJsonValue): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new StrictJsonError('unsupported_type', '$');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(',')}]`;

  const record = value as { readonly [key: string]: StrictJsonValue };
  const keys = Object.keys(record).sort(compareUtf8);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeCanonical(record[key]!)}`).join(',')}}`;
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}
