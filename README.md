# coda

TypeScript 终端 coding agent:核心只认自研内部协议,OpenAI Chat Completions 被严格隔离在 adapter 内;支持 steering / follow-up 双队列消息注入;内置 read / ls / glob / grep / bash / edit / write / plan 工具集。

**完整实施计划见 [docs/README.md](docs/README.md)**(12 篇设计契约文档,先于代码撰写)。

## 开发

运行时与包管理器固定为 **Bun 1.3.14**。

```bash
bun install --frozen-lockfile
bun run check   # lint + typecheck + build + test
```

`bun.lock` 是唯一依赖锁文件；Bun 按 `os` / `cpu` 解析 `@vscode/ripgrep` 的平台 optional dependency，CI 会在 Linux 与 macOS 上验证二进制可用。

当前进度:M0 脚手架(见 [docs/11-roadmap.md](docs/11-roadmap.md) 里程碑详表)。

## 分层纪律

`src/protocol/` 零依赖;`openai` 包只允许出现在 `src/providers/openai-chat/`;`src/agent/` 不认识任何 provider 与具体工具。这些规则由 ESLint 机械强制([eslint.config.mjs](eslint.config.mjs)),并有自证测试([tests/boundaries.test.ts](tests/boundaries.test.ts))防止规则被静默删除。详见 [docs/02-architecture.md](docs/02-architecture.md)。
