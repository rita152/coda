// 保守 bash 命令结构分析(规格见 docs/07-tools.md §3.3)。
// v1 不引 tree-sitter,用尊重单双引号与反斜杠转义的手写扫描器拆分复合命令。
// 原则:静态分析看不全的嵌套结构(命令替换 $()/反引号、进程替换 <()/>()、
// 重定向进系统路径、eval/exec/source 作 root)一律 forceConfirm 交给人,
// 且不许 allow_always 泛化;明确危险的模式(rm -rf / 等)直接 denied,不进 approval。

import path from 'node:path';

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

/** 重定向进这些前缀 → forceConfirm(">/etc、>/usr 等",docs/07 §3.3)。 */
const SYSTEM_PATH_PREFIXES = [
  '/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/sys', '/proc',
  '/lib', '/var', '/opt', '/root', '/System', '/Library',
];

/** 例外:写向丢弃/终端设备是无害且高频的(npm test > /dev/null),不升级。 */
const SYSTEM_PATH_EXEMPT = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);

/** 以这些 root 起头的子命令,执行语义整体转交给参数,静态分析失效 → forceConfirm。'.' 是 source 的别名。 */
const OPAQUE_ROOTS = new Set(['eval', 'exec', 'source', '.']);

/** curl|sh / wget|sh:管道右端的 shell 家族。 */
const SHELL_ROOTS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

interface Segment {
  text: string;
  /** 该子命令与前一个子命令之间的分隔符('' 表示首段;'|' 用于 curl|sh 检测)。 */
  sep: string;
}

interface ScanResult {
  segments: Segment[];
  hasCmdSubst: boolean;      // $( … )(双引号内同样生效)
  hasBacktick: boolean;      // ` … `(双引号内同样生效)
  hasProcSubst: boolean;     // <( … ) / >( … )
  systemRedirects: string[]; // 重定向目标中落在系统路径前缀内的
  unclosedQuote: boolean;
}

/** 顶层扫描:拆分复合命令(&& ; | & 与换行),引号内不拆;同时标记嵌套结构。 */
function scan(command: string): ScanResult {
  const segments: Segment[] = [];
  const systemRedirects = new Set<string>();   // Set:同一目标多次触发只记一条理由
  let hasCmdSubst = false;
  let hasBacktick = false;
  let hasProcSubst = false;
  let inSingle = false;
  let inDouble = false;
  let buf = '';
  let pendingSep = '';

  const flush = (sep: string): void => {
    const text = buf.trim();
    if (text !== '') segments.push({ text, sep: pendingSep });
    // 空段(如 '||' 被 '|'+'|' 消费后的间隙)不产生子命令,但分隔符要传递给下一个非空段
    pendingSep = sep;
    buf = '';
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
    if (SYSTEM_PATH_EXEMPT.has(target)) return;
    if (SYSTEM_PATH_PREFIXES.some((p) => target === p || target.startsWith(`${p}/`))) {
      systemRedirects.add(target);
    }
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
        buf += ch;
        continue;
      case '<':
        if (next === '(') hasProcSubst = true;
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
      default: buf += ch; continue;
    }
  }
  flush('');
  return {
    segments, hasCmdSubst, hasBacktick, hasProcSubst,
    systemRedirects: [...systemRedirects],
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

/** rm -rf 的致命目标:文件系统根或家目录(通配变体一并覆盖)。 */
const FATAL_RM_TARGET_RE = /^(?:\/\*?|~\/?\*?|\$HOME\/?\*?)$/;

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
      const fatalTarget = args.find((t) => !t.startsWith('-') && FATAL_RM_TARGET_RE.test(t));
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
  for (const target of scanned.systemRedirects) {
    reasons.push(`redirects output into system path '${target}'`);
  }
  for (const root of roots) {
    if (OPAQUE_ROOTS.has(root)) reasons.push(`'${root}' hands execution to its arguments, which static analysis cannot inspect`);
  }
  if (scanned.unclosedQuote) reasons.push('unclosed quote makes the command structure ambiguous');
  if (subcommands.length === 0) reasons.push('empty or unparseable command');

  return { denied: false, subcommands, patterns, forceConfirm: reasons.length > 0, reasons };
}
