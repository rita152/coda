/**
 * Storage-authority failure shared by the session and runtime layers.
 *
 * The class lives below both layers so compatibility re-exports preserve
 * `instanceof` identity across the Phase-2 boundary migration.
 */
export class RuntimeStorageError extends Error {
  override readonly name = 'RuntimeStorageError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
