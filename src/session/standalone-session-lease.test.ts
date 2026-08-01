// Standalone lease discovery record installation: complete durable temp, no-replace target claim.

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { canonicalJson } from '../protocol/index.js';
import {
  StandaloneSessionLease,
  installStandaloneLeaseRecordExclusive,
  type StandaloneLeaseRecord,
} from './standalone-session-lease.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'coda-standalone-lease-install-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('standalone lease first installation', () => {
  test('publishes only a complete newline-terminated record and removes its durable temp link', () => {
    const file = path.join(root, 'lease.json');
    const record = leaseRecord('owner-a');

    installStandaloneLeaseRecordExclusive(file, record);

    expect(readFileSync(file, 'utf8')).toBe(`${canonicalJson(record)}\n`);
    expect(readdirSync(root)).toEqual(['lease.json']);
  });

  test('refuses to overwrite an independently installed contender record', () => {
    const file = path.join(root, 'lease.json');
    const contender = `${canonicalJson(leaseRecord('owner-winner'))}\n`;
    writeFileSync(file, contender, { encoding: 'utf8', flag: 'wx' });

    expect(() => installStandaloneLeaseRecordExclusive(file, leaseRecord('owner-loser')))
      .toThrow(expect.objectContaining({ code: 'EEXIST' }));

    expect(readFileSync(file, 'utf8')).toBe(contender);
    expect(readdirSync(root)).toEqual(['lease.json']);
  });

  test('quarantines a stale malformed legacy record only after its kernel authority is gone', async () => {
    const sessionId = 'session-malformed-legacy';
    const first = await StandaloneSessionLease.acquire(root, sessionId);
    const leaseDir = path.join(root, '.standalone-leases');
    const recordName = readdirSync(leaseDir).find((name) => name.endsWith('.json'));
    if (recordName === undefined) throw new Error('lease fixture did not create a record');
    const recordFile = path.join(leaseDir, recordName);
    first.release();
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    writeFileSync(recordFile, '{"version":', 'utf8');

    const recovered = await StandaloneSessionLease.acquire(root, sessionId);
    const installed = JSON.parse(readFileSync(recordFile, 'utf8')) as StandaloneLeaseRecord;
    expect(installed.version).toBe(1);
    expect(installed.sessionKey.endsWith(`/${sessionId}.jsonl`)).toBe(true);
    expect(readdirSync(leaseDir).some((name) => name.includes('.corrupt.'))).toBe(true);
    recovered.release();
  });
});

function leaseRecord(ownerNonce: string): StandaloneLeaseRecord {
  return {
    version: 1,
    sessionKey: path.join(root, 'session-a.jsonl'),
    ownerNonce,
    pid: process.pid,
    port: 24_681,
  };
}
