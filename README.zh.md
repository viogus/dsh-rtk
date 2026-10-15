# dsh-rtk

[![CI](https://github.com/viogus/dsh-rtk/actions/workflows/ci.yml/badge.svg)](https://github.com/viogus/dsh-rtk/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/viogus/dsh-rtk)](https://github.com/viogus/dsh-rtk/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/viogus/dsh-rtk/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-339933?logo=nodedotjs)](https://nodejs.org/)

> 在 DeepSeek Harness（`dsh`）的 bash 执行器里，把符合条件的 shell 命令路由给 [rtk](https://github.com/rtk-ai/rtk)（Rust Token Killer）执行 —— 压缩工具输出、省 token、其余一概不变。

[English version](README.md)

---

## 目录

- [快速示例](#快速示例)
- [环境要求](#环境要求)
- [为什么需要它](#为什么需要它)
- [工作原理](#工作原理)
- [安装与启用](#安装与启用)
- [API / 配置](#api--配置)
- [哪些命令会被路由](#哪些命令会被路由)
- [开发](#开发)
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
2. **成本过滤器，而非策略。** shell 关键字与 `cd`、`echo`、`export` 等会在启动子进程之前被跳过，因为它们是 agent 最常执行、且 rtk 一律拒绝改写的命令。任何无法被证明「绝不被改写」的命令都会交给 rtk 判断。若 `PATH` 上找不到 `rtk` 二进制，整个变换就是**恒等**：部署行为与原始执行器完全一致。

rtk 是**按词法切分**命令的，而不是整串匹配：它只重写自己认识的片段，管道、`&&`/`;`、重定向与命令替换都逐字节保留。因此复合命令会被路由，而不是被跳过。

### 版本说明

本插件**不捆绑、不锁定 rtk 版本**。构造执行器时会探测 `PATH` 上的 `rtk --version`（见 [`src/rtk.ts`](src/rtk.ts) 的 `probeRtkAvailable`），随后就让这同一个二进制去做重写。因此：

- **rtk 发布新版本时**，任何在本地升级了 `rtk` 的用户会自动获得新规则**乃至新命令** —— 无需更新本插件。
- 本插件版本（本仓库）与 rtk 版本**相互独立**，请勿混为一谈。本说明给出的是测试所基于的*最低* rtk 版本，而非锁步版本号。
- `RTK_BIN` 可覆盖二进制路径，`RTK_TIMEOUT_MS` 可覆盖单次重写超时（默认 2000 ms）；超时按「无重写」处理。

> **要求：** `rtk` 在 `PATH` 上（`rtk --version` 退出码为 0）。插件**不会**安装或管理 rtk —— **你必须自行安装并更新 rtk**（例如 `cargo install rtk` 或下载发布二进制）。当 rtk 缺失时，插件静默退化为透传。

### 兼容性与版本对齐

本插件依赖 `@deepseek-ai/dsh-*` 系列包，DeepSeek Harness 将它们与 `dsh` 聚合包**分开**发布到 npm。由于这些子包（以及 `dsh` 本身）都以**预发布**形式（`x.y.z-rc.n`）发布，peer 范围必须按 [awesome-dsh-plugin/contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) 带上显式的预发布分支 —— 像 `>=0.0.1-rc.1 <0.3.0` 这样"看起来很宽"的范围会*静默*排除所有 `0.2.0-*` 预发布（node-semver 只有当某比较符与候选版本同 `major.minor.patch` 元组且自身也带预发布标签时，才放行预发布版本），因此上界写成 `<0.3.0-0`。

实际范围（见 `package.json` 的 `peerDependencies`）为：

```
"@deepseek-ai/cordis":           "~4.0.4"
"@deepseek-ai/dsh-bash-local":   ">=0.0.1-rc.1 <0.3.0-0"
"@deepseek-ai/dsh-bash-sandbox": ">=0.0.1-rc.1 <0.3.0-0"
"@deepseek-ai/dsh-shell":        ">=0.0.1-rc.1 <0.3.0-0"
```

四项 peer 都在 `peerDependenciesMeta` 中标记为 `optional`，因此在它们缺失时插件仍可安装并加载（此时退化为透传）。注意 cordis 一项：`dsh` 在运行时注入容器，但注入的是**带 scope** 的 `@deepseek-ai/cordis` —— 也正是本插件为获取 `Context`/`Service` 类型而 import 的包。npm 上不带 scope 的 `cordis` 是**另一条更旧的线**（`4.0.0-rc.11`），此处不可使用。

本插件的 `dsh.plugin.json` 声明：

```json
"engines": { "dsh": ">=0.1.0-rc.6 <0.3.0-0" }
```

即：以 `dsh` `0.2.0-rc.2`（其 `@deepseek-ai/dsh-*` 子包同为 `0.2.0-rc.2`）为验证基准，接受任意 `0.1.x`/`0.2.x` 预发布。

> **已知的版本错位：** `dsh`（聚合包，即 `npx @deepseek-ai/dsh` 安装的）与其 `@deepseek-ai/dsh-*` 子包处于**独立的 semver 轨道**。上述范围锁定到*已发布*的子包版本，因此普通 `dsh plugin add` 能干净解析。跟进匹配更新请关注 [releases](https://github.com/viogus/dsh-rtk/releases)。

## 安装与启用

插件**默认禁用** —— 安装后不会生效，需手动开启。

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

复合命令同样会被路由，因为 rtk 是分段重写的。插件只跳过那些能被证明「rtk 永不改写」的词（shell 关键字与日常内建命令），以省下一次子进程开销。

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

`devDependencies` 通过 `link:` 指向本地 `deepseek-harness` 源码仓；测试需在该 workspace 内运行（`@deepseek-ai/dsh-*` 包必须可解析）。

单元测试通过 `RTK_BIN` 注入一个替身 rtk 二进制，因此不依赖真实的 rtk。若还要针对你本机实际安装的 rtk 证明一致性：

```sh
pnpm run test:integration    # 需要 PATH 上有真实 rtk（或设置 RTK_INTEGRATION_BIN）
```

未提供二进制时该套件会被跳过，因此普通的 `pnpm run test` 在没有 rtk 的环境中依然全绿。

## 许可证

MIT
