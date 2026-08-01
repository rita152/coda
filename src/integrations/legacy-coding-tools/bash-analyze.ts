// Legacy coding-tool binding 所有的保守 bash 命令/路径分析。
// v2 不引 tree-sitter,用尊重单双引号与反斜杠转义的手写扫描器拆分复合命令，并冻结 target kind。
// 原则:静态分析看不全的嵌套结构(命令替换 $()/反引号、进程替换 <()/>()、
// 重定向进系统路径、eval/exec/source 作 root)一律 forceConfirm 交给人,
// 且不许 allow_always 泛化;明确危险的模式(rm -rf / 等)直接 denied,不进 approval。

import path from 'node:path';
import { resolveToolWorkdir } from '../../shared/index.js';

/** Version of the frozen legacy bash command/path analysis consumed by policy adapters. */
export const LEGACY_BASH_ANALYSIS_VERSION = 'legacy_bash_analysis_v2';

export interface LegacyFilesystemTarget {
  readonly canonicalTarget: string;
  readonly kind: BashPathTarget['kind'];
}

export type LegacyBashFilesystemTarget = LegacyFilesystemTarget;

/** Adapter presentation facts frozen by the authoritative resolver for CLI legacy projection. */
export interface LegacyBashInvocationAnalysisAttributes {
  readonly kind: typeof LEGACY_BASH_ANALYSIS_VERSION;
  readonly command: string;
  readonly patterns: readonly string[];
  readonly forceConfirm: boolean;
  readonly reasons: readonly string[];
  readonly accessesExternalProject: boolean;
  /** Resolver-frozen target kinds; freshness must never rediscover these from the live filesystem. */
  readonly filesystemTargets: readonly Readonly<LegacyBashFilesystemTarget>[];
  readonly modelDescription?: string;
}

export type BashAnalysis =
  | { denied: true; reason: string }
  | {
      denied: false;
      /** 拆分后的子命令原文(trim 后,引号保留)。 */
      subcommands: string[];
      /** 每个子命令的审批 pattern:'bash:<root> *'(docs/07 §3.2 的泛化形态)。 */
      patterns: string[];
      forceConfirm: boolean;
      /** forceConfirm 的人类可读理由(approval UI 可直接展示)。 */
      reasons: string[];
    };

export interface BashPathTarget {
  path: string;
  kind: 'file' | 'directory' | 'unknown';
  source: 'workdir' | 'cd' | 'directory-option' | 'redirect' | 'argument';
}

export interface BashPathAnalysis {
  targets: BashPathTarget[];
  complete: boolean;
  reasons: string[];
}

/** 重定向进这些前缀 → forceConfirm(">/etc、>/usr 等",docs/07 §3.3)。 */
const SYSTEM_PATH_PREFIXES = [
  '/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/sys', '/proc',
  '/lib', '/var', '/opt', '/root', '/System', '/Library',
];

/** 例外:写向丢弃/终端设备是无害且高频的(npm test > /dev/null),不升级。 */
const SYSTEM_PATH_EXEMPT = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
  '/dev/zero',
]);

/** 以这些 root 起头的子命令,执行语义整体转交给参数,静态分析失效 → forceConfirm。'.' 是 source 的别名。 */
const OPAQUE_ROOTS = new Set(['eval', 'exec', 'source', '.']);

/** curl|sh / wget|sh:管道右端的 shell 家族。 */
const SHELL_ROOTS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

interface Segment {
  text: string;
  /** 该子命令与前一个子命令之间的分隔符('' 表示首段;'|' 用于 curl|sh 检测)。 */
  sep: string;
  redirects: string[];
}

interface ScanResult {
  segments: Segment[];
  hasCmdSubst: boolean;      // $( … )(双引号内同样生效)
  hasBacktick: boolean;      // ` … `(双引号内同样生效)
  hasProcSubst: boolean;     // <( … ) / >( … )
  hasExpansion: boolean;     // unquoted glob/brace or parameter expansion
  hasGrouping: boolean;      // subshell / group / function / arithmetic syntax
  unclosedQuote: boolean;
}

