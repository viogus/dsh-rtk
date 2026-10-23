# dsh-rtk

[![CI](https://github.com/viogus/dsh-rtk/actions/workflows/ci.yml/badge.svg)](https://github.com/viogus/dsh-rtk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@viogus/dsh-rtk)](https://www.npmjs.com/package/@viogus/dsh-rtk)
[![GitHub Release](https://img.shields.io/github/v/release/viogus/dsh-rtk)](https://github.com/viogus/dsh-rtk/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/viogus/dsh-rtk/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-339933?logo=nodedotjs)](https://nodejs.org/)

> 在 DeepSeek Harness（`dsh`）的 bash 执行器里，把符合条件的 shell 命令路由给 [rtk](https://github.com/rtk-ai/rtk)（Rust Token Killer）执行 —— 压缩工具输出、省 token、其余一概不变。

[English version](README.md)

> **提示：`workspace-write` 会话只有压缩，没有账本与备份。**
> 改写本身在所有模式下都生效。问题出在隔离：dsh 只允许写工作区、`/tmp` 与平台临时目录，
> 而 rtk 把 `history.db`、`recall.db` 与 `tee/` 放在 `~/Library/Application Support/rtk`
> —— 不在可写范围内。这些写入会被**静默**拒绝，于是 `rtk gain` 始终为空、也不会留下
> tee 备份。两种解法：运行
> [`scripts/allow-rtk-state-in-sandbox.mjs`](scripts/allow-rtk-state-in-sandbox.mjs)
> （`apply` 后重启 harness）只放开这一个目录；或把该会话切到 `danger-full-access`。
> 详见[沙箱会话](#沙箱会话workspace-write)。

---

## 目录

- [快速示例](#快速示例)
- [环境要求](#环境要求)
- [为什么需要它](#为什么需要它)
- [工作原理](#工作原理)
- [安装与启用](#安装与启用)
- [从 `@deeptrial/dsh-bash-rtk` 迁移](#从-deeptrialdsh-bash-rtk-迁移)
- [API / 配置](#api--配置)
  - [沙箱会话](#沙箱会话workspace-write)
  - [与其他省 token 插件的实测对比](#与其他省-token-插件的实测对比)
- [哪些命令会被路由](#哪些命令会被路由)
- [开发](#开发)
- [更新日志](#更新日志)
- [许可证](#许可证)

---

## 快速示例

插件在 `resolve()` 边界重写命令 —— 在实际执行之前：

| 输入 (`command`) | 解析后的输出 | 原因 |
|---|---|---|
| `git status` | `rtk git status` | rtk 有对应规则 |
| `ls -la` | `rtk ls -la` | rtk 同样路由 `ls` —— 与本插件的列表无关 |
| `tree` | `rtk tree` | rtk 1.0 新增 —— **无需本插件发版**即可生效 |
| `head -5 notes.txt` | `rtk read notes.txt --head-lines 5` | rtk 自己的非前缀式重写，原样采纳 |
| `git status \| grep x` | `rtk git status \| grep x` | rtk 只重写它认识的片段，其余原样保留 |
| `cd /tmp` | `cd /tmp` | rtk 拒绝改写 —— **恒等** |
| `git status`（无 rtk） | `git status` | 二进制缺失 —— **恒等回退** |

其余一切 —— 工作目录、超时、环境变量、退出码、沙箱隔离 —— 均原样继承。

## 环境要求

- **Node.js:** >= 20.0.0
- **rtk:** `rtk --version` 在 PATH 上退出码为 0（需单独安装，例如 `cargo install rtk`）
- **委托式设计所需的最低 rtk：** `0.25.0`（`rtk rewrite` 在该版本引入）；本说明的所有内容以 **`rtk 1.0.1`** 为验证基准，CI 每次推送都会重跑该验证。没有上界 —— 见[版本说明](#版本说明)。

## 为什么需要它

LLM agent 在冗长的工具输出上浪费大量 token（`git log`、`cargo build`、`pytest` 输出……）。`rtk` 已知道如何把这些输出压缩 30–90%。本插件把这套过滤接到 `dsh` 的 bash 执行器上，让每个符合条件的命令自动走 `rtk` —— **且对实际运行内容零语义改动**。

## 工作原理

```
model → dsh bash 工具 → RtkBashExecutor.resolve()
                              │
                              ▼
                      rtk rewrite <命令>
                              │
              ┌───────────────┴────────────────┐
          打印出重写结果                   什么都不打印
              │                                │
      原样执行该结果                    原样执行原命令
```

两道关卡决定路由（见 [`src/wrap.ts`](src/wrap.ts) 与 [`src/rtk.ts`](src/rtk.ts)）：

1. **映射表属于 rtk，不属于本插件。** `resolve()` 会启动 `rtk rewrite <命令>` 并采纳它在 stdout 上打印的内容。插件不维护任何命令表：当 rtk 新增规则时，升级 rtk 就等于升级插件的覆盖面，插件本身无需发版。退出码被刻意忽略 —— rtk 用它表达自己面向 Claude Code 的权限协议，而这里没有对应物。
2. **成本过滤器，而非策略。** 命令会按顶层控制符（`&&`、`||`、`;`、`|`、`|&`、`&`、换行）切分，再逐段检查首词：shell 关键字与 `cd`、`echo`、`export` 等日常内建命令本身不构成可路由段。只有当**每一段**都是这类内建命令时，整条命令才会被跳过 —— `cd repo && cargo test` 会交给 rtk，并返回 `cd repo && rtk cargo test`。任何无法被证明「绝不被改写」的命令都会交给 rtk 判断。若 `PATH` 上找不到 `rtk` 二进制，整个变换就是**恒等**：部署行为与原始执行器完全一致。

rtk 是**按词法切分**命令的，而不是整串匹配：它只重写自己认识的片段，管道、`&&`/`;`、重定向与命令替换都逐字节保留。因此复合命令会被路由，而不是被跳过。

### 版本说明

本插件**不捆绑、不锁定 rtk 版本**。构造执行器时会探测 `PATH` 上的 `rtk --version`（见 [`src/rtk.ts`](src/rtk.ts) 的 `probeRtkAvailable`），随后就让这同一个二进制去做重写。因此：

- **rtk 发布新版本时**，任何在本地升级了 `rtk` 的用户会自动获得新规则**乃至新命令** —— 无需更新本插件。
- 本插件版本（本仓库）与 rtk 版本**相互独立**，请勿混为一谈。本说明给出的是测试所基于的*最低* rtk 版本，而非锁步版本号。
- `RTK_BIN` 可覆盖二进制路径，`RTK_TIMEOUT_MS` 可覆盖单次重写超时（默认 2000 ms）；超时按「无重写」处理。

> **要求：** `rtk` 在 `PATH` 上（`rtk --version` 退出码为 0）。插件**不会**安装或管理 rtk —— **你必须自行安装并更新 rtk**（例如 `cargo install rtk` 或下载发布二进制）。当 rtk 缺失时，插件静默退化为透传。

### 兼容性与版本对齐

本插件依赖 `@deepseek-ai/dsh-*` 系列包，DeepSeek Harness 将它们与 `dsh` 聚合包**分开**发布到 npm。这些子包（以及 `dsh` 本身）都以**预发布**形式（`x.y.z-rc.n`）发布。在朴素的 node-semver 语义下，只有当某比较符与候选版本同 `major.minor.patch` 元组且自身也带预发布标签时，预发布版本才满足范围 —— 所以上界写成 `<0.3.0-0` 而不是 `<0.3.0`。运行时的 loader 比这更宽松：`dsh-app-boot` 用 `includePrerelease: true` 校验 `engines.dsh` 与插件的 dsh peer 范围，因此这些 peer 范围可匹配所有 `0.1.x`/`0.2.x` 预发布。但 peer 范围只是提示：真正决定 bundle 是否挂载的是下面写的 `engines.dsh` 门禁。

实际范围（见 `package.json` 的 `peerDependencies`）为：

```
"@deepseek-ai/cordis":           "~4.0.4"
"@deepseek-ai/dsh-bash-local":   ">=0.0.1-rc.1 <0.3.0-0"
"@deepseek-ai/dsh-bash-sandbox": ">=0.0.1-rc.1 <0.3.0-0"
"@deepseek-ai/dsh-shell":        ">=0.0.1-rc.1 <0.3.0-0"
```

四项 peer 都在 `peerDependenciesMeta` 中标记为 `optional`，因此在它们缺失时插件仍可安装并加载（此时退化为透传）。注意 cordis 一项：`dsh` 在运行时注入容器，但注入的是**带 scope** 的 `@deepseek-ai/cordis` —— 也正是本插件为获取 `Context`/`Service` 类型而 import 的包。npm 上不带 scope 的 `cordis` 是**另一条更旧的线**（`4.0.0-rc.11`），此处不可使用。

本`package.json` 与 `dsh.plugin.json` 声明同一个目标范围：

```json
"engines": { "dsh": ">=0.2.1-rc.1 <0.3.0-0" }
```

`dsh.plugin.json` 另外带 `"dshTarget": "0.2.1-rc.1"`，即本版本实测过的运行时。范围同时写进
`package.json` 是因为 `dsh-app-boot` 决定是否挂载 bundle 时读的是它；`dsh.plugin.json` 则是
插件工具界面展示的那份。

### 插件版本与 dsh 版本的对应关系

插件的 **major.minor 跟随 `dsh` 的 major.minor**；patch 归插件自己，用于纯插件修复。
`dsh` 开新 minor 线时插件跟着开新 minor（即使代码没变），这样配对关系一眼可见：

| 插件版本 | dsh 目标范围 | 实测基准 |
| --- | --- | --- |
| `0.2.3` | `>=0.2.1-rc.1 <0.3.0-0` | `0.2.1-rc.1` |
| `0.2.0` – `0.2.2` | `>=0.1.0-rc.6 <0.3.0-0` | `0.2.0-rc.2` |

`0.2.3` 起**故意不再放行** `0.1.x` 与 `0.2.0-rc.2`：loader 会拒绝在旧核心上挂载，
而不是挂上一个没验过的组合。仍停留在 `0.2.0-rc.2` 的话请锁 `0.2.2`。

> **已知的版本错位：** `dsh`（聚合包，即 `npx @deepseek-ai/dsh` 安装的）与其 `@deepseek-ai/dsh-*` 子包处于**独立的 semver 轨道**。上述范围锁定到*已发布*的子包版本，因此普通 `dsh plugin add` 能干净解析。跟进匹配更新请关注 [releases](https://github.com/viogus/dsh-rtk/releases)。

## 安装与启用

插件**默认禁用** —— 安装后不会生效，需手动
开启。

```sh
# 1) 从 npm registry 安装（已发布为 @viogus/dsh-rtk）
dsh plugin --profile web add "@viogus/dsh-rtk"

# 2) 从本地 checkout 安装
dsh plugin --profile web add "<path-to-this-dir>"

# 3) 或直接用最新 GitHub release tarball 安装（无需本地 clone）
dsh plugin --profile web add \
  "https://github.com/viogus/dsh-rtk/releases/latest/download/dsh-rtk-latest.tgz"

# 通过可选 overlay 启用 —— 在你的 profile 的 cordis.patch.yml 中添加：
#   - id: bash-sandbox
#     disabled: true
#   - id: bash-rtk
#     disabled: false

dsh web   # 重启以生效
```

内置的 overlay 片段位于 [`cordis.patch.yml`](cordis.patch.yml)。它会用 `RtkSandboxBashExecutor`（保留文件隔离）替换原生的沙箱执行器，并保留非隔离的 `RtkBashExecutor` 供 `danger-full-access` 场景使用。

## 从 `@deeptrial/dsh-bash-rtk` 迁移


> **不要同时安装本包与上游 `dsh-bash-rtk`。** 两者注册的是同一个 `ctx.shell` 服务，
> 后加载的那个无法接管，最终由加载顺序决定谁生效。请先移除旧包 —— 下面的命令即按此顺序。

本仓库是 [`DeepTrial/dsh-bash-rtk`](https://github.com/DeepTrial/dsh-bash-rtk) 的 **fork，并更名为 `dsh-rtk`**，同时被改造成把命令覆盖面**委托给 `rtk`**，而不再维护手写映射表。旧包是另一个 npm 包（`@deeptrial/dsh-bash-rtk`，0.1.x），**不会**被本包自动更新 —— 切换是一次手动、单条命令的变更：

```sh
dsh plugin --profile web remove dsh-bash-rtk     # 或你注册时使用的插件 id
dsh plugin --profile web add "@viogus/dsh-rtk"
dsh web
```

对你而言，变化如下：

- **覆盖面不再漂移。** 0.1.x 只路由固定的 41 个可执行文件，rtk 每学会一个新命令就得发一次版（旧仓库历史里还有一次提交先把 `lit`/`make` 加进白名单、后来又撤掉，等 rtk 合入）。0.2.0 直接询问 `rtk rewrite`，所以 `ls`、`tree`、`head`、`oc`、`bun`、`ast-grep` 等在你升级 rtk 的当天就能用。
- **配置字段 `rtkAvailable` 含义不变**（强制开启/关闭路由）；新增了一个字段 [`rtkRewrite`](#api--配置)。
- **其余 API 无变化。** 两个执行器仍然分别继承原生的 `LocalBashExecutor` / `SandboxBashExecutor`，因此工作目录、超时、输出落盘与沙箱隔离都未受影响。
- **overlay 的 name 变了**：仍然是 `bash-rtk` 这个 id，但注册它的包从旧包换成了本包 —— 如果你曾把 `name:` 复制进自己的 profile patch，请改为 `@viogus/dsh-rtk`。

## API / 配置

两个执行器均接受与其原生对应物（`LocalBashExecutor` / `SandboxBashExecutor`）相同的基础配置，外加两个可选字段：

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `rtkAvailable` | `boolean` | `probeRtkAvailable()` 结果 | 强制启用或禁用 rtk 路由。适用于测试或二进制路径非标准的部署环境。 |
| `rtkRewrite` | `boolean` | `true` | 仍然注册执行器，但跳过 `rtk rewrite` 调用，使 `resolve()` 成为纯透传。 |

其余选项 —— `cwd`、`timeoutMs`、`graceMs` 等 —— 均原样继承自上游执行器。

`RtkSandboxBashExecutor` 继承原生 `SandboxBashExecutor`，因此隔离机制、其注入列表与结果装饰都是继承而来而非重新实现；重写发生在 `resolve()` 中，早于 `execute()` 读取 `spec.command`，也就是说交给 `ctx.sandbox.confine` 的 argv 已经是经 rtk 路由后的命令。

## 哪些命令会被路由

取决于你所安装的 rtk 会路由什么。可直接运行 `rtk rewrite "<命令>"` 询问它，或见 [rtk 命令参考](https://github.com/rtk-ai/rtk#supported-ecosystems) 中持续维护的列表 —— 本插件并不镜像该列表。作为过去手写列表常常漏掉的范围示例，rtk 1.0.1 已经能路由 `ls`、`tree`、`head`、`read`、`diff`、`wc`、`grep`、`rg`、`ast-grep`、`oc`、`bun`、`bunx`、`lint`、`prettier`、`format`、`ctest`，以及更早的那批开发工具。

复合命令同样会被路由，因为 rtk 是分段重写的；过滤器现在检查每一段而非只看首词，所以 `cd repo && cargo test` 不会被误判成单纯的 `cd`。只有当一条命令的所有段都是「rtk 永不改写」的词（shell 关键字与日常内建命令）时才跳过，以省下一次子进程开销而不损失覆盖率。

## 沙箱会话（`workspace-write`）

在 `workspace-write` 下，dsh 用 Seatbelt 约束每条 shell 命令：除工作区、`/tmp`
与平台临时目录之外的写入一律拒绝。rtk 的状态目录在
`~/Library/Application Support/rtk`，不在可写根内 —— 于是它的写入被**静默**拒绝。
压缩照常工作，但节省账本、recall 数据库与 `tee/` 备份都不会产生。

两种解法：

```sh
# A) 保留隔离，只给 rtk 状态目录开一条定向可写根
node scripts/allow-rtk-state-in-sandbox.mjs apply    # 之后重启 harness
node scripts/allow-rtk-state-in-sandbox.mjs status    # app 升级后检查
node scripts/allow-rtk-state-in-sandbox.mjs revert    # 撤销

# B) 把该会话切到 danger-full-access（不做隔离，也不需要打补丁）
```

脚本只改 `@deepseek-ai/dsh-sandbox-local` 里的一个函数（Seatbelt profile 构建），
会就地备份原文件、遇到不认识的代码形状则拒绝改动，最后跑一次真实的
`sandbox-exec` 写入测试（必须在 `history.db` 里看到新行）。它**不会**动进程内的
文件围栏：`read` / `write` / `edit` 仍然被限制在工作区内，放开的只是 shell 命令
对 rtk 自己状态目录的写入。

app 升级可能重装该包并抹掉补丁；`status` 会发现，`apply` 可重新打上。压缩功能
本身不依赖这里任何一步。

## 与其他省 token 插件的实测对比

同一批任务上，`dsh-rtk`、`dsh-token-saver` 1.0.4 与 `dsh-ops` 0.4.1 的会话总 token 对比、
各自失效场景与复现方法，见 [docs/token-saving-plugins.zh.md](docs/token-saving-plugins.zh.md)。

## 开发

```sh
# 1. 克隆插件及其依赖的 harness
git clone https://github.com/viogus/dsh-rtk.git
git clone https://github.com/deepseek-ai/deepseek-harness.git

# 2. 安装 harness 依赖并构建插件所链接的库
cd deepseek-harness && pnpm install && pnpm build:lib:host

# 3. 安装插件依赖并运行检查
cd ../dsh-rtk && pnpm install --ignore-scripts
pnpm run check        # 类型检查 + 测试 + 构建
pnpm run test         # 仅测试
pnpm run typecheck    # 仅 tsc
```

`devDependencies` 通过 `link:` 指向本地 `deepseek-harness` 源码仓；测试需在该 workspace 内运行（`@deepseek-ai/dsh-*` 包必须可解析）。如果只改重写逻辑，依赖装好之后测试是自足的 —— 首次 `pnpm install` 之后无需再构建 harness 即可运行 `pnpm run test`。

单元测试通过 `RTK_BIN` 注入一个替身 rtk 二进制，因此不依赖真实的 rtk。若还要针对你本机实际安装的 rtk 证明一致性：

```sh
pnpm run test:integration    # 需要 PATH 上有真实 rtk（或设置 RTK_INTEGRATION_BIN）
```

未提供二进制时该套件会被跳过，因此普通的 `pnpm run test` 在没有 rtk 的环境中依然全绿；`scripts/resolve-rtk.mjs` 会把 PATH 上的名字解析成绝对路径，避免跳过逻辑悄悄掩盖「二进制其实不存在」。CI 每次推送都会同时运行两个 job —— 用替身二进制的契约测试，以及下载固定版本 rtk 的 `real-rtk` 真实一致性测试。

## 更新日志

发布说明见 [`CHANGELOG.md`](CHANGELOG.md)（Keep a Changelog 格式）。0.2.0 条目记录了委托式重写、fork 与更名、促成「双基类」设计的沙箱隔离回归，以及所有被放宽的 manifest 版本范围。

## 许可证

MIT
