# Codex → Kiro CLI

从零实现的本地网关。Codex 使用 OpenAI Responses 协议，网关通过官方 `kiro-cli acp` 使用当前 Kiro 登录账号。没有 OpenAI 模型请求、没有 OpenAI 回退、不会读取或导出 Kiro 登录凭据。

```text
Codex CLI → /v1/responses → Kiro CLI ACP v2 → Kiro 模型
    ↑                            ↓
    └── function/custom call ← codex MCP 工具桥接
```

需要 Node.js 22+、Codex CLI、Kiro CLI，并先用公司账号执行 `kiro-cli login`。当前实现固定 ACP v2；不支持 V3。

## 使用

无需安装 npm 依赖。交互启动：

```sh
cd codex-kiro
npm run doctor
npm run codex
```

在公司的项目目录启动（Codex 的工作目录就是当前目录）：

```sh
cd /你的公司项目
node /absolute/path/to/codex-kiro/src/cli.mjs run
```

自动启动本地网关，并在 Codex 退出时关闭本次启动的网关。只连接 `127.0.0.1:8765`。首次生成本地网关密码，存放于 `~/.config/codex-kiro/gateway-key`，文件权限为 `0600`；这是本地连接密码，不是公司账号凭据。

默认使用独立 `CODEX_HOME=~/.config/codex-kiro/codex`，避免影响个人 Codex 配置、登录和模型缓存。项目内的 `AGENTS.md` 仍由 Codex 读取。无需 `codex login`，无需 `OPENAI_API_KEY`。通过 `KIRO_CODEX_HOME` 可指定另一独立配置目录。

文本调用验证：

```sh
node /absolute/path/to/codex-kiro/src/cli.mjs run \
  exec --skip-git-repo-check --ephemeral '只回复 Kiro OK，不要调用工具'
```

工具闭环验证（建议先在临时项目测试）：

```sh
node /absolute/path/to/codex-kiro/src/cli.mjs run \
  exec --skip-git-repo-check --ephemeral --sandbox read-only \
  '使用 exec_command 执行 printf kiro-tool-ok，然后根据实际输出回答'
```

指定 Kiro 模型时，先用 `npm run models` 获取实际模型 ID（Kiro 也可能提供 GPT 系列）：

```sh
KIRO_MODEL='<真实 Kiro 模型 ID>' \
  node /absolute/path/to/codex-kiro/src/cli.mjs run
```

默认 `auto` 表示保留 Kiro CLI 的默认模型。指定模型失败会返回错误，不会静默切换。`/v1/models` 从当前登录的 Kiro CLI 动态获取列表，缓存 60 秒；`?refresh=1` 强制刷新。公开 ID 使用 `kiro/` 前缀，网关去掉前缀后交给 CLI。列表与切换成功不保证每个模型都能完成推理。

## 独立运行网关

```sh
node src/cli.mjs serve
```

也可以使用环境变量启动：

```sh
KIRO_GATEWAY_KEY='<自选本地密码>' npm start
```

`.env.example` 仅供参考，不会自动加载 `.env`。配置项：

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `KIRO_GATEWAY_KEY` | 启动器自动生成 | 本地 Bearer 密码，直接运行 server 时必填 |
| `KIRO_GATEWAY_PORT` | `8765` | 本地网关端口 |
| `KIRO_CLI_PATH` | `kiro-cli` | CLI 路径；找不到时填绝对路径 |
| `KIRO_MODEL` | `auto` | 保留 CLI 默认模型或选择真实模型 ID |
| `KIRO_TIMEOUT_MS` | `180000` | 单次 ACP 请求超时 |
| `KIRO_CODEX_HOME` | `~/.config/codex-kiro/codex` | 独立 Codex 配置目录 |
| `CODEX_BIN` | `codex` | Codex 可执行文件 |

手动配置其他 Codex 客户端的 provider（桌面后端已验证；桌面共存安装见下文）：

```toml
model = "auto"
model_provider = "kiro"
web_search = "disabled"

[model_providers.kiro]
name = "Company Kiro CLI"
base_url = "http://127.0.0.1:8765/v1"
wire_api = "responses"
env_key = "KIRO_GATEWAY_KEY"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
```