/** 顶层扫描:拆分复合命令(&& ; | & 与换行),引号内不拆;同时标记嵌套结构。 */
function scan(command: string): ScanResult {
  const segments: Segment[] = [];
  let hasCmdSubst = false;
  let hasBacktick = false;
  let hasProcSubst = false;
  let hasExpansion = false;
  let hasGrouping = false;
  let inSingle = false;
  let inDouble = false;
  let buf = '';
  let pendingSep = '';
  let redirects = new Set<string>();

  const flush = (sep: string): void => {
    const text = buf.trim();
    if (text !== '') segments.push({ text, sep: pendingSep, redirects: [...redirects] });
    // 空段(如 '||' 被 '|'+'|' 消费后的间隙)不产生子命令,但分隔符要传递给下一个非空段
    pendingSep = sep;
    buf = '';
    redirects = new Set();
  };

  /** 从 from 起窥探重定向目标(跳过空白与包裹引号),只读不消费——主循环照常逐字符扫描。 */
  const peekRedirectTarget = (from: number): string => {
    let i = from;
    while (i < command.length && (command[i] === ' ' || command[i] === '\t')) i++;
    const quote = command[i];
    if (quote === "'" || quote === '"') {
      const end = command.indexOf(quote, i + 1);
      return end === -1 ? command.slice(i + 1) : command.slice(i + 1, end);
    }
    let out = '';
    while (i < command.length && !' \t\n;|&\'"'.includes(command[i] as string)) {
      out += command[i];
      i++;
    }
    return out;
  };

  const checkRedirect = (from: number): void => {
    const target = peekRedirectTarget(from);
    if (target !== '' && !target.startsWith('&')) redirects.add(target);
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    const next = command[i + 1];

    if (inSingle) {
      if (ch === "'") inSingle = false;
      buf += ch;
      continue;
    }
    // 反斜杠转义:单引号外(含双引号内)转义下一字符,该字符不再参与任何判定
    if (ch === '\\') {
      buf += ch;
      if (next !== undefined) { buf += next; i++; }
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === '$' && next === '(') hasCmdSubst = true;   // "$(…)" 在双引号内仍会执行
      else if (ch === '$') hasExpansion = true;
      else if (ch === '`') hasBacktick = true;
      buf += ch;
      continue;
    }

    switch (ch) {
      case "'": inSingle = true; buf += ch; continue;
      case '"': inDouble = true; buf += ch; continue;
      case '`': hasBacktick = true; buf += ch; continue;
      case '$':
        if (next === '(') hasCmdSubst = true;
        else hasExpansion = true;
        buf += ch;
        continue;
      case '*':
      case '?':
      case '[':
        hasExpansion = true;
        buf += ch;
        continue;
      case '<':
        if (next === '(') {
          hasProcSubst = true;
        } else if (next === '<') {
          // heredoc / here-string 的后续 token 不是文件路径。
          buf += '<<';
          i++;
          if (command[i + 1] === '<') {
            buf += '<';
            i++;
          }
          continue;
        } else if (next === '>') {
          checkRedirect(i + 2);
          buf += '<>';
          i++;
          continue;
        } else if (next === '&') {
          buf += '<&';
          i++;
          continue;
        } else {
          checkRedirect(i + 1);
        }
        buf += ch;
        continue;
      case '>':
        if (next === '(') { hasProcSubst = true; buf += ch; continue; }
        if (next === '&') { buf += '>&'; i++; continue; }          // fd 复制(2>&1),不查路径
        if (next === '>') { checkRedirect(i + 2); buf += '>>'; i++; continue; }
        checkRedirect(i + 1);
        buf += ch;
        continue;
      case '&':
        if (next === '&') { flush('&&'); i++; continue; }
        if (next === '>') { buf += ch; continue; }     // '&>' 是重定向不是后台分隔,'>' 下一轮处理
        flush('&');
        continue;
      case '|':
        if (next === '|') { flush('||'); i++; continue; }
        if (next === '&') { flush('|'); i++; continue; }   // '|&' 语义仍是管道
        flush('|');
        continue;
      case ';': flush(';'); continue;
      case '\n': flush('\n'); continue;
      case '(':
      case ')':
      case '{':
        hasExpansion = true;
        hasGrouping = true;
        buf += ch;
        continue;
      case '}':
        hasGrouping = true;
        buf += ch;
        continue;
      default: buf += ch; continue;
    }
  }
  flush('');
  return {
    segments, hasCmdSubst, hasBacktick, hasProcSubst, hasExpansion, hasGrouping,
    unclosedQuote: inSingle || inDouble,
  };
}

