// Bun.env 是运行时环境变量的 canonical 入口。node:os 仅作为 HOME/USERPROFILE
// 均缺失时的跨平台 compatibility fallback。
import { homedir } from 'node:os';

export function runtimeHomeDir(): string {
  const configured = Bun.env.HOME ?? Bun.env.USERPROFILE;
  return configured !== undefined && configured.length > 0 ? configured : homedir();
}
