#!/usr/bin/env node
// CLI 入口(规格见 docs/09-cli.md §2):flag 解析 → 配置解析 → Session 组装 → 分派
// headless / 一次性 / 交互 REPL。CLI 是最薄的一层:把输入翻译成 Agent 方法调用,
// 把事件翻译成像素;不持有会话状态副本。

import { readFileSync } from 'node:fs';
import process from 'node:process';
import type { StreamFn } from '../protocol/index.js';
import { createCodingTools } from '../tools/index.js';
import { streamOpenAIChat } from '../providers/openai-chat/index.js';
import { createFauxStreamFn } from '../providers/faux/index.js';
import type { FauxScript } from '../providers/faux/index.js';
import type { SessionOptions } from '../session/index.js';
import { Session } from '../session/index.js';
import { parseFlags, readConfigFile, resolveConfig } from './config.js';
import type { CliFlags } from './config.js';
import { startHeadless } from './headless.js';
import { createRenderer } from './renderer.js';
import { startRepl } from './repl.js';
import { pickSessionInteractive } from './resume-picker.js';

async function main(): Promise<number> {
  let flags: CliFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (err) {
    console.error(`[coda] ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  let resolved;
  try {
    resolved = resolveConfig(flags, process.env, readConfigFile());
  } catch (err) {
    console.error(`[coda] ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  // 非 TTY stdin 且非 --json:读完 stdin 作为一次性 prompt(docs/09 §8)。
  // 读空(coda </dev/null 且无 -p):交互 REPL 需要 TTY,进 startRepl 只会无限挂起——
  // 提示用法并 exit 2(放在 Session 创建之前,不为错误路径留下空会话文件)。
  if (!flags.json && flags.prompt === undefined && !process.stdin.isTTY) {
    const text = readFileSync(0, 'utf8').trim();
    if (text.length === 0) {
      console.error('[coda] empty stdin and no prompt; usage: coda -p "..."  or  echo "..." | coda');
      return 2;
    }
    flags.prompt = text;
  }

  const cwd = flags.cwd ?? process.cwd();
  const streamFn = makeStreamFn(resolved.provider, resolved.fauxScript);
  const sessionOptions: SessionOptions = {
    agentConfig: {
      streamFn,
      model: resolved.modelConfig,
      tools: createCodingTools(),
      cwd,
      systemPrompt: () => buildSystemPrompt(cwd),
    },
    ...(flags.sessionDir !== undefined && { dir: flags.sessionDir }),
  };

  // 会话选择:--continue 恢复最近一个;--resume [id] 指定或列表选择;否则新会话
  let session: Session;
  let resumed = false;
  if (flags.continue_ || flags.resume !== undefined) {
    const id = await resolveSessionId(flags, sessionOptions.dir);
    if (id === undefined) {
      console.error('[coda] no session to resume');
      return 2;
    }
    session = await Session.resume(id, sessionOptions);
    resumed = true;
  } else {
    session = await Session.create(sessionOptions);
  }

  if (flags.json) {
    // --json 与 -p 组合(docs/09 §6.4 一次性特例):启动注入 prompt,agent_end 后自动退出
    return startHeadless(session, {
      stdin: process.stdin,
      stdout: process.stdout,
      ...(flags.prompt !== undefined && { initialPrompt: flags.prompt }),
    });
  }

  // interactive 由 TTY(且非一次性)决定;color 独立(NO_COLOR/--no-color 只禁 SGR 着色,
  // 不禁动态区光标控制,docs/09 §1.3)
  const renderer = createRenderer(process.stdout, {
    color: !flags.noColor && process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined,
    interactive: process.stdout.isTTY === true && flags.prompt === undefined,
  });
  session.subscribe((e) => {
    renderer.render(e);
  });
  if (resumed) renderer.replayTranscript(session.messages);

  if (flags.prompt !== undefined) {
    // -p 一次性模式:headless 内核的特例(人类可读输出)。退出码同 --json 特例规则
    // (docs/09 §6.4):agent_end reason 'error' → exit 1(脚本可感知);completed → 0。
    let exitCode = 0;
    const unsub = session.subscribe((e) => {
      if (e.type === 'agent_end' && e.reason === 'error') exitCode = 1;
    });
    await session.prompt(flags.prompt);
    await session.close();
    unsub();
    return exitCode;
  }

  return startRepl(session, renderer);
}

function makeStreamFn(provider: 'openai-chat' | 'faux', fauxScriptPath?: string): StreamFn {
  if (provider === 'faux') {
    const script: FauxScript =
      fauxScriptPath !== undefined
        ? (JSON.parse(readFileSync(fauxScriptPath, 'utf8')) as FauxScript)
        : { turns: [], onExhausted: 'emptyStop' };
    script.onExhausted = script.onExhausted ?? 'emptyStop';
    return createFauxStreamFn(script);
  }
  return streamOpenAIChat;
}

function buildSystemPrompt(cwd: string): string {
  return (
    `You are coda, a terminal coding agent. Working directory: ${cwd}\n` +
    'Use the provided tools to inspect and modify files. Read files before editing them. ' +
    'Prefer small, verifiable steps; when done, summarize what changed in one short sentence.'
  );
}

async function resolveSessionId(flags: CliFlags, dir: string | undefined): Promise<string | undefined> {
  const sessions = await Session.list(dir);
  if (flags.continue_) return sessions[0]?.id;                       // 最近一个
  if (typeof flags.resume === 'string') return flags.resume;         // 显式 id
  return pickSessionInteractive(sessions);                           // 列表选择
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error('[coda] fatal:', err);
    process.exitCode = 1;
  },
);