/** 子命令分词:剥引号、解转义(与 scan 同一套引号规则,但产出干净 token)。 */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let started = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] as string;
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
      continue;
    }
    if (ch === '\\') {   // 单引号分支已 continue,此处必在单引号外:转义下一字符
      const next = segment[i + 1];
      if (next !== undefined) { cur += next; i++; started = true; }
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else cur += ch;
      continue;
    }
    if (ch === "'") { inSingle = true; started = true; continue; }
    if (ch === '"') { inDouble = true; started = true; continue; }
    if (ch === ' ' || ch === '\t') {
      if (started || cur !== '') { tokens.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur !== '') tokens.push(cur);
  return tokens;
}

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** 取 root:跳过前导环境变量赋值(FOO=1 npm test 的 root 是 npm)。 */
function rootOf(tokens: string[]): string {
  const rest = skipAssignments(tokens);
  return rest[0] ?? tokens[0] ?? '';
}

function skipAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[i] as string)) i++;
  return tokens.slice(i);
}

/**
 * 命令名归一:含斜杠的 root 是路径调用(/bin/rm、/usr/bin/rm、./rm),取 basename 得命令名再比对。
 * 否则 denylist 的字面量 root==='rm' 判定会被 '/bin/rm -rf /' 之类绝对路径整段绕过
 * (docs/07 §3.3 denylist 按命令语义,不按调用路径)。
 */
function commandName(root: string): string {
  return root.includes('/') ? path.basename(root) : root;
}

/**
 * denylist 视角需要穿透的"运行器/包装命令":它们把真实命令放在参数里执行
 * (env rm -rf /、nohup rm -rf /、command sh 等),外层 root 是运行器名而非真实命令,
 * denylist 的字面量判定会被整段绕过,且 allow_always 记下 'bash:env *' 后 env rm -rf / 会 0 提示执行。
 * sudo 一并纳入(与既有 sudo 跳过一致)。
 * 关键取舍:仅 denylist 视角剥这些;pattern/root 提取(rootOf)保留外层运行器名——
 * 否则 allow 一个高频运行器会连带放行它包装的任意命令(与不跳 sudo 做泛化的既有取舍一致)。
 */
const DENYLIST_RUNNERS = new Set([
  'sudo', 'doas',
  'env', 'command', 'builtin',
  'nohup', 'setsid', 'time',
  'nice', 'ionice', 'timeout', 'stdbuf',
  'xargs',
  // Multi-call binaries dispatch the following token as another command. They must be transparent
  // to both the catastrophic denylist and opaque nested-command analysis.
  'busybox', 'toybox',
]);

/** 接受前导数值定位参数的运行器(timeout 时长 / nice·ionice 优先级),需一并跳过才能触达真实命令。 */
const NUMERIC_ARG_RUNNERS = new Set(['timeout', 'nice', 'ionice']);

/** subshell/组定界符:前导 ( / { 与尾随 ) / }。 */
const GROUP_OPEN_RE = /^[({]+/;
const GROUP_CLOSE_RE = /[)}]+$/;

