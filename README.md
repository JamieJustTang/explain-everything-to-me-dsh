# explain-everything-to-me-dsh

**把所有解释交给我。**

> 「妈妈再也不用担心我看不懂 Codex/Claude 了！So Easy！」

**English in one line:** a DeepSeek Harness plugin that imports your local Claude Code / Codex session transcripts as bounded context, so DeepSeek can explain what those agents did, walk you through their pending decisions in plain Chinese, and keep a decision ledger you can carry back into any CLI agent.

> ⚠️ 本项目暂时基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 开发，以包的形式（`dsh` 插件）存在，尚未独立发包。安装方式见下文。

## 痛点

Claude 和 Codex 越来越不说人话。

这不是模型退步，而是激励使然：在多智能体协作和工具调用上拿高分的输出，恰恰是术语密集、电报式、面向机器的。对机器队友这是效率，对人类开发者这是税——你读不动它的汇报，就看不住它的决策。看不住，就只有两种坏结局：盲目同意，或者整体搁置。

DeepSeek Harness 的开放性（一切都是插件）让我们可以换一个位置：不去改造 Claude/Codex，而是给自己造一台**AI 交互指令台**——用 DeepSeek 当那台“说人话”的机器。尤其对中文使用者，DeepSeek 基模的中文能让所有解释真正可读、可追问、可讨论。

explain-everything-to-me-dsh 是这台指令台的第一块拼图：它把你本机的 Claude/Codex 会话记录读进 DeepSeek 会话，变成有界、带护栏的上下文。之后的解释、追问、决策，都发生在你说得懂的语言里。

## 推荐用法

### 1. 问进展：「Claude/Codex 那边干到哪了？」

在 DeepSeek 会话里直接导入对方会话，然后问它进展和工作状况：

```text
/import-session claude parser        # 按题目检索，多个匹配会弹多选题让你挑
/import-session codex                 # 直接取当前项目最近一次 Codex 会话
```

也可以在任意输入里写 `foreign-session:claude` 引用，或让模型自己调
`search_foreign_sessions` → `ask_user_question` → `import_foreign_session`。

