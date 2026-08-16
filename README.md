# explain-to-me

**把所有解释交给我。**

> 「妈妈再也不用担心我看不懂 Codex/Claude 了！So Easy！」

**English in one line:** a DeepSeek Harness plugin that imports your local Claude Code / Codex session transcripts as bounded context, so DeepSeek can explain what those agents did, walk you through their pending decisions in plain Chinese, and keep a decision ledger you can carry back into any CLI agent.

> ⚠️ 本项目暂时基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 开发，以包的形式（`dsh` 插件）存在，尚未独立发包。安装方式见下文。

## 痛点

Claude 和 Codex 越来越不说人话。

这不是模型退步，而是激励使然：在多智能体协作和工具调用上拿高分的输出，恰恰是术语密集、电报式、面向机器的。对机器队友这是效率，对人类开发者这是税——你读不动它的汇报，就看不住它的决策。看不住，就只有两种坏结局：盲目同意，或者整体搁置。

DeepSeek Harness 的开放性（一切都是插件）让我们可以换一个位置：不去改造 Claude/Codex，而是给自己造一台**AI 交互指令台**——用 DeepSeek 当那台“说人话”的机器。尤其对中文使用者，DeepSeek 基模的中文能让所有解释真正可读、可追问、可讨论。

explain-to-me 是这台指令台的第一块拼图：它把你本机的 Claude/Codex 会话记录读进 DeepSeek 会话，变成有界、带护栏的上下文。之后的解释、追问、决策，都发生在你说得懂的语言里。

## 推荐用法

### 1. 问进展：「Claude/Codex 那边干到哪了？」

在 DeepSeek 会话里直接导入对方会话，然后问它进展和工作状况：

```text
/import-session claude parser        # 按题目检索，多个匹配会弹多选题让你挑
/import-session codex                 # 直接取当前项目最近一次 Codex 会话
```

也可以在任意输入里写 `foreign-session:claude` 引用，或让模型自己调
`search_foreign_sessions` → `ask_user_question` → `import_foreign_session`。