/**
 * denylist 视角:剥去 subshell '(…)' 与组 '{ …; }' 的定界符,露出内部真实命令。
 * scan 不追踪括号深度,'(rm -rf /)'/'{ rm -rf /; }' 会让 root 变成 '(rm' / '{' 而绕过 denylist;
 * '$()' 有 hasCmdSubst 兜底 forceConfirm,但无 '$' 的组命令没有兜底,denylist 必须自行穿透。
 * 剥法:去掉纯定界符 token('(' '((' '{' '}' ')' …)与粘连在首/末 token 上的定界符
 * ('(rm' → 'rm'、'/)' → '/'),对 '( ( rm ) )' 这类嵌套逐层剥净。
 */
function stripGroupDelims(tokens: string[]): string[] {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi && /^[({]+$/.test(tokens[lo] as string)) lo++;
  while (hi > lo && /^[)}]+$/.test(tokens[hi - 1] as string)) hi--;
  const slice = tokens.slice(lo, hi);
  if (slice.length === 0) return [];
  slice[0] = (slice[0] as string).replace(GROUP_OPEN_RE, '');
  slice[slice.length - 1] = (slice[slice.length - 1] as string).replace(GROUP_CLOSE_RE, '');
  return slice.filter((t) => t !== '');
}

/**
 * denylist 视角的 token 序列:反复剥离运行器包装(sudo/env/nohup/…),穿透到真实命令。
 * 每层剥掉运行器名 + 其选项旗标 + 内联赋值(env -i FOO=x cmd),
 * 并跳过 timeout/nice/ionice 的前导数值定位参数(timeout 10 rm、nice -n 10 rm)。
 * commandName 使绝对路径运行器(/usr/bin/env rm -rf /)同样被识别。
 * 注意 root/pattern 提取不走此视角——否则 allow_always 'bash:env *'/'bash:npm *' 会连带放行包装命令。
 */
function denyView(tokens: string[]): string[] {
  let rest = skipAssignments(tokens);
  for (;;) {
    const name = commandName(rest[0] ?? '');
    if (!DENYLIST_RUNNERS.has(name)) break;
    rest = rest.slice(1);
    // 剥该运行器自身的选项旗标与内联赋值(真实命令名是其后第一个非旗标/赋值 token)
    while (rest.length > 0) {
      const t = rest[0] as string;
      if (!t.startsWith('-') && !ENV_ASSIGNMENT_RE.test(t)) break;
      rest = rest.slice(1);
    }
    // timeout 时长 / nice·ionice 优先级等前导数值定位参数
    if (NUMERIC_ARG_RUNNERS.has(name)) {
      while (rest.length > 0 && /^\d/.test(rest[0] as string)) rest = rest.slice(1);
    }
    rest = skipAssignments(rest);
  }
  return rest;
}

/** Purely lexical root/home recognition; this boundary must never consult HOME or the filesystem. */
function isFatalRmTarget(value: string): boolean {
  const normalizedAbsolute = value.startsWith('/') ? path.posix.normalize(value) : undefined;
  if (normalizedAbsolute === '/' || normalizedAbsolute === '/*') return true;

  const home = /^(~|\$HOME|\$\{HOME\})(?=$|\/)(.*)$/.exec(value);
  if (home === null) return false;
  const suffix = home[2] ?? '';
  const sentinel = '/__coda_home__';
  const rawNormalizedHome = path.posix.normalize(`${sentinel}${suffix}`);
  const normalizedHome = rawNormalizedHome.length > 1
    ? rawNormalizedHome.replace(/\/+$/, '')
    : rawNormalizedHome;
  if (normalizedHome === sentinel || normalizedHome === `${sentinel}/*`) return true;
  // A literal '..' that escapes the symbolic home root is at least as destructive as deleting
  // HOME itself. Deny conservatively without resolving the user's ambient home directory.
  return normalizedHome !== sentinel && !normalizedHome.startsWith(`${sentinel}/`);
}