手动配置时，客户端与网关的 `KIRO_GATEWAY_KEY` 必须一致。推荐使用启动器，自动处理密码及 provider 参数。

## 工具执行机制

网关将 Codex 的 function/custom 工具定义转换成临时 MCP server。Kiro 在隔离的临时目录启动，自定义 agent 仅暴露 `@codex` 工具，禁止原生 shell/fs 工具；网关不执行命令、不编辑公司代码。

Kiro 通过 MCP 选择工具后，网关结束当前 ACP 进程并返回 Responses `function_call` 或 `custom_tool_call`。Codex 在自身权限与沙箱下执行，下一轮发送实际 `function_call_output`。网关把完整历史转换成标注角色的 JSON 文本，交给一个新的 ACP 会话继续。

此设计避免保留挂起的工具调用，但每次工具操作会新建 CLI 进程、重传上下文。Codex 的 `instructions` 写入临时 Kiro agent 的系统提示词。ACP 没有 Responses 的原生角色历史接口，历史以角色标注的 JSON 文本传递，语义不等同于原生模型 API。真实模型的连续编辑与工具结果回传已验证；复杂长会话仍需持续验证。工具权限仍由 Codex 控制，不启用 `--trust-all-tools`。

支持：文本、SSE、function 工具、namespace 工具、custom 工具（包括 `apply_patch` 原始输入）、多轮工具结果、超时与断连取消。每轮最多返回一个工具调用。custom grammar 以说明形式提供给 Kiro，不保证语法约束。

暂不支持：图片、音频、内置 web search、Responses WebSocket、`previous_response_id`、服务器持久化、后台请求、结构化最终输出。指定 unsupported 功能会报错。reasoning 和 verbosity 参数不映射；加密 reasoning 项丢弃。`max_output_tokens` 未强制执行。usage 为 `null`，不伪造 Kiro 计费量；Codex 可能显示 0 tokens，不能据此判断免费。真实额度请在 Kiro 中核对。

`GET /health` 只检查网关存活；它不会证明登录有效或模型能调用。日志仅记录请求 ID、后端、模型、工具次数或错误代码；不记录提示词、工具内容和账号 token。Kiro 自身可能保存会话历史，请遵循公司对 Kiro 的现有使用规则。

## 验证与参考

```sh
npm test
```

测试用模拟 ACP 进程覆盖 SSE 生命周期、工具闭环、custom 输入、认证、模型选择错误、超时清理和客户端断连。真实 Codex CLI 配合模拟 Kiro 已跑通 `exec_command` 及结果回传；真实 Kiro 验证结果见 `VALIDATION.md`。

参考协议与开源设计，未复制项目源码：

- [Kiro ACP 官方文档](https://kiro.dev/docs/cli/acp/)
- [Kiro 自定义 agent 配置](https://kiro.dev/docs/custom-agents/configuration-reference/)
- [Codex provider 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex 0.147.0 模型元数据结构](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/protocol/src/openai_models.rs)
- [ankitcharolia/kiro-gateway](https://github.com/ankitcharolia/kiro-gateway)：CLI/ACP 桥接路线
- [工具转发相关 issue](https://github.com/ankitcharolia/kiro-gateway/issues/31)：确认直接发送 tools 元数据不足以接入 Codex 工具
- [Echoxiawan/kiro-gateway](https://github.com/Echoxiawan/kiro-gateway)：Responses 生命周期参考


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

候选签名流程移除本地临时签名不能承载的原厂受限权限，给候选可执行程序添加库加载权限，并同步 ASAR、外置原生模块及框架内完整性摘要后重新签名。安装器检查权限与摘要一致性。静态签名通过不能代替实际启动测试；详细证据见 [VALIDATION.md](VALIDATION.md)。

桌面设计参考 [Better Codex App Custom Provider Support](https://github.com/Keksuccino/Better-Codex-App-Custom-Provider-Support)（Unlicense），为上述构建移植局部路由补丁。
