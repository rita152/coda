/** Storage-authority failure shared below the per-thread and workspace Runtime layers. */
export class RuntimeStorageError extends Error {
  override readonly name = 'RuntimeStorageError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
