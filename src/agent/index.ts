// M3/M4:Agent 类、runLoop 双层循环、steering/follow-up 队列、工具执行调度、
// 出站前 transform 层(convertContext)。规格见 docs/05-agent-loop.md 与 docs/06-steering-following.md。
// 本目录不 import 任何 provider(经 StreamFn 注入)、不 import 具体工具实现(仅允许 tools/types.ts)。
export {};
