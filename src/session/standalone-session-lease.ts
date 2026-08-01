// Per-v1-backend standalone writer lease. A kernel-held loopback listener is the live authority;
// the sidecar record only makes the selected collision-free authority port discoverable/recoverable.

import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256Hex } from '../protocol/index.js';
import type { SessionRecord } from './store.js';
import type { SessionRuntimeMirrorGuard } from './legacy-thread-execution.js';

export interface StandaloneLeaseRecord {
  readonly version: 1;
  readonly sessionKey: string;
  readonly ownerNonce: string;
  readonly pid: number;
  readonly port: number;
}

export class StandaloneSessionInUseError extends Error {
  override readonly name = 'StandaloneSessionInUseError';
  readonly code = 'session_in_use' as const;

  constructor(readonly sessionId: string) {
    super(`Session is already open for writing: ${sessionId}`);
  }
}

export class StandaloneSessionLease implements SessionRuntimeMirrorGuard {
  readonly #listener: Bun.TCPSocketListener;
  readonly #recordFile: string;
  readonly #record: StandaloneLeaseRecord;
  #released = false;

  private constructor(
    listener: Bun.TCPSocketListener,
    recordFile: string,
    record: StandaloneLeaseRecord,
  ) {
    this.#listener = listener;
    this.#recordFile = recordFile;
    this.#record = record;
  }

  static async acquire(dir: string, sessionId: string): Promise<StandaloneSessionLease> {
    mkdirSync(dir, { recursive: true });
    const canonicalDir = realpathSync(dir);
    const sessionKey = path.join(canonicalDir, `${sessionId}.jsonl`);
    const leaseDir = path.join(canonicalDir, '.standalone-leases');
    mkdirSync(leaseDir, { recursive: true });
    const recordFile = path.join(
      leaseDir,
      `${sha256Hex(`standalone-session-lease-v1\0${sessionKey}`)}.json`,
    );
    let existing: StandaloneLeaseRecord | undefined;
    try {
      existing = readRecord(recordFile);
    } catch {
      quarantineMalformedRecord(recordFile, sessionKey, sessionId);
      return StandaloneSessionLease.acquire(dir, sessionId);
    }
    if (existing !== undefined) {
      if (existing.sessionKey !== sessionKey) {
        throw new Error(`Standalone Session lease key mismatch: ${sessionId}`);
      }
      const listener = tryListen(existing.port);
      if (listener === undefined) throw new StandaloneSessionInUseError(sessionId);
      const record = makeRecord(sessionKey, existing.port);
      writeRecordAtomic(recordFile, record);
      return new StandaloneSessionLease(listener, recordFile, record);
    }

    for (const port of candidatePorts(sessionKey)) {
      const listener = tryListen(port);
      if (listener === undefined) continue;
      const record = makeRecord(sessionKey, port);
      try {
        installStandaloneLeaseRecordExclusive(recordFile, record);
        return new StandaloneSessionLease(listener, recordFile, record);
      } catch (error) {
        listener.stop(true);
        if (!isAlreadyExists(error)) throw error;
        // A same-session contender installed the discovery record while we were probing. Resolve
        // that exact authority rather than selecting another port and creating a second writer.
        const winner = readRecord(recordFile);
        if (winner?.sessionKey !== sessionKey) {
          throw new StandaloneSessionInUseError(sessionId);
        }
        const staleProbe = tryListen(winner.port);
        if (staleProbe === undefined) {
          throw new StandaloneSessionInUseError(sessionId);
        }
        // The winner disappeared between record read and bind. Release the probe immediately and
        // recurse through the stale-record recovery path.
        staleProbe.stop(true);
        return StandaloneSessionLease.acquire(dir, sessionId);
      }
    }
    throw new StandaloneSessionInUseError(sessionId);
  }

