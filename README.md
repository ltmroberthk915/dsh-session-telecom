<p align="center">
  <img src="https://img.shields.io/npm/v/dsh-session-telecom?style=for-the-badge&color=4f46e5" alt="npm version">
  <img src="https://img.shields.io/badge/DSH-0.2.x-0ea5e9?style=for-the-badge" alt="DSH 0.2.x">
  <img src="https://img.shields.io/badge/license-MIT-22c55e?style=for-the-badge" alt="MIT">
</p>

<h1 align="center">dsh-session-telecom</h1>

<p align="center"><b>让两条原本互不相识的 DSH 对话，像同事一样聊起来。</b><br>
跨会话通话 · 工具级唤醒 · 只读查看 · 用量透明</p>

> 你在 A 里干活，B 那边还在跑长任务。想让它俩直接对接？现在一行工具调用就够。

---

## ✨ 它能做什么

- **🗣 任意会话直接对话** —— 给任意 DSH 会话发消息，A→B→A→B 来回多轮。目标正在运行 → 消息在它的**下一个 step** 领取；目标空闲 → 直接为它**开一轮新 turn**（与内核 agent↔subagent 的 `send_message` 同一条规则）。
- **⚡ 卡在长工具里也能立刻送达** —— 目标正跑着 sleep / 构建 / 脚本？一条 `wake:"tool"` 就结束它**当前那一次**工具调用（工具收到诚实的 abort），消息下一秒进入对方上下文。默认不打断，什么时候下手由发送方决定。
- **👀 只读查看，不吵醒对方** —— 会话清单（标题 / cwd / 最近活动 / 在线回答摘要 / token 与缓存命中）+ 只读 transcript（`summary` / `tail` / `raw`）。不唤醒目标、不占它的上下文、不算它的账。
- **💬 回信不迷路** —— `expectReply` 自动附上可直接复制的回信通道，多轮对话也知道该回给谁。
- **🧹 不给菜单添乱** —— 右键菜单里只留一行「发送消息到会话…」；「复制会话 ID」交给宿主官方菜单，不再重复占位。

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

## 🧠 为什么用它

宿主自带的 `send_message` 只服务于**有归属关系**的会话：父子 agent、或同一队 teammates。你手边两条彼此独立的对话，官方没有模型可用的通道——这正是本插件补的那条缝。

而它补得相当克制：

- 只用宿主公开服务，**不安装第二份 DSH 内核**，不复制 `@deepseek-ai/*` 依赖；
- 投递走宿主官方 `sessionController.prompt` 通道（发送方署名、幂等、冷会话唤醒都由宿主负责），宿主升级不带着插件一起翻车；
- 工具级唤醒复用宿主官方的 `tools/execute` 中间件机制，和社区同类插件同一套路数。

## 🛡 边界与安全

- 子代理 / teammate 会话由内核统一拒收（`session/agent-busy`）——它们的对话该走官方 `send_message`，本插件不越界；
- `wake:"tool"` **只结束工具调用**：不中止整轮、不丢 inbox、不伪造结果；目标模型看到的是真实的 `tool call aborted`，是否重试由它决定；
- 拿不到目标 inbox 投影时**绝不**打断（宁可晚到也不误杀）；目标空闲 / 冷会话 / 自己发给自己时不登记；
- 投递失败返回结构化错误，不自动重试、不重复投递；
- 会话之间是**平等的**，插件不会替任何一方做决定。

## 📚 常用姿势

**列会话 + 看用量**

```json
{"action":"list","query":"关键词","limit":20}
```

**接管前先读对方进度（不唤醒）**

```json
{"action":"read","sessionId":"session-…","last":5,"mode":"summary"}
```

**多轮对话**：第一次带 `expectReply`，对方回信时按指引 `send` 回来即可；需要立刻送达就加 `wake:"tool"`。

## 🧪 兼容与开发

- DSH 0.2.x（本机实测 0.2.2-rc.1，Windows / desktop profile）
- 测试：`npm ci && npm test`（122 项，含内核契约对照）
- 构建客户端：`npm run build:client`

## 📝 更新日志

- **1.3.1** —— 移除「复制会话 ID」右键菜单行（宿主官方菜单已自带）；客户端减重。
- **1.3.0** —— 新增 `wake:"tool"` 工具级唤醒：目标卡在长工具里也能立刻送达。
- **1.2.0** —— 默认投递方式改为 `steer`：运行中下一步领取、空闲直接开新轮，不再排到下一轮。
- **1.1.0** —— 新增 `read` / `peek` 只读查看与 `expectReply` 回信通道。
- **1.0.0** —— 首个公开版本：会话清单、跨会话投递、用量展示。

## License

MIT
