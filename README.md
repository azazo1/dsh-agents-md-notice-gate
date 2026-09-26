# dsh-agents-md-notice-gate

AGENTS workspace-instruction 变化通知确认门插件.

首次加载 workspace instructions 时保留 DSH 的完整 baseline. 后续 `AGENTS.md` / `CLAUDE.md` / `AGENTS.local.md` 等文件发生变化时, 插件把变化投影为 unified diff, 并附上 `[[REQ-AGENTS]]`. 模型只有看到该标记才用两行 `[[ACK-AGENTS]]` 确认, 未确认前拦截工具调用和过早结束.

没有待确认变化时, 模型自行输出的 `[[ACK-AGENTS]]` 会被忽略: 既不解除门禁状态, 也不会触发 "确认之后继续本轮" 的追问.

## 安装

Web 端装进 `web` profile:

```shell
dsh plugin --profile web add azazo1/dsh-agents-md-notice-gate
```

装完重启 `dsh web`, 浏览器里刷新一次页面.

桌面端装进 `desktop` profile. 它由 Electron 应用独占管理, `dsh plugin` 会拒绝 `--profile desktop`, 所以要用应用内的插件管理器: 在插件页的安装入口填上面命令里对应的包名或本地目录. 装上后重启应用, 窗口刷新一次.

引擎版本线要求 `@deepseek-ai/dsh-*` 不低于 `0.1.7-rc.2`, 且仍在 `0.1.x` 上. 更早的引擎线装不上这个版本.

web 与 desktop 两个 profile 跑的是同一套 Web 应用, 桌面端只是多起一个 Host 子进程并给 `<html>` 打上平台标记, 所以同一份包在两边通用, 不需要分别构建.

## 使用

插件挂载后自动生效, 无需额外配置. 确认协议由系统提示段给出.

## License

MIT
