# macOS 桌面接入指南

## macOS 桌面应用：OpenAI / Kiro 共存

2026-10-12 已由用户验证：补丁应用启动成功，启用混合模型目录并绕过本地代理后，桌面 Kiro 调用成功。当前模型发现结果为 11 个原生模型 + 21 个 Kiro 选项。21 个 Kiro 模型接受切换，但未逐个验证推理；auto 已完成工具闭环验证，指定 Haiku 的完整烟测曾断流。

桌面补丁针对 **26.1007.30912**，本地实测 macOS 14.5 / Apple Silicon、Kiro CLI 2.29.1、捆绑 Codex 0.162.0-alpha.17.2。其他构建尚未验证；准备脚本遇到不匹配会失败。此方案修改桌面应用资源并使用本地临时签名，属于实验性方案，更新应用后可能需要重新准备。通知、钥匙串共享和电脑控制等原厂能力未验证。

### 准备候选副本

需要 Python 3.11+、Node.js 22+、Kiro CLI 已登录，以及位于 `/Applications/ChatGPT.app` 的目标桌面应用。Python 仅使用标准库；补丁脚本通过 `npx prettier@3.6.2` 格式化目标 JavaScript，需要首次下载工具。

在本仓库根目录执行：

```sh
node src/desktop.mjs prepare
node src/coexist.mjs
python3 scripts/prepare-desktop-patch.py
```

这些命令准备模型目录、候选配置、候选应用及本地网关，不改主配置或替换原应用。候选位于 `~/.config/codex-kiro/coexist/ChatGPT-Kiro-staged.app`。

完全退出原应用后，先测试候选副本：

```sh
"$HOME/.config/codex-kiro/coexist/ChatGPT-Kiro-staged.app/Contents/MacOS/ChatGPT" > /tmp/codex-kiro-launch.log 2>&1
```

此时尚未启用 Kiro 主配置，列表可能只有原生模型。确认候选正常启动后，⌘Q 退出候选再安装：

```sh
python3 scripts/manage-desktop.py install
./scripts/launch-desktop.command
```

安装保留个人默认模型/provider，并添加混合模型目录及独立 `kiro` provider。新建本地聊天，选择 `Kiro · Auto`；跨 OpenAI/Kiro 切换需要新建聊天。OpenAI 使用个人账号，Kiro 使用 CLI 登录账号，Kiro 失败不会回退 OpenAI。

### 代理与 502

建议使用 `./scripts/launch-desktop.command` 启动。脚本启动网关，并让应用与继承的 app-server 通过 `NO_PROXY` / `no_proxy` 绕过本地地址，保留外网代理。已实测本地 7890 代理会令本地请求返回 502，而直连同一网关成功；使用该启动方式后用户确认桌面调用正常。

### 回滚

⌘Q 完全退出应用后执行：

```sh
python3 scripts/manage-desktop.py restore
open /Applications/ChatGPT.app
```

原应用和原配置保存在 `~/.config/codex-kiro/coexist/backups/`。回滚撤回本次 provider 和模型目录，保留安装后修改的其他偏好；应用若已更新，则保留新版应用，仅撤回配置。不删除聊天或退出登录。

### 刷新模型

```sh
node src/coexist.mjs --refresh
```

刷新后重启桌面应用。模型列表来自当前登录 CLI；模型出现或接受切换不代表账号对该模型的推理权限已验证。

### 启动兼容处理

候选签名流程移除本地临时签名不能承载的原厂受限权限，给候选可执行程序添加库加载权限，并同步 ASAR、外置原生模块及框架内完整性摘要后重新签名。安装器检查权限与摘要一致性。静态签名通过不能代替实际启动测试；详细证据见 [VALIDATION.md](../VALIDATION.md)。

桌面设计参考 [Better Codex App Custom Provider Support](https://github.com/Keksuccino/Better-Codex-App-Custom-Provider-Support)（Unlicense），为上述构建移植局部路由补丁。
