# 配置、协议与参考

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