function checkDenylist(segments: Segment[], tokenized: string[][]): string | undefined {
  // 每段:先剥 subshell/组定界符,再穿透运行器包装,最后 basename 归一命令名。
  // 三步都在 denylist 视角内完成,pattern/root 视角(rootOf)不受影响。
  const views = tokenized.map((t) => denyView(stripGroupDelims(t as string[])));
  const roots = views.map((v) => commandName(v[0] ?? ''));

  for (let i = 0; i < views.length; i++) {
    const root = roots[i] as string;
    const args = (views[i] as string[]).slice(1);

    if (root === 'rm') {
      const flags = args.filter((t) => t.startsWith('-'));
      const hasRecursive = flags.some((f) => f === '--recursive' || (!f.startsWith('--') && /[rR]/.test(f)));
      const hasForce = flags.some((f) => f === '--force' || (!f.startsWith('--') && f.includes('f')));
      const fatalTarget = args.find((t) => !t.startsWith('-') && isFatalRmTarget(t));
      if (hasRecursive && hasForce && fatalTarget !== undefined) {
        return `'rm' with recursive force flags targeting '${fatalTarget}' would destroy the filesystem root or home directory`;
      }
    }
    if (root === 'mkfs' || root.startsWith('mkfs.')) {
      return `'${root}' formats a filesystem and destroys all data on the target device`;
    }
    if (root === 'dd' && args.some((t) => t.startsWith('of=/dev/'))) {
      return `'dd' writing directly to a device node (of=/dev/…) can destroy disk contents`;
    }
    // curl|sh / wget|sh:管道右端是 shell → 下载内容直接执行。
    // root/prevRoot 均已 basename + 运行器穿透,故 '| /bin/sh'、'| command sh'、'/usr/bin/curl |' 同样命中。
    if (i > 0 && (segments[i] as Segment).sep === '|' && SHELL_ROOTS.has(root)) {
      const prevRoot = roots[i - 1] as string;
      if (prevRoot === 'curl' || prevRoot === 'wget') {
        return `piping '${prevRoot}' output into '${root}' executes remote content without review`;
      }
    }
  }
  return undefined;
}

const AMBIGUOUS_LITERAL_PATH_RE = /\\/;
const URL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const DIRECTORY_OPTION_RE = /^--directory=(.+)$/;
const ATTACHED_C_RE = /^-C(.+)$/;
const DIRECTORY_OPTION_ROOTS = new Set(['git', 'make', 'gmake', 'ninja', 'tar', 'pnpm']);
const CONTROL_ROOTS = new Set([
  '!',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'select',
  'function',
  'command',
  'builtin',
  'popd',
]);
const SCRIPT_PATH_RE = /\.(?:ba|z|k)?sh$/i;
const GENERAL_SCRIPT_PATH_RE = /\.(?:[cm]?js|jsx|tsx?|py|pyw|rb|pl|php|lua|r)$/i;
const INLINE_INTERPRETER_ROOTS = new Set([
  'perl', 'ruby', 'php', 'lua', 'luajit', 'r', 'R', 'rscript',
  'tsx', 'ts-node',
]);
const VERSIONED_INTERPRETER_RE = /^(?:node(?:js)?\d*|python(?:\d+(?:\.\d+)*)?|pypy\d*)$/i;
const INTERPRETER_INFORMATION_FLAGS = new Set([
  '-h', '--help', '-v', '-V', '--version',
]);

function hasInlineCodeFlag(args: readonly string[]): boolean {
  return args.some((arg) =>
    arg === '-c'
    || arg === '-e'
    || arg === '-E'
    || arg === '--eval'
    || arg.startsWith('--eval=')
    || arg === '-p'
    || arg === '--print'
    || arg === '-r'
    || arg.startsWith('-e') && arg.length > 2);
}

