// UTF-8 byte-order comparison shared by deterministic canonicalization and persistence paths.

const UTF8 = new TextEncoder();

/** Compares strings lexicographically by UTF-8 bytes, with a complete prefix sorting first. */
export function compareUtf8(left: string, right: string): number {
  const leftBytes = UTF8.encode(left);
  const rightBytes = UTF8.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}
