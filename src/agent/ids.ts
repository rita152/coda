// 消息 id 生成。测试断言用「归一化快照」(剥 id/timestamp),不依赖 id 的具体形态。

export function newMessageId(prefix: 'u' | 'tr' | 'a'): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