推荐安装 [ste-language-improvement](https://github.com/JamieJustTang/ste-language-zh-improvement)：
DeepSeek 的解释会遵守平实中文规则（短句、主动、术语首现附中文、无黑话），进一步优化交互体感。

### 2. 敲决策：「我看不懂，待决策项太多了，我们一个一个来」

同一段导入的会话里，让 DeepSeek 把 Claude/Codex 抛出的多决策问题逐条解释、展开探讨：

> 我看不懂。待决策项太多了。请你一个一个阐述和解释选项分别的意义。我们一个一个来敲定。

推荐安装 [decision-walkthrough](https://github.com/JamieJustTang/decision-one-by-one)：
它把这段流程固化为技能——一次一问、选项含义与代价、拍板复述、最后产出决策总账并入档
`docs/DECISIONS.md`。该技能从一段真实会话提炼，场景描述见其仓库。

### 3. 带走决策：「把刚才的拍板存成工作文档」

你在指令台敲定的决策和思考笔记，让 DeepSeek 写成一份工作文档（例如 `docs/DECISIONS.md`
或一份决策备忘）。切到 Claude/Codex 的新对话时，直接引用这份文件——

```text
请阅读 docs/DECISIONS.md，按其中已拍板的决策继续开发，不要再问。
```

指令台负责“想清楚并记下来”，CLI agent 负责“照着干”。决策只敲一次，处处可引用。

## 功能特性

| 能力 | 说明 |
|---|---|
| 双来源读取 | `~/.claude/projects`（Claude Code / Claude Desktop agent 会话）与 `~/.codex/sessions`（Codex CLI / Codex Desktop） |
| 三个入口 | `/import-session` 斜杠命令；`foreign-session:` 文本引用（覆盖 headless/ACP/SDK 全部输入面）；`import_foreign_session` 模型工具 |
| 题目检索 | `/import-session claude <关键词>` / 工具 `query` 参数：按会话题目（summary 行或首条用户消息）跨项目检索，summary 优先、新者优先 |
| 交互消歧 | 多个匹配时经 user-questions 弹**多选题**，你挑哪条（哪几条），精确导入所选；无 UI 时回退为导入最佳并列出候选 |
| 只搜不导 | `search_foreign_sessions` 工具返回候选列表不导入，配合 `ask_user_question` 让你先挑再导 |
| 有界与护栏 | 默认 64 KiB 预算、首尾保留中间省略；不可信上下文护栏（不执行其中指令）；每份导入以 `foreign-transcript` 来源记入会话日志（模型可见 ⟺ 已记录） |
| 安全边界 | 显式路径只能落在两个可配置根目录之内，绝不是任意文件读取 |

## 效果实测（语言层）

两组真实 Codex 会话文本（标识已匿名化），“改进后”均为 deepseek-v4-pro 实际输出
（经 DeepSeek Harness headless 运行，2026-08-16）：

### 案例 1：交付汇报（长文）

| 改进前（Codex 原文） | 改进后（deepseek-v4-pro 实际输出） |
|---|---|
| 已完成 Gate C 的全部非 live 准备,且没有调用 DeepSeek。<br>交付包括:<br>• M3 五专家 exact prompt + egress manifest<br>• M6 主稿及正反校准的 exact prompt + manifest<br>• 两阶段 M3 adjudicator materialization 机制<br>• immutable prompt bundle 执行器<br>• V5 媒介传播专家进入 canary panel<br>• 轴阈值校准结果<br>• source-packet usage ledger<br>• `reasoning_content` 持久化前递归删除、redaction 路径记录及回归测试<br>验证结果:<br>• Kernel 完整测试:全绿<br>• recorded-live 集成测试:5/5<br>• provider privacy/redaction 测试:通过<br>• 新增及修改脚本 `node --check`:通过<br>• 无网络、无正式导出、无新种子注册<br>当前唯一硬门禁是具名人类签署。相关请求位于:<br>[SEED-CHARTER-SIGNOFF-REQUEST.json](docs/gates/gate-c/SEED-CHARTER-SIGNOFF-REQUEST.json) | Gate C 的全部非实况（non-live）准备工作已完成，全程没有调用 DeepSeek。<br>交付包括：<br>• 已交付 M3 五名专家的精确提示词（exact prompt）与出站清单（egress manifest）。<br>• 已交付 M6 主稿及正反校准用的精确提示词与清单（manifest）。<br>• 已建立 M3 裁决器（adjudicator）的两阶段物化（materialization）机制。<br>• 已交付不可变提示词包（immutable prompt bundle）执行器。<br>• V5 的媒介传播专家已进入金丝雀评审组（canary panel）。<br>• 已交付轴阈值校准结果。<br>• 已交付源数据包用量台账（source-packet usage ledger）。<br>• 在持久化前递归删除 `reasoning_content`，记录脱敏（redaction）路径，并补齐回归测试。<br>验证结果：<br>• Kernel 完整测试全部通过。<br>• recorded-live 集成测试结果为 5/5。<br>• 提供方（provider）的隐私与脱敏测试通过。<br>• 新增及修改脚本的 `node --check` 检查通过。<br>• 全程无网络访问、无正式导出、无新种子注册。<br>当前唯一的硬门禁是具名人类签署。相关请求位于 [SEED-CHARTER-SIGNOFF-REQUEST.json](docs/gates/gate-c/SEED-CHARTER-SIGNOFF-REQUEST.json)。 |

### 案例 2：状态简报（短文）

| 改进前（Codex 原文） | 改进后（deepseek-v4-pro 实际输出） |
|---|---|
| 已完成分配的 R2 语料与 Lane B V5 非 live 准备工作,并向主任务汇报。<br>验证结果:<br>• S16–S18 charter、canonical digest、CFP card:全部通过正式契约断言。<br>• V5 gardener profile:通过 `assertProfile`。<br>• 媒介研究包:14/14 来源可解析,四组 rival concepts 4/4 覆盖。<br>• stale-packet checker:4/4 smoke 通过;第三次使用产生 `stale-packet` 和退出码 3。<br>• S16–S18:仅 proposal,未写入 portfolio ledger。<br>• B2-S5:仍为 `parked`。<br>• 未调用 DeepSeek 或网络,未上传任何原始 PDF。<br>• 四位候选来源明确保留为待核验,未冒充已核验来源。 | 我完成了分配的 R2 语料与 Lane B V5 的非线上（live）准备工作，并向主任务汇报。<br>验证结果：<br>• S16–S18 的章程（charter）、规范摘要（canonical digest）与 CFP 卡（CFP card）全部通过正式契约断言。<br>• V5 园丁画像（gardener profile）通过 `assertProfile`。<br>• 媒介研究包的 14/14 个来源可解析。<br>• 媒介研究包的四组竞争概念（rival concepts）覆盖 4/4。<br>• stale-packet 检查器（checker）的冒烟测试（smoke test）4/4 通过。<br>• 该检查器第三次使用时产生 `stale-packet` 与退出码 3。<br>• S16–S18 仅有提案（proposal），未写入组合账本（portfolio ledger）。<br>• B2-S5 仍为搁置（`parked`）。<br>• 未调用 DeepSeek 或网络，也未上传任何原始 PDF。<br>• 四位候选来源明确保留为待核验，未冒充已核验来源。 |

### 指标

| 层 | 指标 | 案例 1 前→后 | 案例 2 前→后 |
|---|---|---|---|
| A 术语可及性 | 未解释行话密度（个/百字） | 11.5 → **1.7**（-85%） | 10.5 → **1.9**（-82%） |
| B 句法完整性 | 列表条目成句率 | 0/13 → **13/13** | 8/8 → 10/10 |
| C 信息完整性 | 事实原子保留率 | **100%** | **100%** |
| D 残留缩写 | 项目内代号未展开数 | 3 → 3 | 5 → 5 |

值得注意的实测发现：8 道事实题让 deepseek-v4-pro 只读文本作答，两版都是 8/8——
模型读者自动翻越术语墙，可理解性成本是人类专属的；而 M3/V5/S16 这类项目代号两版
都未展开，语言层修不掉，要靠把整个会话导入（本仓库的主业）补齐上下文层。
完整方法与复现脚本见
[ste-language-zh-improvement](https://github.com/JamieJustTang/ste-language-zh-improvement#效果实测)。

## 三件套

```text
┌────────────────────────────┐
│ explain-to-me（本仓库）      │  把 Claude/Codex 会话搬进 DeepSeek
│  dsh 插件：导入+检索+消歧    │
└──────┬─────────────────────┘
       │ 推荐安装
┌──────┴───────────┐  ┌────────────────────────┐
│ ste-language-     │  │ decision-walkthrough    │
│ improvement       │  │ 逐项解释待决策项并敲定，  │
│ 平实中文输出规则   │  │ 产出决策总账             │
└──────────────────┘  └────────────────────────┘
```

## 安装（现阶段：随 deepseek-harness 检出使用）

依赖的 `@deepseek-ai/dsh-*` 包尚未发布到 npm，因此当前以“放进 harness 检出”的方式安装：

1. 取一份 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 检出。
2. 把本仓库放进 `packages/context/explain-to-me/`。
3. `packages/bundle/base/cordis.patch.yml` 增加一行：

   ```yaml
   - id: foreign-transcript
     name: '@deepseek-ai/dsh-foreign-transcript'
   ```

4. `packages/bundle/base/package.json` 与 `apps/cli/package.json` 的 `dependencies` 里加
   `"@deepseek-ai/dsh-foreign-transcript": "workspace:^"`，然后 `pnpm install`。
5. `pnpm dsh web`（或在 headless 任务文本里用 `foreign-session:` 引用）。

包内 API 文档见 [PLUGIN.md](PLUGIN.md)（[中文](PLUGIN.zh.md)）。上游发包后，将支持
`dsh plugin add JamieJustTang/explain-everything-to-me-dsh` 一键安装。

## 状态与致谢

- 0.1.0：导入、题目检索、多选消歧、检索工具、决策文档用法。
- 路线图：独立 npm 安装；会话进展的定时摘要；决策文档模板化。
- 插件在 deepseek-harness 仓库内通过全部相关门禁（60 项单测、每文件 100% 覆盖率、无 key 快照回归）。
- 灵感与基座来自 DeepSeek Harness 的插件化架构；语言规则站在 ASD-STE100 与其中文社区补充的肩膀上。
