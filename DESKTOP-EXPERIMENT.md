> 旧的全局 Provider 切换实验已停用。当前使用双 Provider 共存方案，安装与回滚以 README.md 的「桌面应用双 Provider 实验」为准。

# 桌面接入实验

本机桌面应用内置后端版本：`0.162.0-alpha.17.2`。

独立配置的 app-server 已通过真实 Kiro 问答、连续聊天、文件修改和命令回读。沿用完整个人配置的 app-server 两次复现 `stream disconnected before completion / error decoding response body`，原因尚未确定；有远程 MCP 初始化失败的伴随日志，尚不能认定它是根因。桌面界面验证尚未完成，电脑控制工具禁止操作该应用。

当前实验已启用到 `~/.codex/config.toml`，新本地聊天的默认 provider 为 `kiro-desktop-experiment`、模型为 `auto`。原配置完整备份，恢复操作已经实际运行验证。除模型路由相关根字段及新增 provider 外，无关配置均保持不变。当前网关运行于 `127.0.0.1:8765`，不是开机自启动服务。

## 手动试验

1. `⌘Q` 完全退出桌面应用，再重新打开。
2. 新建本地聊天，将工作目录设为 `~/.config/codex-kiro/desktop/workspace`。
3. 确认选择 `Kiro auto` / `Company Kiro (Desktop Experiment)`。如果仍显示个人 GPT 模型，不发送测试，先检查配置是否加载。
4. 发送：`只回复 desktop-kiro-ok，不要调用工具。`
5. 用新增网关日志确认实际路由：

```sh
tail -f ~/.config/codex-kiro/desktop/gateway.log
```

收到文本回答并出现本次新增的 `completed backend=kiro-cli` 才能确认模型路由成功；只收到回答不够。首次文本试验不发送公司代码。

成功后，在同一个聊天发送：

```text
仅操作当前目录：使用 apply_patch 把 answer.txt 的 before 改成 desktop-ui-ok，再执行 cat answer.txt 验证。不要修改其他文件。
```

## 回滚

```sh
node /absolute/path/to/codex-kiro/src/desktop.mjs restore
```

出现 `Original configuration restored byte-for-byte` 后，再 `⌘Q` 并重新打开应用，新建个人本地聊天。回滚不删除账号登录或聊天记录，也不关闭网关。若启用后自行改过配置，脚本会拒绝覆盖新的改动，需与原备份合并。

状态：

```sh
node /absolute/path/to/codex-kiro/src/desktop.mjs status
```

网关不在运行时重新准备：

```sh
node /absolute/path/to/codex-kiro/src/desktop.mjs prepare
```

自动测试为 14/14 通过；这不代表桌面完整配置下的端到端验证已通过。
