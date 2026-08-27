# dsh-agents-md-notice-gate

AGENTS workspace-instruction 变化通知确认门插件.

首次加载 workspace instructions 时保留 DSH 的完整 baseline. 后续 `AGENTS.md` / `CLAUDE.md` / `AGENTS.local.md` 等文件发生变化时, 插件把内置 loader 的完整变化消息投影为 unified diff patch. 模型仍需先按两行格式确认: 第一行是 `` [[ACK-AGENTS]]\ ``, 第二行以 `注意到 AGENTS 变化, 变化点在于:` 开头并填写具体变化内容. 确认回应不能作为本轮最终回答, 输出 marker 后必须继续原先未完成的工作.

## 特性

- 通过 `agent/pre-step` 识别 DSH 内置 `agent-instructions` 变化消息, 首次 baseline 原样保留, 后续变化替换为 unified diff patch.
- 支持项目级和用户级 instructions, 包括 `$DSH_HOME/AGENTS.md` 或 `~/.dsh/AGENTS.md`, 变化路径直接来自 DSH 的结构化 change 记录.
- 通过 `session/event` 监听结构化变化消息, 并按会话置为待确认状态.
- 在 `tools/pre-execute` 拦截后续工具调用, 未确认前返回 deny; 若模型已经输出了错误确认, 拒绝原因会指出第一行或第二行具体哪里不符合格式.
- 在 `agent/turn-stopping` 拦截待确认会话的结束, 自动 steer 模型继续一轮并完成确认; 格式错误时同样指出具体出错位置. 有效确认回应也不能作为最终回答结束本轮.
- 注入系统提示段, 明确告知模型确认协议与标记格式.
- 按 (会话, 变化 seq) 记账, 旧确认标记不会满足新变化.

## 安装

通过 dsh profile bundle 以 github archive 方式安装:

```shell
dsh plugin --profile web add "https://github.com/azazo1/dsh-agents-md-notice-gate/archive/refs/tags/v0.1.0.tar.gz"
```

> bundle 在 harness 启动时挂载, 安装后需重启 dsh 才会生效.

## 使用

插件挂载后自动生效, 无需额外配置. 当 AGENTS 等 workspace instructions 变化时, 模型必须按两行格式确认: 第一行是 `` [[ACK-AGENTS]]\ ``, 第二行以 `注意到 AGENTS 变化, 变化点在于:` 开头并填写具体变化内容, 才能继续调用工具. 确认格式不正确时, 拒绝提示会指出具体错在哪一行.

## 确认标记

默认格式为两行: 第一行 `` [[ACK-AGENTS]]\ ``, 第二行以 `注意到 AGENTS 变化, 变化点在于:` 开头并填写具体变化内容. 纯 marker, 泛泛说明或冒号后为空都会被拒绝, 也不要把确认回应与工具调用放在同一条消息中. 如果确认格式不正确, 插件会对照当前应答指出是第一行标记还是第二行说明写错, 并引用实际内容.

## License

MIT
