# DeepSWE 并行评估接入研究

研究日期：2026-08-12。结论只使用 Datacurve、Pier、Hugging Face、AWS 和相关项目的官方仓库、发布元数据与文档；镜像摘要和体积是本日对官方 Public ECR 清单的实测值。

## 结论

- 此处的 **Deep-SWE 应解释为 Datacurve 的 DeepSWE 编程智能体评测集**，不是 2025 年发布的 `DeepSWE-Preview` 32B 模型。前者有 113 个 Harbor/Pier 任务和逐题容器，符合“下载数据集、并行运行 harness”的语境。
- 截至研究日，最新逻辑版本是 **DeepSWE v1.1**，但官方没有 `v1.1` Git tag；可复现评估应把官方仓库冻结到 commit **`435ee89ec2f2e2289f33b0da4f992f0b7b7266b9`**。唯一发布 tag `v1.0.0` 是旧版本，不能代替 v1.1。
- 官方 Hugging Face 数据集 `datacurve/deep-swe` 是需要授权的旧快照，时间早于 v1.1；当前评估数据应从上述 GitHub commit 取得。任务运行环境来自 **113 个逐题 Public ECR 镜像**，不是一张通用的 “DeepSWE image”。
- v1.1 依赖新的独立 verifier 和 `[[verifier.collect]]` 协议，应固定 **`datacurve-pier==0.3.1`**。Pier 支持 `-n/--n-concurrent 5`，但没有 Coda 内置 agent；`packages/evals` 必须提供自定义 Pier adapter，或完整复刻相同生命周期。
- 每题 agent 与 verifier 都声明 `no-network`。所谓“真实联网评估”只能开放 Coda 到模型端点 `https://opencode.ai/zen/go/v1` 的控制面出站；给代码工作区开放通用互联网会改变基准条件。
- v1.1 的 collect hook 只导出 `base_commit..HEAD` 的已提交 diff。Coda 结束前必须提交修改，否则 verifier 收不到补丁。

## 名称消歧

两个官方项目都曾使用 DeepSWE 名称：

