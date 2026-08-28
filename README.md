# dsh-agents-md-notice-gate

AGENTS workspace-instruction 变化通知确认门插件.

首次加载 workspace instructions 时保留 DSH 的完整 baseline. 后续 `AGENTS.md` / `CLAUDE.md` / `AGENTS.local.md` 等文件发生变化时, 插件把变化投影为 unified diff, 并要求模型先确认, 未确认前拦截工具调用和过早结束.

## 安装

通过 dsh profile bundle 安装:

```shell
dsh plugin --profile web add azazo1/dsh-agents-md-notice-gate
```

> bundle 在 harness 启动时挂载, 安装后需重启 dsh 才会生效.

## 使用

插件挂载后自动生效, 无需额外配置. 确认协议由系统提示段给出.

## License

MIT
