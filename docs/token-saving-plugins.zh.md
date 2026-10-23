# 三种省 token 方案实测对比（2026-10）

> 中文文档。数据来自 2026-10-24 在 macOS 上的隔离 profile 实测，单样本，
> 模型为 `deepseek-flash`（DSH `headless` 模板）。结论有明确适用边界，见文末「局限」。

## 为什么要测

DeepSeek Harness 上省 token 的插件已经分成三条不同路线：

| 路线 | 代表 | 在哪一层动手 |
| --- | --- | --- |
| 执行时改写命令 | **dsh-rtk**（本仓库） | `ctx.shell` 的 `resolve()`，命令进 shell 之前 |
| 结果后裁剪 / 请求期压缩 | `dsh-token-saver` | `tools/post-execute` + `llm/stream` |
| 替换工具本身 | `dsh-ops` | 注册自己的 `ops_*` 工具，可选隐藏官方 `read`/`grep`/`glob` |

三者都自称省 token，但作用点不同。这里用同一批任务量一次，看真实差别。

## 方法

- 三个隔离 profile，均从 `headless` 模板创建：
  - `base-test`：无插件（基线）
  - `saver-test`：安装 `dsh-token-saver@1.0.4`
  - `ops-test`：`dsh plugin add dsh-ops` 安装 `0.4.1`，并按官方文档启用
    `dsh-ops-hide-official: replaceTools: [read, grep]`
- `dsh-token-saver` 用默认配置（`conservative`，`rtkEnabled: false`）；
  另单独测了一组 `rtkEnabled: true`。
- 每个任务用**完全相同的提示词**各跑一次，读会话日志里的
  `usage.inputTokens` / `usage.totalTokens` 与 `tool/result` 字符数。
- 会话总 token = 该会话所有请求的 `totalTokens` 之和（含缓存命中，缓存按折扣计费）。

任务集（工作区 `/tmp/saver-ws`，42.6 KB / 561 行的 `mid.log`）：

1. `cat mid.log`（bash）→ 取最后一行
2. `git log -n 40`（bash）→ 取 3 条最近标题
3. 整文件读 `mid.log` → 取最后一行
4. 读 `mid.log` 第 280 行
5. 读 `multi/` 下 8 个文件，各写一句摘要

## 结果

会话总 token（越小越好），括号内为请求数：

| 任务 | 基线 | dsh-token-saver | dsh-ops |
| --- | ---: | ---: | ---: |
| 1. `cat` 42.6 KB | 21,058 (2) | **17,128 (2)** −19% | 23,612 (2) +12% |
| 2. `git log`（rtk 过滤器开启） | 17,508 (2) | **13,471 (2)** −23% | 21,446 (2) +23% |
| 3. 整文件读 | 28,844 (3) | — | 34,577 (3) +20% |
| 4. 读第 280 行 | 23,977 (4) | — | **15,663 (2)** −35% |
| 5. 8 文件摘要 | 37,419 (5) | — | 53,267 (5) +42% |

工具结果字符数：

| 任务 | 基线 | dsh-token-saver | dsh-ops |
| --- | ---: | ---: | ---: |
| `cat` | 42,582 | **24,618** | 42,582（未接管） |
| `git log`（默认格式） | 17,891 | **4,599**（rtk 开） | 17,891（未接管） |
| 整文件读 | 45,393 | — | 44,929 |
| 第 280 行 | — | — | 395（紧凑带行号） |

## 观察

### dsh-rtk：命令输出直接变小，几乎无额外开销

`rtk rewrite` 在命令执行前改写，输出进上下文时已经变小。工具描述只增加一份，
没有额外的请求期处理。这是三条路线里单位收益成本最低的一种。

### dsh-token-saver：默认配置有效，但统计会低估

- 默认 `conservative`（头 16 KB + 尾 8 KB）真实有效：42.6 KB → 24.6 KB，
  会话总 token −19%，回答正确。
- 打开 `rtkEnabled` 后 `git log` 17.9 KB → 4.6 KB，总 token −23%。
- **缺陷**：它的 `rtkEnabled` 是 JS 复刻的 rtk 过滤，不是调用 rtk 二进制。
  对非标准 `git log --format` 会误判成 grep，把时间戳折叠成
  `Sun Oct 18 20 (1 hit): 08: 05 2026 +0800` 这样的垃圾（5,964 B → 1,111 B）。
  同一输入下真 rtk 是 2,791 B（−84.4%），复刻版是 4,603 B（−74.3%）。
- 它的 `~/.dsh/token-saver/stats.json` 只累计 rtk 过滤那部分，头尾截断不计入，
  面板数字会远低于实际节省。

### dsh-ops：不是压缩工具，是替代工具层

- 默认安装后模型**几乎不选** `ops_*` 工具，仍走宿主 `bash`/`read`，输出与基线完全一致；
  但工具描述让每次请求的 `cacheRead` 增加约 1.3–1.6 K token，于是总账变贵。
- 开启 `hide-official: [read, grep]` 后 `read` 被换成 `ops_inspect_local_file`，
  输出是紧凑带行号的格式，读定位类任务往返从 4 次降到 2 次，总 token −35% —— 这是它唯一
  明确占优的场景。
- 整文件读没有变小（44,929 vs 45,393 字符）；8 文件批量读反而更贵（多出的头部信息
  与后续校验调用）。

## 结论

- **想省命令输出的 token**：dsh-rtk 最直接，收益稳定、开销最小。
- **想裁 `read`/`cat` 这类大输出**：dsh-token-saver 默认配置有效；
  不要开它的 `rtkEnabled`，也不要开 prompt shaping / local responses / LLM 摘要。
- **想减少往返、要确定性格式**：dsh-ops 的 `hide-official` 只换 `read` 有意义；
  它不压缩命令输出，别指望它在 bash 上有作为。
- **不要三个一起装**：工具描述会三份叠加，而目标高度重叠。

## 局限

- 每个组合只跑了 1 次；模型非确定性会放大差异（尤其任务 4、5 的往返次数）。
- 不同 profile 之间的系统提示不同，`cacheRead` 不可直接横向比较，因此表中给的是
  **会话总 token**，并且只做同任务的纵向对比。
- 成本口径是 `totalTokens`（含缓存命中），不是账单金额。
- `dsh-token-saver` 与 `dsh-ops` 都在这两天内多次发版，数字只对文中版本有效。

## 复现

```sh
# 基线
dsh --profile base-test "Use the bash tool to run exactly: cat mid.log ..."
# 逐个插件：在 profile 的 cordis.patch.yml 里加对应行后重复同一提示词
# 然后读会话日志：
zstd -dc ~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd \
  | grep -o '"usage":{[^}]*}'
```

## 附：dsh-rtk 自己的已知限制

`workspace-write` 会话的 Seatbelt 只允许写工作区与临时目录，而 rtk 的状态目录在
`~/Library/Application Support/rtk`，因此统计、recall 与 tee 备份会在沙箱内**静默失败**。
本仓库的 `scripts/allow-rtk-state-in-sandbox.mjs` 可只放开该目录；细则见 README
「Sandboxed sessions」。