function isOpaqueInterpreterInvocation(
  root: string,
  args: readonly string[],
  allowInformationOnly = false,
): boolean {
  if (INLINE_INTERPRETER_ROOTS.has(root) || VERSIONED_INTERPRETER_RE.test(root)) {
    if (allowInformationOnly
      && args.length === 1
      && INTERPRETER_INFORMATION_FLAGS.has(args[0] as string)) return false;
    // No arguments starts an interpreter/REPL which may consume executable stdin from a pipeline.
    // Any non-information invocation may contain inline code, a script, a module, or preload hooks.
    return true;
  }
  if (root === 'bun') {
    return hasInlineCodeFlag(args)
      || args.some((arg) => arg === 'run' || arg === 'x' || arg === 'exec')
      || args.some((arg) => GENERAL_SCRIPT_PATH_RE.test(arg));
  }
  if (root === 'deno') {
    return args.some((arg) => arg === 'eval' || arg === 'run' || arg === 'repl' || arg === 'task')
      || args.some((arg) => GENERAL_SCRIPT_PATH_RE.test(arg))
      || hasInlineCodeFlag(args);
  }
  if (root === 'awk' || root === 'gawk' || root === 'mawk' || root === 'nawk') {
    return args.length > 0;
  }
  return false;
}

function isScriptCommand(command: string): boolean {
  return SCRIPT_PATH_RE.test(command) || GENERAL_SCRIPT_PATH_RE.test(command);
}

function opaqueInvocationReason(tokens: string[]): string | undefined {
  const cleanTokens = stripGroupDelims(tokens);
  const words = skipAssignments(cleanTokens);
  const hasLeadingAssignments = cleanTokens.length !== words.length;
  const root = commandName(words[0] ?? '');
  const args = words.slice(1);
  const runnerView = DENYLIST_RUNNERS.has(root) ? denyView(cleanTokens) : [];
  const runnerRoot = commandName(runnerView[0] ?? '');
  const runnerArgs = runnerView.slice(1);

  if (CONTROL_ROOTS.has(root) || OPAQUE_ROOTS.has(root)) {
    return `'${root}' can hide filesystem paths from static analysis`;
  }
  if ((SHELL_ROOTS.has(root)
      && (args.includes('-c') || args.some((arg) => !arg.startsWith('-'))))
    || isOpaqueInterpreterInvocation(root, args, !hasLeadingAssignments)
    || isScriptCommand(words[0] ?? '')) {
    return `'${root}' can execute opaque inline or script code`;
  }
  if (root === 'xargs'
    || (root === 'find' && args.some((arg) => arg === '-exec' || arg === '-execdir'))
    || ((root === 'git' && args.includes('apply')) || root === 'patch')) {
    return `'${root}' can hide filesystem paths from static analysis`;
  }
  if (runnerView.length > 0
    && ((SHELL_ROOTS.has(runnerRoot) && runnerArgs.includes('-c'))
      || isOpaqueInterpreterInvocation(runnerRoot, runnerArgs)
      || isScriptCommand(runnerView[0] ?? '')
      || args.some((arg, index) =>
        (SHELL_ROOTS.has(commandName(arg)) && args.slice(index + 1).includes('-c'))
        || isOpaqueInterpreterInvocation(commandName(arg), args.slice(index + 1))
        || isScriptCommand(arg)))) {
    return `'${root}' wraps an opaque inline or script command`;
  }
  return undefined;
}

function resolveShellPath(cwd: string, value: string): string {
  return path.resolve(cwd, value);
}

function pathLikeArgument(value: string): string | undefined {
  const equals = value.indexOf('=');
  let candidate =
    equals > 0 && !value.startsWith('/') ? value.slice(equals + 1) : value;
  if (candidate.startsWith('@') && candidate.length > 1) candidate = candidate.slice(1);
  if (
    candidate === '' ||
    candidate === '-' ||
    candidate === '--' ||
    /^[><&|;]/.test(candidate) ||
    URL_RE.test(candidate)
  ) {
    return undefined;
  }
  return candidate;
}

