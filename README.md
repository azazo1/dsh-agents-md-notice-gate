# dsh-agents-md-notice-gate

AGENTS workspace-instruction 变化通知确认门插件。

当 AGENTS.md / CLAUDE.md / AGENTS.local.md 等 workspace instructions 文件发生变化时, 本插件强制模型先单独输出确认标记 `[[ACK-AGENTS]]`, 未输出前拒绝一切工具调用, 直到模型发出该指定格式回应. 这样可避免模型看到变化通知后, 直接以一句提醒草草结束回合, 中断原本正在进行的任务.

## 特性

- 通过 `session/event` 监听变化通知 (以 `Updated instructions from:` / `Additional instructions from:` / `Instructions removed:` 开头的 `<system-reminder>` 用户消息), 并按会话置为待确认状态.
- 在 `tools/pre-execute` 拦截后续工具调用, 未确认前返回 deny 并提示模型先输出确认标记.
- 注入系统提示段, 明确告知模型确认协议与标记格式.
- 按 (会话, 变化 seq) 记账, 旧确认标记不会满足新变化.

## 安装

通过 dsh profile bundle 以 github archive 方式安装:

```shell
dsh plugin --profile web add "https://github.com/azazo1/dsh-agents-md-notice-gate/archive/refs/tags/v0.1.0.tar.gz"
```

> bundle 在 harness 启动时挂载, 安装后需重启 dsh 才会生效.

## 使用

插件挂载后自动生效, 无需额外配置. 当 AGENTS 等 workspace instructions 变化时, 模型必须先单独输出一行 `[[ACK-AGENTS]]` 才能继续调用工具.

## 确认标记

默认标记为 `[[ACK-AGENTS]]`. 模型应将其作为单独一条消息输出, 不要混入普通说明文字, 也不要与其他工具调用放在同一条消息.

## License

MIT
