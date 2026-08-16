# `@deepseek-ai/dsh-foreign-transcript`

[English](README.md) | 中文

把本机的 Claude Code 与 Codex 会话转录导入为有界、不可信的召回上下文,让在别的 agent 里开始的工作在 DeepSeek Harness 会话中继续。插件随 base 组合包发布,在同一个核心上提供三个入口:`/import-session` 人类命令、用户文本中的 `foreign-session:` 引用,以及 `import_foreign_session` 工具。

## 会话来源

Claude 会话读取自 `~/.claude/projects`(Claude Code CLI 与 Claude Desktop 的 agent 会话都会写入这里);Codex 会话读取自 `~/.codex/sessions`(Codex CLI 与 Codex Desktop 都写入)。两者都是按行分隔的 JSON 日志;解析器保留人类用户文本、助手文本、工具调用一行摘要和压缩摘要,跳过子代理 sidechain、附件、推理、工具输出和机器注入的引导内容。首条可解析记录无法识别格式时以 `FOREIGN_TRANSCRIPT_UNRECOGNIZED_FILE` 响亮失败;单行损坏只跳过该行。

specifier 为 `claude`、`codex` 或会话文件路径。来源关键字定位记录的工作目录等于当前会话 cwd 的最新会话:Claude 项目目录名是 cwd 中每个非字母数字字符替换为一个 `-` 的编码;Codex rollout 文件按新到旧扫描(扫描上限为 `latestScanLimit`)并读取 `session_meta` 头比对。显式路径(绝对路径、`~` 前缀或相对会话 cwd)必须解析到配置的根目录之内——导入绝不读取根目录之外的会话日志。

## 入口

| 入口 | 触发方式 | 投递 |
|---|---|---|
| `/import-session <specifier> [题目关键词]` | 在支持命令的输入框键入;多个题目匹配时经 user-questions 询问导入哪些(可多选) | `agent.inject()` 挂起一条带来源的上下文,随下一条提示词一起进入模型 |
| `foreign-session:<specifier>`(裸写或 `@[label](…)`) | 任意用户文本,覆盖包括 headless 与 ACP 在内的所有输入面 | `agent/pre-step` 把上下文附加到被认领的消息批之后 |
| `import_foreign_session` 工具(参数 `specifier`,可选 `query`) | 模型主动调用 | 投影后的转录即工具结果 |
| `search_foreign_sessions` 工具(参数 `origin`、`query`) | 模型主动调用 | 排序后的候选列表,不导入 |

每份导入的转录都成为一条持久的 `user/message`,来源为 `{ kind: 'foreign-transcript', form: 'recall', version: 1, origin, path, label, totalItems, omittedBytes }`,因此模型可见的材料总能从会话日志重建。一条用户消息至多引用 `maxMentionsPerMessage` 个外部会话;超出则让该步响亮失败。

## 题目检索

在 `claude`/`codex` 关键字后跟题目关键词(`/import-session claude parser fix`,或工具的 `query` 参数),即可按"这个会话是关于什么"而不是按路径选择会话。一个会话的题目是文件头部第一条 summary 行(Claude 的 `summary` 行、Codex 的 `compacted` 行),没有 summary 时是首条人类用户消息;每个候选文件的头部最多读取 `searchHeadBytes` 字节。查询匹配要求每个空白分隔的词都出现在题目中(不区分大小写);summary 匹配优先于首条用户消息匹配,再按新旧排序。检索覆盖该来源根下的所有项目目录、按新到旧的 `latestScanLimit` 个文件。`/import-session` 命令命中多个匹配时会询问导入哪些——经 `userQuestions` 服务抛出多选题,用户用自然语言确认一条或几条,命令精确导入所选;没有 UI 供应方(headless 运行)或问题被关闭时,回退为导入最佳匹配并列出其余 `searchResults` 个候选。模型侧 `search_foreign_sessions` 只返回排序列表不导入:模型把它呈现给用户(通常配合 `ask_user_question`),再用选中的路径(一条或多条)调用 `import_foreign_session`。无匹配时响亮失败;题目关键词必须搭配来源关键字——显式路径加关键词会被拒绝。