  assertCurrent(): void {
    if (this.#released) throw new Error('Standalone Session lease is no longer current');
    const current = readRecord(this.#recordFile);
    if (current === undefined || canonicalJson(current) !== canonicalJson(this.#record)) {
      throw new Error('Standalone Session lease record changed while writer was active');
    }
  }

  beforeAppend(record: SessionRecord): void {
    void record;
    this.assertCurrent();
  }

  afterAppend(record: SessionRecord): void {
    void record;
    this.assertCurrent();
  }

  release(): void {
    if (this.#released) return;
    let failure: unknown;
    try {
      this.assertCurrent();
      unlinkIfExact(this.#recordFile, this.#record);
    } catch (error) {
      failure = error;
    } finally {
      this.#released = true;
      this.#listener.stop(true);
    }
    if (failure !== undefined) throw failure;
  }
}

function candidatePorts(sessionKey: string): readonly number[] {
  const digest = sha256Hex(`standalone-session-authority-v1\0${sessionKey}`);
  const range = 28_000;
  const start = Number.parseInt(digest.slice(0, 8), 16) % range;
  const ports: number[] = [];
  for (let index = 0; index < 128; index++) {
    ports.push(2_000 + ((start + index) % range));
  }
  return ports;
}

function tryListen(port: number): Bun.TCPSocketListener | undefined {
  try {
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port,
      exclusive: true,
      socket: {
        open(socket): void { socket.end(); },
        data(socket): void { socket.end(); },
        error(socket): void { socket.close(); },
      },
    });
    listener.unref();
    return listener;
  } catch {
    return undefined;
  }
}

function makeRecord(sessionKey: string, port: number): StandaloneLeaseRecord {
  return {
    version: 1,
    sessionKey,
    ownerNonce: crypto.randomUUID(),
    pid: process.pid,
    port,
  };
}

function readRecord(file: string): StandaloneLeaseRecord | undefined {
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StandaloneLeaseRecord>;
  if (parsed.version !== 1 || typeof parsed.sessionKey !== 'string'
    || typeof parsed.ownerNonce !== 'string' || typeof parsed.pid !== 'number'
    || !Number.isInteger(parsed.port) || (parsed.port as number) < 1 || (parsed.port as number) > 65_535) {
    throw new Error(`Invalid Standalone Session lease record: ${file}`);
  }
  return parsed as StandaloneLeaseRecord;
}

function quarantineMalformedRecord(file: string, sessionKey: string, sessionId: string): void {
  const probes: Bun.TCPSocketListener[] = [];
  try {
    // A legacy writer could have crashed while directly writing its final discovery record. Hold
    // every deterministic authority candidate while quarantining only when no live kernel owner
    // exists; any busy candidate keeps the malformed record fail-closed.
    for (const port of candidatePorts(sessionKey)) {
      const probe = tryListen(port);
      if (probe === undefined) throw new StandaloneSessionInUseError(sessionId);
      probes.push(probe);
    }
    try {
      renameSync(file, `${file}.corrupt.${crypto.randomUUID()}`);
      fsyncDirectory(path.dirname(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } finally {
    for (const probe of probes) probe.stop(true);
  }
}

/** @internal Crash-safe first-install primitive; exported for focused filesystem tests only. */
export function installStandaloneLeaseRecordExclusive(
  file: string,
  record: StandaloneLeaseRecord,
): void {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${record.ownerNonce}.tmp`);
  let linked = false;
  try {
    const fd = openSync(temporary, 'wx');
    try {
      writeFileSync(fd, `${canonicalJson(record)}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Hard-link installation is atomic and fails with EEXIST instead of replacing a contender.
    linkSync(temporary, file);
    linked = true;
    fsyncDirectory(directory);
  } finally {
    try { unlinkSync(temporary); } catch { /* the temporary may not have been created */ }
    // Persist temporary-entry cleanup only after the installed target itself is directory-durable.
    if (linked) fsyncDirectory(directory);
  }
}

function writeRecordAtomic(file: string, record: StandaloneLeaseRecord): void {
  const temporary = `${file}.${record.ownerNonce}.tmp`;
  try {
    writeFileSync(temporary, `${canonicalJson(record)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch { /* rename removes the temporary on success */ }
  }
}

function unlinkIfExact(file: string, record: StandaloneLeaseRecord): void {
  try {
    const current = readRecord(file);
    if (current !== undefined && canonicalJson(current) === canonicalJson(record)) unlinkSync(file);
  } catch {
    // A replaced/corrupt record must not be deleted by a stale owner.
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}