function pathAnalysisReason(
  reasons: Set<string>,
  value: string,
  context: string,
): boolean {
  const homeExpansion = value.startsWith('~');
  if (!AMBIGUOUS_LITERAL_PATH_RE.test(value) && !homeExpansion) return false;
  reasons.add(`${context} contains shell expansion or globbing that hides its exact path`);
  return true;
}

/**
 * 提取 bash 中静态可见的作用域：执行 cwd、literal cd/-C、重定向和路径样参数。
 * 任意程序的运行时 I/O 无法由 shell 文本完备推导；complete=false 时调用方应保守处理。
 */
export function analyzeBashPaths(
  command: string,
  baseCwd: string,
  workdir?: string,
): BashPathAnalysis {
  const executionCwd = resolveToolWorkdir(baseCwd, workdir);
  const scanned = scan(command);
  const reasons = new Set<string>();
  const targets = new Map<string, BashPathTarget>();
  let shellCwds = new Set([executionCwd]);

  const add = (
    targetPath: string,
    kind: BashPathTarget['kind'],
    source: BashPathTarget['source'],
  ): void => {
    if (SYSTEM_PATH_EXEMPT.has(targetPath)) return;
    const existing = targets.get(targetPath);
    if (existing === undefined) {
      targets.set(targetPath, { path: targetPath, kind, source });
      return;
    }
    if (existing.kind !== kind && existing.kind !== 'unknown') {
      targets.set(targetPath, { ...existing, kind: 'unknown' });
    }
  };
  add(executionCwd, 'directory', 'workdir');

  if (scanned.hasCmdSubst) reasons.add('command substitution hides nested filesystem paths');
  if (scanned.hasBacktick) reasons.add('backtick substitution hides nested filesystem paths');
  if (scanned.hasProcSubst) reasons.add('process substitution hides nested filesystem paths');
  if (scanned.hasExpansion) reasons.add('shell expansion or globbing hides exact filesystem paths');
  if (scanned.hasGrouping) reasons.add('shell grouping or control syntax has path-dependent scope');
  if (scanned.unclosedQuote) reasons.add('unclosed quote makes filesystem paths ambiguous');

  for (let index = 0; index < scanned.segments.length; index++) {
    const segment = scanned.segments[index] as Segment;
    const cleanTokens = stripGroupDelims(tokenize(segment.text));
    const words = skipAssignments(cleanTokens);
    const root = commandName(words[0] ?? '');
    const args = words.slice(1);
    const nextSep = scanned.segments[index + 1]?.sep ?? '';
    const nextCwds = new Set(shellCwds);

    const opaqueReason = opaqueInvocationReason(cleanTokens);
    if (opaqueReason !== undefined) reasons.add(opaqueReason);

    for (const cwd of shellCwds) {
      for (const redirect of segment.redirects) {
        if (pathAnalysisReason(reasons, redirect, 'redirection')) continue;
        add(resolveShellPath(cwd, redirect), 'file', 'redirect');
      }

      let commandCwd = cwd;
      const possibleCommandCwds = new Set([cwd]);
      const consumed = new Set<number>();
      if (DIRECTORY_OPTION_ROOTS.has(root)) {
        for (let i = 0; i < args.length; i++) {
          const arg = args[i] as string;
          let directory: string | undefined;
          if (arg === '-C' || arg === '--directory') {
            directory = args[i + 1];
            consumed.add(i);
            consumed.add(i + 1);
            i++;
          } else {
            directory = DIRECTORY_OPTION_RE.exec(arg)?.[1] ?? ATTACHED_C_RE.exec(arg)?.[1];
            if (directory !== undefined) consumed.add(i);
          }
          if (directory === undefined) continue;
          if (pathAnalysisReason(reasons, directory, 'directory option')) continue;
          commandCwd = resolveShellPath(commandCwd, directory);
          possibleCommandCwds.add(commandCwd);
          add(commandCwd, 'directory', 'directory-option');
        }
      }

      if (root === 'cd' || root === 'pushd') {
        const directoryIndex = args.findIndex((arg) => arg !== '--' && !arg.startsWith('-'));
        const directory = directoryIndex < 0 ? undefined : args[directoryIndex];
        if (directoryIndex >= 0) consumed.add(directoryIndex);
        if (
          directory === undefined ||
          directory === '-' ||
          pathAnalysisReason(reasons, directory, root)
        ) {
          reasons.add(`'${root}' does not name one deterministic literal directory`);
        } else {
          const changed = resolveShellPath(cwd, directory);
          add(changed, 'directory', 'cd');
          if (nextSep !== '|' && nextSep !== '&') nextCwds.add(changed);
          if (nextSep === '&&') nextCwds.delete(cwd);
        }
      }

      const commandWord = words[0] ?? '';
      const commandPath =
        commandWord.includes('/') ||
        commandWord.startsWith('.') ||
        commandWord.startsWith('~')
          ? pathLikeArgument(commandWord)
          : undefined;
      if (
        commandPath !== undefined &&
        !pathAnalysisReason(reasons, commandPath, 'command path')
      ) {
        add(resolveShellPath(cwd, commandPath), 'unknown', 'argument');
      }
      for (let i = 0; i < args.length; i++) {
        if (consumed.has(i)) continue;
        const candidate = pathLikeArgument(args[i] as string);
        if (
          candidate === undefined ||
          segment.redirects.includes(candidate) ||
          pathAnalysisReason(reasons, candidate, 'path argument')
        ) {
          continue;
        }
        for (const possibleCwd of possibleCommandCwds) {
          add(resolveShellPath(possibleCwd, candidate), 'unknown', 'argument');
        }
      }
    }
    shellCwds = nextCwds;
  }

  return {
    targets: [...targets.values()],
    complete: reasons.size === 0,
    reasons: [...reasons],
  };
}

