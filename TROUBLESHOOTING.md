# 排障记录（TROUBLESHOOTING）

本文件收录本插件在真实使用中踩过的坑：症状 → 根因 → 修复 → 你能做的事。所有条目都来自真实会话报告，并附上当时定位问题的方法，便于下次遇到同类问题时对照。

## 1. 任何关键词都报「no X session topic matches」

**症状**：`/import-session codex <任何词>` 全部报无匹配，连让模型用空查询列最新会话也列不出来。

**根因**：新版 Codex 的会话文件开头是一大块机器引导——实测首行（session 元数据＋指令）19–47 KB，首条真人消息埋在文件 20–136 KB 深处。而题目检索默认只读 32 KB 头部：最新 200 个会话里**零个**能提取出题目，任何查询自然落空。

**修复**：v0.3.1 起 `searchHeadBytes` 默认 256 KB（实测最深偏移的两倍）；同时跳过 `<recommended_plugins>`、`# AGENTS.md instructions for …`、`The following is the Codex agent history …` 等机器注入开头，题目恢复为真人提示词，导入的转录也不再携带这些引导块。仍搜不到更老的深埋内容时，可在 cordis.yml 里调大 `searchHeadBytes`。

**定位方法**：对扫描窗口里的文件逐个统计「题目提取结果」（多少个解析出用户消息、多少个失败），而不是盯着一个文件猜。全灭指向系统性原因，不指向关键词选得不好。

## 2. 整句话当关键词，永远搜不到

**症状**：`/import-session codex CHI版本 向我解释GPT提出的CHI工程和实验设计文档。` 报无匹配。

**根因**（两层）：
- 检索词是**逐词条 AND** 语义，中文没空格，整句变成一个必须逐字出现在题目里的长词条——连标点都要一致；
- 你想找的材料可能在会话**正文深处**，开头题目与你的描述几乎零重叠（实测正确会话的题目与该查询的字符重叠只有 0–4%）。

**修复**（v0.3.2）：
- **语法**：首行＝引用请求（specifier＋范围旗标＋少量检索词），**换行后的所有文字＝给 DeepSeek 的指令**，经 `agent.followup()` 直接提交，一步完成「引用＋提问」；
- **检索**：题目词条全不中时，自动回退对会话开头内容做同样的词条匹配（结果标记 `topicSource: 'content'`），深埋正文的会话也能被找到。

**你能做的事**：检索词用 1–3 个有区分度的词（`CHI`、`工程和实验设计`），把意图写成指令放在换行之后；或者干脆用自然语言直接说你想干什么，让模型自己调 `search_foreign_sessions` 提炼关键词。

## 3. web 上多匹配时报「web user interaction requires an agent-owned session」

**症状**：检索命中多个会话、该弹多选题的时候，命令直接报这个内部错误。

**根因**：web 宿主要把多选题路由到你的前端，依赖提问请求里携带的 agent；消歧提问没带，问题无处可投。此缺陷从多选消歧上线就存在，只是此前检索一直不通，从没真正触发过。

**修复**：v0.3.3 起命令把它持有的活跃根 agent 传入提问请求。

**定位方法**：错误串直接来自宿主层的守卫（`packages/host/apiproxy`）。遇到 `internal:` 前缀的错误，先在代码里搜错误原文，看它是哪一层的契约。

## 4. web 发消息后消息直接消失

**症状**：输入框发送后消息不见，无回复也无报错；服务器日志只有启动行。

**根因**：服务器进程环境里没有 `DEEPSEEK_API_KEY`（重启时用的 shell 没继承 zshrc 的 export）。凭据解析失败，回合被拒，UI 把消息收回。网络本身是通的——用 `curl https://api.deepseek.com/v1/models`（不带鉴权应返回 401）可以区分「网络不通」和「凭据缺失」。

**处置**：重启时显式带上密钥（密钥走环境变量，别进命令行）：
```sh
export DEEPSEEK_API_KEY=...   # 或从 zshrc 读取
node --import tsx/esm apps/cli/src/bin.ts web
```
并用 `ps eww <PID> | tr ' ' '\n' | grep -c DEEPSEEK_API_KEY` 确认进程里真的有。

## 5. 重启报「Cannot find module …/lib/index.js」

**症状**：启动 dsh web 失败，日志里有 `Cannot find module '/Users/you/.dsh/profiles/node_modules/@deepseek-ai/…/lib/index.js'` 或 typert 宿主找不到。

**根因**：跑过 `pnpm run clean`（或某些门禁序列）清掉了 `lib/` 构建产物。源码启动（tsx）覆盖插件源码，但 web profile 的加载器入口与 typert 宿主解析的是**构建输出**。

**处置**：`pnpm run build` 后再启动。规律：clean 与启动之间必须隔一次 build。

## 给排障者的三条通用经验

1. **用真实数据验证格式假设**：固件固化的是昨天的格式；对扫描窗口做整体统计（提取成功率、字节偏移）比单点调试快得多。
2. **一层修好才看得见下一层**：检索不通时看不到关键词误用，关键词修好后才暴露路由缺陷。每修一层，用同一份真实数据重跑一遍。
3. **拿会话 zip 当第一手报告**：dsh 导出的会话日志里有完整的命令参数与报错文本（`command/run` / `command/done` 记录），比转述准确得多。
