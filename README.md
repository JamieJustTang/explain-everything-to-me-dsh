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

推荐安装 [ste-language-improvement](https://github.com/JamieJustTang/ste-language-improvement)：
DeepSeek 的解释会遵守平实中文规则（短句、主动、术语首现附中文、无黑话），进一步优化交互体感。

### 2. 敲决策：「我看不懂，待决策项太多了，我们一个一个来」

同一段导入的会话里，让 DeepSeek 把 Claude/Codex 抛出的多决策问题逐条解释、展开探讨：

> 我看不懂。待决策项太多了。请你一个一个阐述和解释选项分别的意义。我们一个一个来敲定。

推荐安装 [decision-walkthrough](https://github.com/JamieJustTang/decision-walkthrough)：
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

原文取自一段真实 Codex 汇报（标识已匿名化），经 ste-language-improvement 规则改写：

| 指标 | 改进前 | 改进后 | 变化 |
|---|---:|---:|---|
| 英文词密度（个/百字） | 31.5 | 16.1 | **-49%** |
| 列表条目含谓语（完整句） | 4/13 | 12/13 | **+62 个百分点** |
| 事实保留 | — | 全部 | 100% |

改进前：`M3 五专家 exact prompt + egress manifest`（术语堆叠、不成句）。
改进后（deepseek-v4-pro 实际输出）：`已交付 M3 五名专家的精确提示词（exact prompt）与出站清单（egress manifest）`。

完整对照与方法见 [ste-language-improvement](https://github.com/JamieJustTang/ste-language-improvement#效果实测)。

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
`dsh plugin add JamieJustTang/explain-to-me` 一键安装。

## 状态与致谢

- 0.1.0：导入、题目检索、多选消歧、检索工具、决策文档用法。
- 路线图：独立 npm 安装；会话进展的定时摘要；决策文档模板化。
- 插件在 deepseek-harness 仓库内通过全部相关门禁（60 项单测、每文件 100% 覆盖率、无 key 快照回归）。
- 灵感与基座来自 DeepSeek Harness 的插件化架构；语言规则站在 ASD-STE100 与其中文社区补充的肩膀上。
