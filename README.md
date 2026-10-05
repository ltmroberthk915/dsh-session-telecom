# dsh-session-telecom

DeepSeek Harness 会话通信插件。复制会话 ID、向在线或已保存的会话发送消息，并查看 token 用量、计费 token 和缓存命中率。

本包从原本地会话通信插件独立改名，包名、客户端模块、菜单项、RPC 通道和模型工具均使用新名称。它与 npm 上的 `dsh-session-toolkit` 是不同项目，不依赖或升级该包。

## 安装

通过 DSH 插件管理安装 [npm 包 `dsh-session-telecom`](https://www.npmjs.com/package/dsh-session-telecom)。桌面端在插件管理页面使用包名；CLI/Web 用户可运行：

```sh
dsh plugin --profile web add dsh-session-telecom@1.0.1
```

也可安装 [GitHub Release](https://github.com/ltmroberthk915/dsh-session-telecom/releases/tag/v1.0.1) 中经过相同验证的 `.tgz`：

```sh
dsh plugin --profile web add https://github.com/ltmroberthk915/dsh-session-telecom/releases/download/v1.0.1/dsh-session-telecom-1.0.1.tgz
```

安装后重启宿主。桌面与 Web 的 profile 独立，需要分别安装。

如果所在网络无法访问 GitHub Release 附件，可使用相同版本标签的源码归档；该标签已包含构建后的客户端：

```sh
dsh plugin --profile web add https://codeload.github.com/ltmroberthk915/dsh-session-telecom/tar.gz/refs/tags/v1.0.1
```

上述安装方式都不依赖开发者电脑上的源码目录。

迁移时先备份 DSH 配置和会话。移除旧插件的依赖和 bundle 项，再安装新包；旧的配置文件可以保留在备份中。不要直接覆盖、清空用户目录或会话数据。

如果之前安装 `dsh-session-toolkit@1.0.0` 后出现 `Cannot read properties of undefined (reading 'prepare')`，仅禁用它不一定恢复：已被安装的第二份 `@deepseek-ai/dsh-tools` 仍可能遮蔽宿主内核。应通过包管理器重建正确的依赖树，确认 profile 不再有这份多余的核心包，然后重启。

## 使用

会话菜单中可复制会话 ID；会话发送面板支持选择目标、查看用量并发送消息。

模型工具名为 `session_telecom`：

```json
{"action":"list","limit":20}
```

```json
{"action":"send","targetSessionId":"目标会话 ID","text":"请继续这项工作","mode":"queue"}
```

`queue` 排到目标下一回合；`steer` 插到目标下一步。已保存的离线会话由宿主恢复。发送会唤醒目标并可能产生模型费用，应只在用户授权的通信范围内使用。投递失败返回结构化错误，不自动重复发送；成功回执不要求收件人再回复一条回执。

本插件只访问当前 DSH 宿主可见的 DSH 会话，不提供 zcode 等外部平台会话的查找、读取或接管。带 `query` 的查询没有匹配，或投递返回 `session/not-found` 时，工具描述和返回文本要求模型停止这次查找并向用户报告：不得重复查询、改词扩大搜索、扫描日志或磁盘，也不得自行启动、委派或询问 agent 继续寻找。用户补充或更正 ID、提供外部会话内容或另行完成导入后，可以继续处理该目标；当前对话仍可继续。这是插件文本中的使用规则，不会强制中止会话或封锁工具。

用量显示来自宿主已有投影，不将估算 token 当成货币价格。缺少数据时明确显示未知。

## 依赖与生命周期

- 无运行时 `dependencies`、`optionalDependencies` 或捆绑依赖；不会安装第二份 DSH 内核或 React。
- 宿主库只声明为 optional peer，使用 DSH 自身的模块解析。包安装不执行脚本、不改宿主代码。
- 工具服务就绪后才加载宿主的工具定义接口。接口缺失或注册失败只停用模型工具并记录原因；RPC 与界面保持独立。
- 卸载会取消尚未完成的工具加载，并注销已注册的工具和路由。
- 不注入“每轮必须检查收件箱”的全局要求，普通对话无需调用本插件。

上述设计防止本包再次引入同类依赖冲突；其他插件或未来宿主的不兼容改动仍需单独验证。

## 开发与验证

```sh
npm ci
npm run build:client
npm test
npm run check:package
npm pack
```

构建只使用锁定的开发依赖 `esbuild`，没有个人目录或本地源码路径依赖。客户端从宿主获得 React。发布检查会拒绝新增的自动安装依赖、非 optional 的 peer、旧包名和内联 React。

`test` 覆盖通信、参数与输出契约、菜单、用量展示及加载/卸载竞态。找不到真实内核的可选对照测试会明确跳过，不能据此宣称宿主集成通过。

完整宿主测试使用 `scripts/host-smoke.cjs`。先在隔离目录安装发布 `.tgz`，profile bundles 配置为 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dsh-session-telecom`；设置 `DSH_TEST_RUNTIME`（宿主 dsh 目录）、`DSH_TEST_PROFILE` 和 `DSH_TEST_HOME`。使用宿主的 Node/Electron 运行，Electron 需设置 `ELECTRON_RUN_AS_NODE=1` 并传入 `--expose-internals`。测试会确认调度器属于同一个内核实例，并让两个新会话分别完成工具调用和回复。模型响应由测试适配器提供，不访问模型 API，也不向真实会话发消息。

## 许可

MIT
