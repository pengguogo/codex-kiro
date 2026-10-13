# Codex 工具兼容

## 一条工具链的三个条件

1. **客户端暴露**：Codex 必须把工具定义发送到网关。账号权限、插件启用状态、模型元数据和桌面版本都会影响这一步。
2. **网关转交**：function、custom、namespace 转成临时 MCP 工具；客户端 `tool_search` 转成搜索工具，返回原生 `tool_search_call`。
3. **结果回传**：Codex 执行后回传实际结果。文本进入角色历史，嵌入图片转换为 ACP 图片块。初始化时检查 Kiro 的 `promptCapabilities.image`；不支持时明确失败。

模型说“工具不可用”不能独立证明故障发生在哪一步。需要结合客户端实际工具列表、网关响应及调用结果判断。

## 生图与看图

| 工具形式 | 执行位置 | 网关行为 |
| --- | --- | --- |
| 客户端 function，如 `image_gen` namespace 下的 `imagegen` | Codex/插件关联服务 | 按原始 namespace + name 转交；需客户端确实暴露 |
| Responses `image_generation` | OpenAI 服务端 | 明确拒绝；Kiro 没有该托管服务 |
| 附带的 `web_search` / `web_search_preview` 定义 | OpenAI 服务端 | 自动请求中不暴露给 Kiro，保留其他客户端工具；强制托管搜索仍报错 |
| `view_image` 或 MCP 截图返回的嵌入图片 | Codex 读取，Kiro 理解 | 将 `input_image` data URL 转成 ACP image block |
| 客户端 `tool_search` | Codex | 搜索结果里的工具 schema 在下一轮载入 |

图片支持 base64 PNG/JPEG/WebP/GIF。远程 URL、OpenAI file ID 和音频暂不支持。图片不作为 base64 文本塞进模型提示词；历史中保留编号，真实图片以相同编号附加。具体模型仍需具备视觉能力。网关请求体限制 16 MiB。

客户端生图函数的服务权限和额度由其后端决定。转交函数不会把 OpenAI 生图额度转换成 Kiro 额度。

官方协议参考：[工具搜索](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/tool_search_spec.rs)、[Responses 调用项](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs)、[OpenAI 生图服务](https://developers.openai.com/api/docs/guides/image-generation)、[Kiro ACP](https://kiro.dev/docs/cli/acp/)。

## 更新与排查

模型目录更新后需重启桌面，并新建 Kiro 聊天，避免旧聊天保留“无法使用工具”的历史结论：

```sh
cd /path/to/codex-kiro
npm ci
node src/coexist.mjs --refresh
./scripts/launch-desktop.command
```

先退出桌面应用，再使用启动器。网关代码更新后也需重启网关。`GET /health` 只验证进程存活；不证明生图服务、模型视觉能力或工具执行成功。

本地回归测试：

```sh
npm ci
npm test
```

回归使用模拟 ACP，验证图片块传递、能力拒绝、工具搜索、加载后的路由和结构化答案校验，不是生图实测。真实工具可用性需在目标桌面聊天中确认。

## 尚未兼容

OpenAI 托管工具（包括网页搜索、生图）、音频、Responses WebSocket、服务器持久化和后台请求。

JSON Schema 最终输出已接入：将所需格式交给 Kiro，缓冲答案并通过 JSON 解析和 Ajv 校验后才发送。与原生约束解码相比，模型仍可能不遵守格式；失败返回 `invalid_structured_output`。未知 schema 约束明确拒绝，不静默忽略；不做类型转换、补字段或替换审批结论。不会把审查失败自动转换成批准，也不修改 Codex 的权限策略。

## 默认模型错配修复

桌面选择 Kiro 曾将全局 `model` 保存成 `kiro/...`，同时全局 provider 仍为 OpenAI，导致部分请求报 “model is not supported when using Codex with a ChatGPT account”。新版候选保护 `setDefaultModelConfig`：Kiro 选择返回桌面已有的 `okOverridden`，使用界面临时选择，不写入全局默认。

已安装旧补丁的用户，先完全退出桌面，再升级候选：

```sh
python3 scripts/prepare-desktop-patch.py
python3 scripts/manage-desktop.py upgrade
node src/desktop.mjs restart
./scripts/launch-desktop.command
```

`upgrade` 根据原始安装备份修复错配的默认模型与推理设置，保留 Kiro provider、模型目录、插件和其他个人设置。原始 `restore` 仍撤回整个共存安装。候选准备不会替换正在运行的应用。

## Custom 工具参数纠正

Custom 工具必须使用 MCP 参数 `{"input":"完整原始工具文本"}`，不能传对象、数组、数字或其他字段。网关在转交 Codex 前校验；错误作为 MCP 工具错误回给 Kiro，允许自行纠正。单个 Responses 请求累计 3 次错误后以 `invalid_tool_arguments` 明确失败，任何错误调用都不会交给 Codex 执行。

诊断日志记录请求 ID、工具名、错误次数、参数形状及字段类型，不记录参数值或原始工具正文。模型未纠正时仍可能失败，但一次错误不再直接中断整轮。