1. [`agentica-org/DeepSWE-Preview`](https://huggingface.co/agentica-org/DeepSWE-Preview) 是 R2E-Gym 团队在 2025 年发布的 32B 编程智能体**模型**；[`R2E-Gym` 官方仓库](https://github.com/R2E-Gym/R2E-Gym) 将它描述为用强化学习训练、在 SWE-bench Verified 上评测的模型。它不是包含 113 个逐题镜像的任务集。
2. [`datacurve-ai/deep-swe`](https://github.com/datacurve-ai/deep-swe) 是 2026 年发布的编程智能体**评测集**，有 113 个跨 91 个仓库、五种语言的长时程任务，并直接采用 Harbor/Pier task 格式。[官方站点](https://deepswe.datacurve.ai/)和仓库 Quickstart 都围绕本地任务目录及隔离容器运行。

用户要求“数据集、镜像、并行 harness 评估和前 20 题”，所以后者是唯一与全部约束吻合的解释。

## 应冻结的版本

### DeepSWE

- v1.1 首次进入官方仓库的 commit 是 [`8cae5984d5dd0ee37445beff0e928dc10c331116`](https://github.com/datacurve-ai/deep-swe/commit/8cae5984d5dd0ee37445beff0e928dc10c331116)。
- 当前 [`tasks/dataset.toml`](https://github.com/datacurve-ai/deep-swe/blob/435ee89ec2f2e2289f33b0da4f992f0b7b7266b9/tasks/dataset.toml) 的数据集名是 `datacurve/deep-swe-1-1`。
- 研究日官方 `main` 的不可变 HEAD 是 [`435ee89ec2f2e2289f33b0da4f992f0b7b7266b9`](https://github.com/datacurve-ai/deep-swe/commit/435ee89ec2f2e2289f33b0da4f992f0b7b7266b9)，tree 为 `a040590c2b713f5c39c76cb39ef9d2997935984e`。该 commit 把 v1.1 更新为当前 Pier 使用的 `[[verifier.collect]]`。
- [官方 tags API](https://api.github.com/repos/datacurve-ai/deep-swe/tags) 只有 annotated `v1.0.0`，其 peeled commit 为 `c33fa70e68d11d85f9e58abcd5d78643705e916e`；没有 `v1.1` tag。因此运行锁应写 `version = v1.1` 与 `source_commit = 435ee…` 两个字段，不能只记录版本字符串。

### Pier

- [DeepSWE 当前 README](https://github.com/datacurve-ai/deep-swe/blob/435ee89ec2f2e2289f33b0da4f992f0b7b7266b9/README.md) 要求使用高于 0.3.0 的 Pier，以支持独立 verifier 和 collect hook。
- 研究日最新正式版是 [`datacurve-pier 0.3.1`](https://pypi.org/project/datacurve-pier/0.3.1/)，要求 Python >=3.12；对应源码 commit/tag 为 [`df89f994623a0a6a57229103b6fe910766693c30`](https://github.com/datacurve-ai/pier/tree/df89f994623a0a6a57229103b6fe910766693c30)。
- 供应链锁可附带 PyPI 官方元数据中的 SHA-256：wheel `6986b3cb5f66aada5edcc9f045cdf62d19f66b95ff99c706ec8e835981ae1`，sdist `f0ce5b676f3fa6e0ace71c932372ca605de8368efc738116e0cc6cf8c58aec78`。

### 为什么不以 Hugging Face 快照为准

[`datacurve/deep-swe` 的 Hugging Face 官方 API](https://huggingface.co/api/datasets/datacurve/deep-swe) 在研究日返回 revision `6d6f134460c137e24c6bb7e1e69954116ea9dbb3`、`lastModified = 2026-06-02T19:31:16Z` 和 `gated = auto`。它早于 2026-06-14 的 v1.1 commit，更早于当前 2026-08-06 的官方 GitHub HEAD；未接受 gate 的任务文件请求还会返回 401。因此它不能代表“现有最新版本”。官方 GitHub clone 是 DeepSWE README 自己给出的当前获取方式。

## 任务、隔离和评分契约

冻结 commit 下共有 113 个 `task.toml`：TypeScript 35、Go 34、Python 34、JavaScript 5、Rust 5。全部使用 `schema_version = "1.3"`。以官方的 [`abs-module-cache-flags/task.toml`](https://github.com/datacurve-ai/deep-swe/blob/435ee89ec2f2e2289f33b0da4f992f0b7b7266b9/tasks/abs-module-cache-flags/task.toml) 为代表，每题包含：

- `instruction.md`：唯一应暴露给 agent 的题面；
- `environment/`：预构建镜像不可用时的 Dockerfile/复现材料；
- `tests/`：隐藏 verifier、`test.patch`、grader 配置与测试入口；
- `solution/`：gold patch/solve script，绝不能让 agent 读取。

共同运行约束如下：

| 阶段 | 网络 | 超时 | 资源声明 |
| --- | --- | --- | --- |
| agent | `no-network` | 5400 秒 | 2 CPU、8192 MB RAM、20480 MB storage、0 GPU |
| verifier | `no-network`、独立环境 | 1800 秒 | 2 CPU、8192 MB RAM、20480 MB storage |
| environment build | 取决于预构建镜像/构建源 | 1800 秒 | 同题配置 |
| collect hook | agent 环境内 | 300 秒 | 导出模型补丁 |

collect hook 的核心语义是：

```bash
git diff --binary <base_commit> HEAD > /logs/artifacts/model.patch
```

所以 adapter 必须让 Coda 在 `/app` 工作，并在结束前执行等价提交：

```bash
git -C /app add -A
git -C /app -c user.name=coda -c user.email=coda@local \
  commit -m 'DeepSWE submission'
```

“没有改动”需要作为显式试次结果记录，不能把提交失败悄悄当成成功。verifier 会在新的干净镜像中只应用 `model.patch` 与隐藏 `test.patch`；不能在 agent 已修改的容器里直接评分。

官方 [`tests/grader.py`](https://github.com/datacurve-ai/deep-swe/blob/435ee89ec2f2e2289f33b0da4f992f0b7b7266b9/tasks/abs-module-cache-flags/tests/grader.py) 生成二元 `reward`：至少存在一个 fail-to-pass 测试、全部 fail-to-pass 通过、且没有 pass-to-pass 回归时才为 1。还会输出 `f2p_total/passed`、`p2p_total/passed`、`f2p`、`p2p`、`partial`，应用补丁失败时可有 `apply_failed`。因此优化不能只看最终 reward；应同时聚合 patch apply、F2P、P2P、运行异常和 token/时长指标。

## 镜像和 esp32 主机前提

每题指向一个预构建镜像，统一前缀为：

```text
public.ecr.aws/d3j8x8q7/swe-bench-202605:<external-id>-v1.1
```

本日检查 113 个 tag 均可从 Public ECR 读取；当前 manifest 的 config 是 `linux/amd64`，不是 multi-arch manifest。`esp32` 因此应满足 `uname -m = x86_64`。ARM64 仿真既慢又会改变性能可比性。

[AWS 官方文档](https://docs.aws.amazon.com/AmazonECR/latest/public/docker-pull-ecr-image.html)允许 public repository 匿名拉取；[官方配额](https://docs.aws.amazon.com/AmazonECR/latest/public/public-service-quotas.html)为匿名 1 pull/s、认证 10 pulls/s，且匿名传输上限为 500 GB/月。并发预拉时应限速/重试，或使用经过授权的 ECR Public 登录；不需要为数据集本身提供私有 registry 凭据。

5 个并发任务的名义 agent 资源预算是 10 CPU、40 GiB RAM、100 GiB storage allocation，另需 Docker daemon、verifier 和镜像缓存余量。前 20 题镜像逐镜像压缩层大小之和实测约 17.82 GiB；按 layer digest 去重后的联合下载量约 4.44 GiB。Docker 实际会复用公共层，这些数值只是 2026-08-12 的 registry 观测值，不是上游承诺。

## “前 20 题”的不可变选择与镜像锁

Pier 0.3.1 的本地数据集枚举来自 `Path.iterdir()`；只传 `--n-tasks 20` 且不提供 seed 时，得到的是文件系统顺序，不是词典序。即使提供 seed，shuffle 的初始目录顺序也不适合作为跨主机的题集身份。因此本项目应把“前 20 题”定义为冻结 commit 下按 task id 升序的以下列表，并逐题传 `-i/--include-task-name`。

表中完整镜像名为 `public.ecr.aws/d3j8x8q7/swe-bench-202605:<tag>`；digest 是 2026-08-12 实际解析的 manifest digest。前两题共享相同 manifest，20 个 tag 共 19 个唯一 manifest。

| # | task id | tag | manifest digest | 压缩层 bytes（观测） |
| ---: | --- | --- | --- | ---: |
| 1 | `abs-module-cache-flags` | `kh75679ajj3b8dtd7se3h7z0a1833y6r-v1.1` | `sha256:3a4d47f5281269305343c83729836ac2f3172811aee72681e472a4196178eda1` | 839606281 |
| 2 | `abs-stepped-slices` | `kh7d5m4ed35zfp7gyhx7wdahed82yw72-v1.1` | `sha256:3a4d47f5281269305343c83729836ac2f3172811aee72681e472a4196178eda1` | 839606281 |
| 3 | `actionlint-action-pinning-lint` | `kh79dnvkvq8j9bs22ededmsc79823akj-v1.1` | `sha256:522a6e93a31656d03cc79474dafc5542bb27109051914d5566d7d29789c2a1a6` | 778516131 |
| 4 | `adaptix-name-mapping-aliases` | `kh73dq4n55jdxasppe6jjmth4183d47n-v1.1` | `sha256:528654670f3c591e6491fc6fa01a0b8905bc8dee1b0557c5e76231bcc206f8fe` | 788210390 |
| 5 | `aiomonitor-task-snapshots-diff` | `kh75rc2q0zhmsqwk7wewfwwtrx830v2n-v1.1` | `sha256:e0c8b4e4044d5831693b4f6a6da483b255a889b71376574fba9e3c93d36ceb7c` | 815643745 |
| 6 | `anko-default-function-arguments` | `kh7fj3hc92zehtc8azrm32xzb182w9dr-v1.1` | `sha256:31c8dce39317314800d1200610475ba27b98c71350d524d25e7df71d80c5752a` | 769437731 |
| 7 | `anko-typed-variable-bindings` | `kh79betfed7ets4an20cr4j57182y9wt-v1.1` | `sha256:4fb704fd8dff600f6d028c20ae4aca5e1261968bb615bb41c01a111dd371255b` | 785931047 |
| 8 | `arcane-drift-detection-baselines` | `kh70nj38qyatmsmj1d5zh57j25820vrx-v1.1` | `sha256:1d4ad8d6deb37c92a9bbb550cf3cc127f916e340f35f29b72948ccb571197c42` | 2149575268 |
| 9 | `arktype-json-schema-refs-dependencies` | `kh771gpr8crkjsnt9pj81bafgs8229em-v1.1` | `sha256:e0b0410d828b816474cfb89a448c448f15cf7d617c3fbddfacd45a1c1b232ef9` | 1052825340 |
| 10 | `awilix-async-container-initialization` | `kh70bg8gy4xks4eyh1s71ecmk9822p9c-v1.1` | `sha256:748294a8ece567691f0a628d03c3531024d9f5e1acd13d5c6dd1ecba490831e6` | 819273434 |
| 11 | `bandit-incremental-cache-control` | `kh7drfg2vkvdvfh9xx0nfd5pz9821xr7-v1.1` | `sha256:f22b38f03dfbe2ca76f5019a1ef94953f700d51312fe47693ecba7d18f544d94` | 776343776 |
| 12 | `bandit-interprocedural-taint-checks` | `kh77yap0nc4zwm5bysc954xbr182tptg-v1.1` | `sha256:7207179b09db76a8a3864b9e69c5fdf10e0d41a5bba242854216f18aa90ac7b1` | 775099533 |
| 13 | `bandit-structured-nosec-directives` | `kh757d8ggvnfaszv8zcav3msy982ma7f-v1.1` | `sha256:2f6978cf88228baa0d3323e4f139ee222f5886218d86ca1d327bcae3711f4b6a` | 780372124 |
| 14 | `boa-hierarchical-evaluation-cancellation` | `kh71kat2v58yys3pnyybkgycax832vj2-v1.1` | `sha256:9ab97da2ebb88bc71beeb2434d198d4adca6e1abe14f45d52250666249fb7a1e` | 2144176677 |
| 15 | `cattrs-partial-structuring-recovery` | `kh7f7cahc5ddm1qzpxz13kpmrh8235pc-v1.1` | `sha256:443a3534dab64283e5a9dedf3b7ac8867ed7d5dabcde39bc39c77ab5a909176a` | 760533976 |
| 16 | `clack-async-autocomplete-options` | `kh78c5dwwna57y757p2y5ktw79836dnv-v1.1` | `sha256:32a72ef7d4a9d3ae8937aef9c42e18166284c817c8edf137d66772e4f34abf74` | 853800060 |
| 17 | `claude-code-by-agents-recursive-delegation` | `kh734ehfw2s3bztf7pzc9xf3x18212bs-v1.1` | `sha256:4baf10f1e66f9ab4d82991e538c13620c387c862974ec36dd5bd5d52f635920e` | 960086494 |
| 18 | `cliffy-config-file-parsing` | `kh72088pg9vkc6peacnkc35yy9832jff-v1.1` | `sha256:0a8dd8f1270ec4bb88efadad3021762e1d07274f686276c8a484d26a00bd91b5` | 835983308 |
| 19 | `csstree-shorthand-expansion-compression` | `kh72qraccnjwdet6ynagsccr4x82y65c-v1.1` | `sha256:df2cc59d679c908f8f13f68fc59231a5d6f0c2bcec4b7b26fdf9489eb824a8b2` | 781948578 |
| 20 | `dasel-html-document-format` | `kh7c7rrg3zke74w7068nawak9x82t6am-v1.1` | `sha256:0529d5659b2d11ee76e3ba13a877043b3e43bcf123f36a840f9cf5b5ade09b78` | 825094985 |

预拉时应同时使用 tag 与 digest，让 registry 验证二者仍一致：

```bash
while IFS=$'\t' read -r task image digest bytes; do
  docker pull "${image}@${digest}"
done < deep-swe-v1.1-first20-images.tsv
```

## Coda adapter 的最小运行契约

[Pier 0.3.1 README](https://github.com/datacurve-ai/pier/blob/df89f994623a0a6a57229103b6fe910766693c30/README.md)列出的内置 agents 不含 Coda；`--agent opencode` 评测的是 OpenCode harness，不能用来回答 Coda 性能问题。[固定版本 CLI 源码](https://github.com/datacurve-ai/pier/blob/df89f994623a0a6a57229103b6fe910766693c30/src/pier/cli/jobs.py)提供 `--agent-import-path module.path:ClassName`、`-n/--n-concurrent` 与可重复的 `-i/--include-task-name`。因此 adapter 至少要完成：

1. 在 agent 容器里安装/提供当前 Coda CLI，不把 `tests/`、`solution/` 或完整 DeepSWE checkout 挂载进去；
2. 把 `instruction.md` 作为 prompt，在 `/app` 执行一次非交互 Coda；
3. 只允许 provider 域名出站，并把 Coda 的轨迹、stdout/stderr、退出码、耗时和 token 元数据写到 trial 结果；
4. 结束前提交工作区修改，使 collect hook 能导出 patch；
5. 让 Pier 在全新 verifier 环境中收集评分，保留全部官方 artifacts。

本仓库 provider 配置 [`packages/ai/src/providers/opencode-go.ts`](../../packages/ai/src/providers/opencode-go.ts) 使用环境变量 `OPENCODE_API_KEY`；模型目录 [`packages/ai/src/providers/data/opencode-go.json`](../../packages/ai/src/providers/data/opencode-go.json) 将 `deepseek-v4-flash` 指向 `https://opencode.ai/zen/go/v1`，并声明 `reasoning = true`、`thinking.max = "max"`。当前 Coda 对应命令是：

```bash
coda --print --json \
  --model opencode-go/deepseek-v4-flash \
  --reasoning max \
  --workspace /app \
  '<instruction>'
```

这里 `danger-full-access` 只表示 Coda 在**外层任务容器内**可以编辑 `/app`；网络边界仍必须由 Pier/Docker 外层强制。自定义 adapter 的 allowlist 应只加入从 provider base URL 派生的 `opencode.ai`，不能开启 general internet。

这里还有一个必须在付费批量运行前验证的代理兼容点：Pier 的 [Docker filtered-egress 实现](https://github.com/datacurve-ai/pier/blob/df89f994623a0a6a57229103b6fe910766693c30/src/pier/environments/agent_setup.py)通过 `HTTP_PROXY`/`HTTPS_PROXY` 把 agent 流量送入 allowlist proxy；当前 Coda 则在 [`node-application.ts`](../../packages/coding-agent/src/node-application.ts) 中直接使用 `globalThis.fetch`，仓库中没有显式配置 Undici proxy dispatcher。不能假设目标 Node 运行时一定会自动采用这些环境变量。runner 应先做一次不计分的最小 API smoke test；若请求绕过 proxy 或失败，应在 Coda/adapter 侧显式接入环境代理，同时保持 Docker `no-network`，而不是放宽为通用互联网。

本机凭据只能以 `OPENCODE_API_KEY` 的短生命周期环境注入远端 agent 进程。macOS 本地环境/Keychain 不会自动出现在 `esp32`；不得把 key 放进 SSH 命令参数、Pier YAML/JSON、Git、日志或 trial artifact，也不得在诊断输出中回显。adapter/runner 需要专门的非持久化 secret 通道。

概念上的 Pier 启动形态如下；`<coda-adapter-module>:<CodaAgent>` 必须先由 `packages/evals` 实现，20 个 `-i` 参数应从上述冻结清单生成：

```bash
pier run \
  -p /srv/deep-swe/tasks \
  --agent-import-path '<coda-adapter-module>:<CodaAgent>' \
  --model opencode-go/deepseek-v4-flash \
  --env docker \
  --n-concurrent 5 \
  -i abs-module-cache-flags \
  -i abs-stepped-slices \
  ...
```

不要用 `--n-tasks 20` 替代显式清单，也不要以 `--agent opencode` 代替 Coda adapter。

## esp32 下载与预检命令

下列步骤不携带任何 provider 凭据，可在 x86_64 Linux 的 `esp32` 上执行：

```bash
DEEPSWE_REV=435ee89ec2f2e2289f33b0da4f992f0b7b7266b9

git clone https://github.com/datacurve-ai/deep-swe.git /srv/deep-swe
git -C /srv/deep-swe checkout --detach "$DEEPSWE_REV"
test "$(git -C /srv/deep-swe rev-parse HEAD)" = "$DEEPSWE_REV"

uv tool install 'datacurve-pier==0.3.1'
docker version
docker compose version
test "$(uname -m)" = x86_64
```

下载阶段需要访问 GitHub、PyPI/uv 和 `public.ecr.aws`。若强制从每题 Dockerfile 构建，还可能访问上游 Git 和语言包 registry；优先使用已锁定的官方预构建镜像可避免这类额外网络依赖。真正运行 agent/verifier 时则恢复任务声明的 no-network，仅对 Coda 安装/推理阶段采用最小 provider allowlist。

## 结果收集与五轮优化

Pier 0.3.1 把 job 级 `result.json`、`config.json`、`lock.json`、`job.log` 放在 `jobs/<job>/`，每个 trial 目录还包含 `result.json`、`agent/trajectory.json`、`verifier/reward.json`、`ctrf.json`、`test-stdout.txt`、`run.log` 和 `artifacts/model.patch`。这组原始文件应逐轮只追加保存；每轮另写一个不含 secret 的 run lock，至少记录：

- DeepSWE version、source commit、20 个 task id、image tag+digest；
- Pier/Coda commit 和依赖锁、模型全名、reasoning effort、并发数；
- provider endpoint 标识、开始/结束时间、主机 CPU/RAM/Docker 版本；
- 每题退出状态、patch/apply 状态、reward、F2P/P2P、partial、时长、tokens/调用数；
- 从上一轮到本轮的 harness 变更及其假设，不能包含题目 gold/test 内容。

五轮都反复用同一 20 题来挑选改动，会把这 20 题从“评估集”变成“开发集”，得到的是开发回归结果而非无偏 benchmark。Hugging Face gate 也明确把它定位为 held-out evaluation data。较可信的做法是：冻结上述 20 题作最终 holdout，用其余公开任务的一个不重叠子集调优；若业务上必须按原要求反复跑这 20 题，则应如实标为 `development rounds`，并在优化完成后用未参与选择的任务做一次最终测量。

## 许可与授权边界

- DeepSWE 根 [`LICENSE`](https://github.com/datacurve-ai/deep-swe/blob/435ee89ec2f2e2289f33b0da4f992f0b7b7266b9/LICENSE) 是 Apache-2.0，但 [`PROVENANCE.md`](https://github.com/datacurve-ai/deep-swe/blob/435ee89ec2f2e2289f33b0da4f992f0b7b7266b9/PROVENANCE.md) 明确说明：Datacurve 许可证只覆盖其原创任务规格、verifier 和策展内容，各上游项目代码继续受各自许可证约束。分发镜像、补丁或源码时仍需逐项目履约。
- Pier 自身采用 [Apache-2.0](https://github.com/datacurve-ai/pier/blob/df89f994623a0a6a57229103b6fe910766693c30/LICENSE)。
- Hugging Face 版本要求登录、共享联系信息并接受“仅用于评估”等 gate 条款；本方案不需要它，因为使用官方最新 GitHub 快照。但若未来下载 HF gated revision，必须使用有权 token 并遵守其页面条款。
- Public ECR 镜像允许匿名 pull；认证只影响限额和账户授权，不改变镜像中上游代码的许可证。
- `opencode-go` 推理需要用户已有的有效 `OPENCODE_API_KEY`，调用费用和服务条款由该 provider 账户承担；评测产物不得包含凭据。

## 主要一手来源

- [DeepSWE 官方仓库（固定 commit）](https://github.com/datacurve-ai/deep-swe/tree/435ee89ec2f2e2289f33b0da4f992f0b7b7266b9)
- [DeepSWE v1.1 数据集 manifest](https://github.com/datacurve-ai/deep-swe/blob/435ee89ec2f2e2289f33b0da4f992f0b7b7266b9/tasks/dataset.toml)
- [DeepSWE 当前 task.toml 示例](https://github.com/datacurve-ai/deep-swe/blob/435ee89ec2f2e2289f33b0da4f992f0b7b7266b9/tasks/abs-module-cache-flags/task.toml)
- [DeepSWE 官方 HF 数据集 API](https://huggingface.co/api/datasets/datacurve/deep-swe)
- [Pier 0.3.1 官方源码](https://github.com/datacurve-ai/pier/tree/df89f994623a0a6a57229103b6fe910766693c30)
- [Pier 0.3.1 PyPI 元数据](https://pypi.org/pypi/datacurve-pier/0.3.1/json)
- [AWS ECR Public pull 文档](https://docs.aws.amazon.com/AmazonECR/latest/public/docker-pull-ecr-image.html)与[配额](https://docs.aws.amazon.com/AmazonECR/latest/public/public-service-quotas.html)
- [DeepSWE-Preview 官方模型卡](https://huggingface.co/agentica-org/DeepSWE-Preview)与[R2E-Gym 官方仓库](https://github.com/R2E-Gym/R2E-Gym)