/**
 * analyzeBashCommand:拆分复合命令并产出审批 patterns 与 forceConfirm 判定。
 * denylist 命中 → { denied: true },调用方直接 deny 不进 approval(docs/07 §3.3)。
 */
export function analyzeBashCommand(command: string): BashAnalysis {
  const scanned = scan(command);
  const tokenized = scanned.segments.map((s) => tokenize(s.text));

  const deniedReason = checkDenylist(scanned.segments, tokenized);
  if (deniedReason !== undefined) return { denied: true, reason: deniedReason };

  const subcommands = scanned.segments.map((s) => s.text);
  const roots = tokenized.map((t) => rootOf(t));
  const patterns = roots.map((r) => `bash:${r} *`);
  const reasons: string[] = [];

  if (scanned.hasCmdSubst) reasons.push('command substitution $( … ) hides a nested command from static analysis');
  if (scanned.hasBacktick) reasons.push('backtick substitution ` … ` hides a nested command from static analysis');
  if (scanned.hasProcSubst) reasons.push('process substitution <( … ) / >( … ) hides a nested command from static analysis');
  const redirects = scanned.segments.flatMap((segment) => segment.redirects);
  for (const target of redirects) {
    if (SYSTEM_PATH_EXEMPT.has(target)) continue;
    if (!SYSTEM_PATH_PREFIXES.some((prefix) => target === prefix || target.startsWith(`${prefix}/`))) {
      continue;
    }
    reasons.push(`redirects output into system path '${target}'`);
  }
  for (const root of roots) {
    if (OPAQUE_ROOTS.has(root)) reasons.push(`'${root}' hands execution to its arguments, which static analysis cannot inspect`);
  }
  for (const tokens of tokenized) {
    const reason = opaqueInvocationReason(tokens);
    if (reason !== undefined && !reasons.includes(reason)) reasons.push(reason);
  }
  if (scanned.unclosedQuote) reasons.push('unclosed quote makes the command structure ambiguous');
  if (subcommands.length === 0) reasons.push('empty or unparseable command');

  return { denied: false, subcommands, patterns, forceConfirm: reasons.length > 0, reasons };
}
