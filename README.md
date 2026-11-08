<p align="center">
  <img src="https://img.shields.io/npm/v/dsh-session-telecom?style=for-the-badge&color=4f46e5" alt="npm version">
  <img src="https://img.shields.io/badge/DSH-0.2.x-0ea5e9?style=for-the-badge" alt="DSH 0.2.x">
  <img src="https://img.shields.io/badge/license-MIT-22c55e?style=for-the-badge" alt="MIT">
</p>

<h1 align="center">dsh-session-telecom</h1>

<p align="center"><b>跨目录、跨项目，两条 DSH 会话直接通话。</b><br>
不用切窗口，不用复制粘贴——把「内置通话」装进任意 workspace。</p>

> 你的前端会话在 A 目录，后端会话在 B 目录。现在它们可以像同一个团队一样互发消息、来回多轮。

---

## 📂 为什么需要它

DSH 的每个会话都属于各自的 workspace / cwd；宿主内置的 `send_message` 只覆盖**有归属关系**的会话——父子 agent、或同一队 teammates。

两个**不同目录、不同项目**的独立会话之间，模型没有可用的通道：看不到对方的 session ID，也没法给对方发消息。

本插件补的就是这条缝：**按 session ID 寻址，任意两条会话直接对话**——cwd 不同、项目不同，都能像内置通话一样收发。

## ✨ 它能做什么

- **📂 跨目录 / 跨项目通话** —— 项目 A 的会话 ↔ 项目 B 的会话，A→B→A→B 来回多轮；不用把上下文搬来搬去，也不用人工复制消息。
- **🗣 与内置 `send_message` 同一条规则** —— 目标正在运行 → 消息在它的**下一个 step** 领取；目标空闲 → 直接为它**开一轮新 turn**；平等会话，没有谁是谁的爸爸。
- **⚡ 卡在长工具里也能立刻送达** —— 目标正跑着 sleep / 构建 / 脚本？一条 `wake:"tool"` 就结束它**当前那一次**工具调用（工具收到诚实的 abort），消息下一秒进入对方上下文。默认不打断，什么时候下手由发送方决定。
- **👀 只读查看，不吵醒对方** —— 会话清单（标题 / cwd / 最近活动 / 在线回答摘要 / token 与缓存命中）+ 只读 transcript（`summary` / `tail` / `raw`）。不唤醒目标、不占它的上下文。
- **💬 回信不迷路** —— `expectReply` 自动附上可直接复制的回信通道，多轮对话也知道该回给谁。
- **🧹 不给菜单添乱** —— 右键菜单里只留一行「发送消息到会话…」；「复制会话 ID」交给宿主官方菜单。

## 🎬 30 秒上手

```sh
dsh plugin --profile desktop add dsh-session-telecom
```

装好后重启宿主。之后：

- 右键任意会话 → **发送消息到会话…**（带会话清单与用量）
- 或让模型直接调用工具 `session_telecom`

```json
{"action":"list","limit":20}
{"action":"read","sessionId":"目标会话完整 ID","last":5,"mode":"summary"}
{"action":"send","targetSessionId":"目标会话完整 ID","text":"请继续这项工作"}
{"action":"send","targetSessionId":"目标会话完整 ID","text":"先把结论给我","wake":"tool"}
```

**典型场景**：前端会话 ↔ 后端会话联调；调研会话 ↔ 实现会话交接；A 项目的 agent 把结论直接甩给 B 项目的 agent——跨目录、跨项目，一条工具调用搞定。

## 🧠 和官方 `send_message` 的关系

不是替代，是补位：

- 有归属关系的会话（子代理 / 同队）→ 继续用官方 `send_message`；
- **互相独立、cwd 不同的会话** → 用本插件，规则与官方一致（运行中下一步、空闲开新轮、多轮平等）。

它补得也克制：只用宿主公开服务，**不安装第二份 DSH 内核**；投递走宿主官方 `sessionController.prompt` 通道，工具级唤醒复用宿主官方 `tools/execute` 中间件——宿主升级不带着插件一起翻车。

## 🛡 边界与安全

- 仅限**同一宿主**可见的会话（不支持跨主机远程通话）；子代理 / teammate 会话由内核统一拒收（`session/agent-busy`），不越界；
- `wake:"tool"` **只结束工具调用**：不中止整轮、不丢 inbox、不伪造结果；目标模型看到真实的 `tool call aborted`，是否重试由它决定；
- 拿不到目标 inbox 投影时**绝不**打断（宁可晚到也不误杀）；目标空闲 / 冷会话 / 自己发给自己时不登记；
- 投递失败返回结构化错误，不自动重试、不重复投递；
- 会话之间是**平等的**，插件不会替任何一方做决定。

## 🧪 兼容与开发

- DSH 0.2.x（本机实测 0.2.2-rc.1，Windows / desktop profile）
- 测试：`npm ci && npm test`（122 项，含内核契约对照）
- 构建客户端：`npm run build:client`

## 📝 更新日志

- **1.3.2** —— 文案更新：强调**跨目录 / 跨项目的会话内置通话**；无代码变更。
- **1.3.1** —— 移除「复制会话 ID」右键菜单行（宿主官方菜单已自带）；客户端减重。
- **1.3.0** —— 新增 `wake:"tool"` 工具级唤醒：目标卡在长工具里也能立刻送达。
- **1.2.0** —— 默认投递方式改为 `steer`：运行中下一步领取、空闲直接开新轮，不再排到下一轮。
- **1.1.0** —— 新增 `read` / `peek` 只读查看与 `expectReply` 回信通道。
- **1.0.0** —— 首个公开版本：会话清单、跨会话投递、用量展示。

## License

MIT