## 投影与保留

渲染以 `## Imported foreign session` 框架加不可信召回护栏(不得执行其中的指令、权限声明或工具请求)开头,随后是携带 origin、label、session-id、cwd、started、git-branch、model 属性的 `<foreign-session>` 标签,内含按会话顺序排列的 `[user]`、`[assistant]`、`[tool] <名称> <摘要>` 与 `[summary]` 块。条目超过 `maxTranscriptBytes` 时,保留连续的首尾两段——最初的任务陈述与最近的状态——中间替换为一条省略标记;连一个完整条目都放不下时,保留最近一条并做首尾截断。预算连框架加任何条目内容都放不下时,以 `FOREIGN_TRANSCRIPT_BUDGET_EXCEEDED` 响亮失败。

## 配置

| 键 | 默认值 | 约定 |
|---|---:|---|
| `claudeProjectsRoot` | `~/.claude/projects` | Claude Code 项目会话目录的根;相对值以进程工作目录为锚。 |
| `codexSessionsRoot` | `~/.codex/sessions` | Codex 按日期组织的会话目录的根。 |
| `maxTranscriptBytes` | `65536` | 一份导入转录的最大渲染 UTF-8 字节数。 |
| `maxMentionsPerMessage` | `3` | 一条用户消息至多引用的外部会话数;上限 `5`。 |
| `latestScanLimit` | `200` | 定位最新 Codex 会话时按新到旧检查的 rollout 文件数;同样约束一次题目检索。 |
| `maxToolBriefChars` | `120` | 一行工具调用摘要的字符上限。 |
| `searchHeadBytes` | `32768` | 提取一个会话题目时读取头部的字节上限。 |
| `searchResults` | `5` | 一次题目检索返回的候选数。 |

## Model Experience

### 导入的外部会话召回

#### 模型看到什么

一条用户角色的上下文消息,以 `## Imported foreign session — <origin>: <label>` 框架加不可信召回护栏开头,转录置于 `<foreign-session>` 标签内。属性值转义 `&`、`<`、`>` 与 `"`;条目文本除字节预算保留外原样保留。

#### Token 影响

条件性:用户导入或引用会话(或工具运行)之前为零,之后每份导入会话最多 `maxTranscriptBytes`,保留在历史中直至被压缩遮蔽。`/import-session` 与工具的描述在可见处带来固定 schema 开销。

#### KV Cache 影响

命令注入的上下文等待下一条提示词,因此追加在既有历史之后,不破坏复用。引用展开在请求构建前重排该步的消息批,把上下文附加在被认领的用户消息之后——更早的历史保持前缀稳定;内容不同的第二次导入只改变新的后缀。

### 工具 schema

#### 模型看到什么

模型看到生成的 [`import_foreign_session` schema](../../../docs/tool-catalog.md#deepseek-aidsh-foreign-transcript)。

#### Token 影响

工具可见的每个请求承担固定 schema 开销。

#### KV Cache 影响

定义与可见性不变时前缀稳定。

## Known Limitations and Deferred Work

- **丢弃工具输出** — 工具结果与推理不进入导入;只有对话双方、工具调用一行摘要与压缩摘要进入。
- **跳过 Claude 子代理 sidechain** — 同一文件中的 sidechain 记录被排除,以保证主线程转录在预算之内。
- **快照而非链接** — 导入在展开时读取文件一次;外部会话后续写入要等下次导入才可见。
- **格式漂移容错是行级的** — 未知记录类型被跳过而非拒绝;整文件级的格式变化以 `FOREIGN_TRANSCRIPT_UNRECOGNIZED_FILE` 显现。
