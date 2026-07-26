// killProcessTree:杀掉 detached 进程组的整棵树(规格见 docs/07-tools.md §2.5)。
// bash 工具以 { detached: true } spawn 使子进程成为进程组组长(pgid = pid),
// 这里对 -pid 发信号覆盖全组——只 kill 直接子进程会漏掉 `npm run dev` 起的孙进程。
// SIGTERM → 宽限期轮询 → 仍存活则 SIGKILL。任何路径都不 throw(进程已死是常态)。

const POLL_INTERVAL_MS = 50;

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false; // ESRCH(组已不存在)/ EPERM 等:一律视为「无需再杀」
  }
}

function groupAlive(pid: number): boolean {
  return signalGroup(pid, 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 对进程组 pid 先 SIGTERM,graceMs(默认 3000ms)内轮询存活,超期 SIGKILL。
 * 返回时保证已发出致命信号(SIGKILL 后不再等待——内核层面必死,无需确认)。
 */
export async function killProcessTree(pid: number, opts?: { graceMs?: number }): Promise<void> {
  const graceMs = opts?.graceMs ?? 3000;
  if (!signalGroup(pid, 'SIGTERM')) return; // 组已消失

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return;
    await sleep(POLL_INTERVAL_MS);
  }
  signalGroup(pid, 'SIGKILL');
}