推荐安装 [ste-language-zh-improvement](https://github.com/JamieJustTang/ste-language-zh-improvement)：
DeepSeek 的解释会遵守平实中文规则（短句、主动、术语首现附中文、无黑话），进一步优化交互体感。

### 2. 敲决策：「我看不懂，待决策项太多了，我们一个一个来」

同一段导入的会话里，让 DeepSeek 把 Claude/Codex 抛出的多决策问题逐条解释、展开探讨：

> 我看不懂。待决策项太多了。请你一个一个阐述和解释选项分别的意义。我们一个一个来敲定。

推荐安装 [decision-one-by-one](https://github.com/JamieJustTang/decision-one-by-one)：
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

## 效果实测（真实会话）

下面这组对照来自同一段真实工作：Claude 的多智能体运行产出了决策审查与三路调研简报；
用户把材料贴给 DeepSeek，只问了一句「这是 Claude 做的进一步调查和分析，请帮我解释它
做了什么、提出了哪些建议和发现」。右侧就是 DeepSeek 的回答。两侧均为摘录（……为省略）：

| Claude 多智能体产出（原文摘录，……为省略） | DeepSeek 的解读（真实会话输出摘录） |
|---|---|
| `docs/DECISIONS.md` 最近被改过——看是不是你把决策写进去了（对比 git）：<br>决策已入账（`2923900`）。现在按你的 P0 优先级派出三个并行调研 agent（Opus），覆盖所有「需要文献调研才能继续深谈」的决策点：<br># 决策审查意见<br>15 条决策已入账并提交（`2923900`）。总体判断：**这套决策内部自洽、优先级排布合理，且你把「哪些还不能拍」识别得很准**——D-v4-06 评分构念和 D-v4-08 基线可跑性都显式留给了调研，这正是该调研先行的两处。逐块意见：<br>**两处执行风险旗（不是反对，是排期上要正视）**：<br>1. **D-v4-02 六周直冲**：算力和 agent 并行能压缩的只有实现与跑批；**压不动的是三件人事**——人类专家盲评的招募与执行（D-v4-06）、自建任务集的专家验证（D-v4-03）、外部基线的适配调试（D-v4-08）。<br>……<br>\| A 评估方法学 \| D-v4-06 四步的前三步 \| 14 个竞争系统/基准的评估做法逐一解剖 → 以批评文献（Hidden Pitfalls、Correct Answer Wrong Mechanism 等）为锚批判 → 从 QD 多样性、科学计量新颖性、社科理论质量标准（Davis「That's Interesting!」、Whetten、Corley & Gioia）、HCI 协作测度、长程生产率五个文献带提出候选构念池 + 强人框架草案 \|<br>……<br>**① FP-4 的漏洞被精确定位到了代码行**：`claim-ladder.mjs` 的 `resolveEvidenceFacts()` 受理形状③——裸字符串 `evidence_level` 被直接采信，这就是「自报」通道；手术面极小（只换这一个形状为 provenance 推导）。给出三个设计模式：**A 前瞻模式声明**（RR 式，结果已知前签、事后改即 tampered）、**B 单向棘轮**（L1→L2 晋升必须独立 confirmatory 重推导，挂在 CRYSTALLIZE 上）、**C GRADE 式严苛度记分**（基线由步骤定 + 机检升降级）。推荐 **A+C 组合、B 做成消融开关**。最关键的治理洞见是 Vazire 悖论：只给 confirmatory 装牙齿，引擎会理性地全部声明 exploratory——所以防套利的重点是「让探索产物结构性到不了高阶梯」，不是惩罚探索。<br>……<br>**① 评分框架的骨架已经被文献逼出来了（D-v4-06 第四步的雏形）**。三条铁证——novelty mirage（LLM judge 一贯高估机器产物新颖性、专家结论相反）、Agents4Science 的 AI-人相关仅 r=0.12–0.26、而人-人一致性上界本身只有 r=0.14——共同决定了唯一站得住的结构：**机器可算仪表盘（高频）→ 受约束的 LLM judge（中频，novelty 不得单独裁定）→ 人类专家锚点（低频）**三层，外加两个强制元层：判官偏倚在自家 rubric 上实测、LLM-人/人-人/LLM-LLM 三重一致性同报。 | ## 一、Claude 这一次做了什么（动作清单，已核实）<br>这一次**没有动系统代码**，全是「调研 + 记账」：<br>1. **把决策写进账本并提交**：`docs/DECISIONS.md` 新增 §I（D-v4-01 到 D-v4-15，共 45 行），commit `2923900`，工作树 clean。<br>2. **按 P0 优先级，派了 3 个并行调研 agent**（Opus）：A 评估方法学、B 基线可跑性、C 设计输入。<br>3. **三份报告存档**；最后给你一份「决策审查意见」+ 一份「跨报告综合简报」，甩给你一张「待拍板清单」。<br>值得注意的是：他做的**不是**「又跑一遍实验」，而是**把下一步的决策风险提前用文献和实测摸了一遍**。<br>……<br>### 调研 B——发现了一个会推翻前提的问题<br>你之前定的「两个外部基线跑同一批题」**不成立**：ASS 只吃「社会情境」，Agent Laboratory 吃自由文本题目，两者输入单元根本不同类。解法：自建任务集里刻意设计 8–10 题「情境可表达」任务，让两个基线在这个子集上同台。**连带后果**：自建集升格为主力评测集，变成单点故障，标注人力必须最早锁定。<br>……<br>### 调研 A——把评分框架的骨架逼出来了<br>普查了 16 个系统/基准的评估做法，最硬的三条铁证：<br>1. **novelty 幻象**：LLM judge 一贯高估机器产物的新颖性，专家结论相反 → novelty 维度绝不能由 LLM judge 单独裁定。<br>2. AI-人相关只有 r=0.12–0.26；人-人一致性上界本身只有 r≈0.14 → 报「LLM 和人一致」时必须同报人-人一致性当上界，否则是自欺。<br>由此推出的骨架 = 机器可算仪表盘（高频）→ 受约束的 LLM judge（中频）→ 人类专家盲评锚点（低频）。<br>……<br>**你现在面临的核心选择其实只有一个**：下一步怎么处理这 10 个待决项——在对话里逐个讨论，还是生成一张决策地图让你点选。选完，实验设计文档和工程就同时开工。 |

差异是结构性的，数字为辅：平均句长 32 → 27 字；超过 40 字的长句占比 25% → 12%；分节标题 1 → 3。真正的差别在解耦——左侧把 15 条决策、3 份调研、审查意见纠缠在同一段流里，每次阅读都要自己拆；右侧先回答「做了什么」（4 个动作），再按报告逐份讲「发现了什么」，最后收拢成「你现在只需做一个选择」。

另附两组「同义改写」基准样本（经 deepseek-v4-pro 逐条重写，配分层可理解性指标与
复现脚本），见
[ste-language-zh-improvement](https://github.com/JamieJustTang/ste-language-zh-improvement#效果实测)。

## 三件套

```text
┌──────────────────────────────────────┐
│ explain-everything-to-me-dsh（本仓库） │
│ dsh 插件：把 Claude/Codex 会话         │
│ 搬进 DeepSeek（导入＋检索＋消歧）      │
└──────────────┬───────────────────────┘
               │ 推荐安装
┌──────────────┴─────────────┐ ┌─────────────────────────┐
│ ste-language-zh-improvement │ │ decision-one-by-one      │
│ 平实中文输出规则（通用技能） │ │ 逐项敲定决策（通用技能）  │
└────────────────────────────┘ └─────────────────────────┘
```

## 安装（现阶段：随 deepseek-harness 检出使用）

依赖的 `@deepseek-ai/dsh-*` 包尚未发布到 npm，因此当前以“放进 harness 检出”的方式安装：

1. 取一份 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 检出。
2. 把本仓库放进 `packages/context/explain-everything-to-me-dsh/`。
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
