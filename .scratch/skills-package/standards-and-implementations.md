# Agent Skills：标准与客户端实现边界

状态：基于官方规范、官方客户端集成指南和固定提交的官方 reference validator 整理。
研究日期：2026-08-10

## 1. 来源范围与解释层级

- **Specification** 是 skill 目录和 `SKILL.md` 格式的规范性来源。
- **Client implementation guide** 是官方集成建议；其中的扫描位置、冲突处理、信任和激活方案是客户端策略，不会自动变成格式要求。
- **Reference validator** 用来说明固定提交中的官方严格校验行为；客户端指南另有意建议运行时兼容解析，因此“可加载”不等于“严格合规”。

来源：[Agent Skills specification](https://agentskills.io/specification)、[official client implementation guide](https://agentskills.io/client-implementation/adding-skills-support)、[official validator at `69ef37e`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/src/skills_ref/validator.py)

## 2. 规范包形态与六个 frontmatter 字段

一个 skill 是至少包含精确文件名 `SKILL.md` 的目录；该文件必须是 YAML frontmatter 后接 Markdown body。

| 字段 | 必需 | 约束 |
| --- | --- | --- |
| `name` | 是 | 1–64 字符；Unicode 小写字母数字字符和 `-`；不得以 `-` 开头或结尾，不得含 `--`，且必须与父目录名相同。 |
| `description` | 是 | 1–1024 字符且非空；应说明 skill 做什么、何时使用，并包含有助于任务匹配的关键词。 |
| `license` | 否 | 许可证名称，或对 skill 内附带许可证文件的引用；建议保持简短。 |
| `compatibility` | 否 | 提供时为 1–500 字符；只在有特定环境要求时使用，可说明目标环境、系统依赖或网络要求。 |
| `metadata` | 否 | string key → string value 的映射，用于规范未定义的附加属性；key 应足够独特以避免冲突。 |
| `allowed-tools` | 否 | 以空格分隔的预批准工具字符串；**实验性**，不同客户端的支持可能不同。 |

Markdown body 没有格式限制。来源：[specification — frontmatter, fields, and body](https://agentskills.io/specification)

## 3. Unicode 名称、NFKC 与扩展字段

固定提交的官方 validator 对 `name` 先执行 `strip()`，再做 Unicode **NFKC** 规范化；随后检查长度、小写、首尾连字符、连续连字符，以及每个字符是否为 `isalnum()` 或 `-`。父目录名也先做 NFKC，再与规范化后的 `name` 比较。因此实现严格校验时，应明确复制的是规范文字还是这个 reference 行为，并为兼容字符准备测试。

该 validator 的顶层 allowlist 只有六个标准字段，并把其余顶层字段报告为 `Unexpected fields in frontmatter`。规范指定的扩展位置是 `metadata`，而不是新增任意顶层 key；`metadata` 的值仍须满足 string → string。

来源：[official validator — `ALLOWED_FIELDS`, `_validate_name`, `_validate_metadata_fields`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/src/skills_ref/validator.py)、[specification — `metadata`](https://agentskills.io/specification)

## 4. 任意资源与 progressive disclosure

除必需的 `SKILL.md` 外，skill 目录可以包含**任意文件和目录**；`scripts/`、`references/`、`assets/` 只是常见资源的推荐组织方式，不是封闭清单。文件引用应相对 skill root，规范建议避免深层引用链。

规范的 progressive disclosure 分三层：

1. 启动时为所有 skills 只加载 `name` 与 `description`（约 100 tokens）。
2. skill 激活时加载完整 `SKILL.md` body（建议少于 5,000 tokens）。
3. scripts、references、assets 或其他资源仅在任务需要时按需读取。

主 `SKILL.md` 建议少于 500 行，细节移到资源文件；这些是内容预算建议，不是扫描器的强制安全上限。来源：[specification — optional directories, progressive disclosure, and file references](https://agentskills.io/specification)

## 5. 官方客户端指南：roots、优先级与兼容解析

Specification **不规定 skill roots**，只规定目录内部。官方客户端指南建议本地客户端至少考虑项目级与用户全局级，并为跨客户端互操作扫描：

- `<project>/.agents/skills/`
- `~/.agents/skills/`

客户端也可扫描自己的 native roots 或其他 scope。发现时寻找 skills root 的子目录及其中精确命名的 `SKILL.md`。指南给出的实用防失控示例是最大深度 4–6、最多 2,000 个目录。

同名冲突应确定性处理：官方指南称通行约定为 **project 覆盖 user**；同一 scope 内 first-found 或 last-found 均可，但必须一致，并应记录 shadow warning。

解析器指南刻意比严格规范宽松：目录名不匹配或 `name` 超过 64 字符时警告但尽量加载；`description` 缺失/为空或 YAML 完全不可解析时跳过并记录错误；可针对未引用、含冒号的常见 YAML 值做窄范围 fallback。诊断应保留并可向用户展示。

来源：[official client implementation guide — discovery, collisions, parsing, and lenient validation](https://agentskills.io/client-implementation/adding-skills-support)

## 6. 哪些仍是客户端策略

| 维度 | 这三份官方来源给出的状态 | 实现结论 |
| --- | --- | --- |
| Collision | 格式规范未规定；客户端指南建议确定性规则、project-over-user、同 scope 一致并告警。 | 由客户端定义并公开 precedence，不应伪装成格式合规要求。 |
| Trust | 格式规范未规定；指南建议仅在用户已信任项目目录时加载项目级 skills，以防仓库静默注入指令。 | project trust gate 是客户端责任。 |
| Limits | 规范给出正文 token/行数建议；指南给出扫描 depth/dir bounds 和大目录资源列表 cap 的建议。 | 文件字节、目录数、条目数、深度、并发和资源枚举上限均须由客户端定值。 |
| Symlinks | 规范和指南均未规定 follow/ignore、循环检测或 root containment。 | 必须由客户端显式选择并测试；不能声称某种 symlink 行为是标准要求。 |
| Activation | 规范只规定 progressive disclosure 时机；指南描述 model-driven file read、dedicated tool 和用户显式激活，具体语法由客户端决定。 | catalog、触发、注入包装、去重和 compaction 生命周期属于客户端。 |
| Security | 指南建议对项目 skill 做 trust check；dedicated activation tool 可执行客户端自定义检查。`allowed-tools` 仍只是实验字段。 | 这些来源不定义 Tool 执行行为；客户端必须自行决定信任、路径约束及资源/脚本处理方式。 |

客户端还应区分两条路径：兼容加载器按指南尽量读取并输出诊断；独立严格 validator 执行六字段、名称和目录一致性等规范约束。来源：[official client implementation guide — trust, activation, resources, and context lifecycle](https://agentskills.io/client-implementation/adding-skills-support)、[specification — validation and experimental `allowed-tools`](https://agentskills.io/specification)
