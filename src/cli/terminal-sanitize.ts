// 终端不可信文本边界；不 import OpenTUI，供全屏、classic 与 stderr 路径共同使用。

/** 保留 tab/newline 的正文清洗。 */
export function sanitizeTerminalText(text: string): string {
  return Bun.stripANSI(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/** 状态、warning 与 terminal title 使用的安全单行文本。 */
export function sanitizeTerminalLine(text: string): string {
  return sanitizeTerminalText(text).replace(/[\t\n]+/g, ' ').trim();
}

export const sanitizeTerminalTitle = sanitizeTerminalLine;
