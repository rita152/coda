// 内部协议:全项目的唯一公共语言(规格见 docs/03-internal-protocol.md)。
// 零运行时依赖(ESLint 规则 C 强制);禁止 import 任何 provider SDK。
export * from './messages.js';
export * from './provider.js';
export * from './agent-events.js';
export * from './event-stream.js';
export * from './strict-json.js';
export * from './identity.js';
export * from './runtime-ops.js';
export * from './runtime-events.js';
export * from './protocol-version.js';
