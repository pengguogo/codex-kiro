# 验证记录

验证日期：2026-10-12（Asia/Shanghai）。Node 22、Codex CLI 0.147.0、Kiro CLI 2.29.1，ACP v2。Kiro 使用用户已登录的公司账号，未读取或导出账号 token。

## 自动测试

`npm test`：13/13 通过。

覆盖认证、JSON 文本响应、SSE 事件序列、MCP → function_call → 实际结果回传、custom apply_patch 输入、工具关闭、模型选择错误、超时、断连、namespace、原生工具拒绝、未安装 CLI、启动阶段取消不遗留进程。

## 真实链路

1. **实际 Kiro 文本推理**：通过本地 `/v1/responses` 请求“只回复 Kiro OK”，HTTP 200，最终内容 `Kiro OK`。
2. **真实 Codex + 真实 Kiro shell 调用**：Kiro 通过 codex MCP 选择 `exec_command`；Codex 执行 `/bin/zsh -lc 'printf kiro-tool-ok'`；输出 `kiro-tool-ok`，exit code 0。第二次模型请求根据回传结果完成回答。
3. **真实 Codex + 真实 Kiro 文件修改与回读**：在临时目录创建 `answer.txt`，内容为 `before`。Kiro 返回 custom `apply_patch`；Codex 的 `file_change` 状态为 `completed`。随后 Kiro 返回 `exec_command`，Codex 执行 `cat answer.txt`，输出 `kiro-edit-ok\n`，exit code 0。第三轮 Kiro 据实际结果完成回答。
4. **最终版本复核**：将 Codex instructions 放入临时 Kiro agent 的系统提示词后，真实 CLI 请求“请只回复中文：验证通过”，得到 `验证通过。`。最终 `npm test` 仍为 13/13 通过；本地模型 catalog 已消除 unknown-model 元数据警告。

文件修改验证命令：

```sh
node /absolute/path/to/codex-kiro/src/cli.mjs run exec \
  --skip-git-repo-check --ephemeral --json --sandbox workspace-write \
  '使用 apply_patch 将 answer.txt 从 before 改成 kiro-edit-ok，然后用 exec_command 执行 cat answer.txt 验证'
```

实际模型请求日志显示 `backend=kiro-cli`。网关代码没有 OpenAI 上游或回退配置；启动器显式选择 `kiro` provider，使用独立 Codex home。未记录或比对 Kiro 账户账单，因此不能量化此次验证消耗的公司额度。

Codex 显示的 token 使用量为 0，是网关没有 Kiro token 计数时的客户端展示，不代表没有消耗 Kiro 额度。全局安装的大量 skills/plugins 可能触发 Codex 的上下文预算或远程插件目录警告，不影响已验证的模型与工具链路。

桌面 Codex、自定义 grammar 强制约束、图片、ACP v3、长会话压缩未验证。本版明确拒绝不支持的请求功能，并使用每轮新建 ACP 会话的方式重放历史。


## 2026-10-12 双 Provider 共存进展

- 桌面捆绑 app-server 0.162.0-alpha.17.2 加载个人完整配置，使用进程级覆盖（未修改主配置）：32 个模型，包括 11 个原模型及 21 个 Kiro 模型。OpenAI 线程仍使用 OpenAI，未请求其推理。
- Kiro ACP 的 21/21 模型接受 session/set_model；记录在 ~/.config/codex-kiro/coexist/model-selection-check.json。这是模型选择验证，并非 21 个模型的推理验证。
- 完整个人配置的 auto 实测通过文本、连续对话、apply_patch、读取文件与结果回传。修复了上游不接受工具根 schema anyOf/oneOf/allOf 的问题，包装后保留约束并还原参数。
- 指定 claude-haiku-4.5 已完成文本和 3 次工具请求，但后续流断开，完整烟测失败；不能标记此模型完整通过。
- 候选桌面应用深度签名验证通过，未安装到 /Applications；离线验证了路由逻辑和跨 Provider 切换保护。桌面界面端到端验证待用户安装后进行。
- 回滚测试证明桌面偏好变动可保留，不再依赖整份配置哈希一致。

## 桌面启动失败根因及修正

2026-10-12 17:36—17:38（北京时间）amfid 日志明确记录 Restricted entitlements not validated，错误 -420。原候选使用 adhoc 签名，却保留 com.apple.developer.*、application identifier、application groups 和 keychain groups 等受限 entitlement。codesign 静态 verify 没覆盖系统启动权限校验。

新增 scripts/local-sign.py，自内向外重签候选包并移除上述受限 entitlement，保留其他运行权限；静态签名和受限权限扫描通过。安装器加入受限权限检查。18 项测试仍通过。只修改候选副本，已恢复的 /Applications 应用未修改。候选实际启动及原生账号访问待手动验证；不得把静态检查当作启动通过。

候选 17:46:54 再次失败：已通过进程启动阶段，主程序 dlopen Codex Framework 时因 Library Validation 拒绝无 Team ID 框架，随后 SIGABRT。新增仅候选 app/辅助可执行程序的 com.apple.security.cs.disable-library-validation 权限，以支持 adhoc 框架加载。此权限放宽该进程的库校验，未修改系统安全设置；实际启动仍待验证。

17:58:40 报告仍在同一 Electron/Node 初始化位置 SIGTRAP。离线检查发现重签改变了 7 个 ASAR unpacked 原生模块的字节，但旧完整性记录未更新。修正 local-sign.py：签完内部文件后刷新 unpacked 大小/哈希/分块，保留 packed 内容与偏移，再更新 Info.plist 头哈希并签外层应用。fixture 验证 packed 内容保留；候选 16 个 unpacked 项全部哈希匹配。具体运行时 fatal 输出仍未获得，启动成功尚未确认。

18:04:58 终端日志确认 FATAL archive.cc:240: Failed to get integrity for validatable asar archive。新版 Electron 的 integrity_digest.mm 将 Info.plist ElectronAsarIntegrity 字典摘要存入框架 __asar_integrity slot。原安装框架的唯一 slot used=1/version=1，与原字典摘要精确匹配，验证了布局。候选更新 ASAR/字典后遗漏了框架摘要。现同步 SHA256(path+algorithm+hash，按 key 排序)，保留 used/version 与校验机制，再签框架/外层。安装检查加入字典摘要一致性校验。实际启动仍待验证。源码：https://raw.githubusercontent.com/electron/electron/main/shell/common/asar/integrity_digest.mm

用户确认修正框架摘要后候选应用成功启动。当前主配置未启用 model_catalog_json 和 model_providers.kiro，所以候选界面暂未显示 Kiro；已准备目录有 32 个模型，网关存活。双 Provider 界面和 Kiro 推理验收尚待安装增量配置后执行。

桌面报 502 时，直连认证 Responses auto 请求返回 HTTP200/KIRO_OK；强制通过 127.0.0.1:7890 代理访问本地 health 返回502。原网关日志无桌面请求，说明代理路径是明确嫌疑。新增仅设置 NO_PROXY/no_proxy 的启动脚本，不修改系统代理。桌面验证待重启后完成。

用户确认使用 NO_PROXY/no_proxy 启动脚本后桌面 Kiro 调用成功。桌面启动与基本文本调用通过；不将此结果扩展为所有模型推理、原厂能力或复杂长任务均已通过。

工具循环根因已查证：受影响会话中 mcp__cua_repl.js 调用了29次，Codex 每次返回 unsupported call。mapTools 将所有 namespace 回映射成 namespace.tool，MCP namespace 实际需要 mcp__server__tool 格式。修正仅 MCP 前缀命名空间，保留普通命名空间的点号路由；新增回归测试。

## 2026-10-13 本地工作区读取与 namespace 修正

实际会话记录显示 MCP 工具返回 unsupported call，而未尝试本地终端读取，不能据此认定 hkid 访问被拒绝。此前仅改分隔符的修正不完整：Codex ResponseItem FunctionCall 要求 name 和 namespace 分开传递。修正 mapTools 和 ResponseWriter 为叶子 name + 独立 namespace，并保留历史 namespace。21项测试通过，包含实际网关输出字段回归。

用个人完整配置、桌面捆绑 app-server、kiro/gpt-5.6-sol 在 /Users/USER/Desktop/hkid 做只读验收：产生真实 commandExecution 事件，执行 pwd 和 ls -d .，返回工作区路径及退出码0；未修改项目文件。这证明本地工作区终端访问可用，不代表所有 MCP 插件操作均已实测。

协议来源：https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs

2026-10-13 session/new 曾缺失模型目录；实时探测 Kiro CLI 2.30.0 已正常返回21项，持续故障未复现。推理入口改为目录暂缺时依旧调用 session/set_model 显式校验所选模型，切换成功才推理，拒绝仍报错，无自动降级。新增目录缺失时成功/拒绝回归测试，23项通过。


## 2026-10-13 图片、插件发现与结构化输出

Kiro CLI 2.30.0 的 ACP initialize 实测返回 promptCapabilities.image=true、audio=false。网关此前只传文本，图片工具结果被作为 base64 文本放入历史，现将用户与 function/custom 输出中的嵌入图片转换为真正的 ACP image block，保留角色历史里的编号；不支持图片的 ACP 引擎明确报错。模型目录开启图片输入、客户端工具搜索及插件/应用使用指引。

新增客户端 tool_search → tool_search_call 路由，并从后续 tool_search_output 加载实际返回的工具定义，保留 namespace + name。模拟 ACP 回归验证搜索、返回 image_gen 命名空间工具和下一轮调用字段；这不是目标桌面中的真实生图服务调用。

text.format 支持 json_object/json_schema，使用 Ajv 校验未经改写的模型答案。结构化文本在校验前缓冲，失败返回 invalid_structured_output，不输出成功 delta 或自行生成批准。未知 schema 约束明确拒绝。新增锁文件与 npm ci 安装步骤。31项回归测试通过；测试需本机随机端口，沙箱内禁止监听时需在允许本地监听的环境执行。

真实 kiro/gpt-5.6-sol 通过隔离临时网关接收纯红色 PNG：用户图片回答 A solid red square；工具图片结果回答 A solid bright red square。真实 JSON Schema 协议测试返回 decision=deny、reason=protocol test，通过本地校验。未执行真实自动批准审查；不将协议测试扩展为所有审批、视觉模型或插件均可用。

OpenAI Responses image_generation 是托管服务，Kiro 无对应后端；仍明确拒绝并解释可使用客户端生图函数/MCP或OpenAI聊天。未开启 OpenAI 回退，未宣称桌面内置生图端到端通过，未修改应用签名/资源。


## 2026-10-13 默认 Provider 错配与附带网页搜索

本机主配置实际为 model=kiro/gpt-5.6-sol、默认 provider=OpenAI；桌面日志确认选择 Kiro 会保存全局默认模型。补丁现拦截 Kiro 的 setDefaultModelConfig，返回原有 okOverridden，交由界面已有临时覆盖机制处理。实际方法回归验证 Kiro 不触发全局写入、OpenAI 仍写入。候选准备支持对旧共存补丁增量更新，签名与完整性验证通过；候选尚未安装，真实桌面启动待用户退出应用后执行 upgrade。upgrade 保留最初 restore 基线，并按原始安装备份修复错误的个人默认模型/推理设置。

自动请求即使附带 web_search/web_search_preview，也不再阻断其他客户端工具；不将托管搜索暴露给 Kiro，提示使用实际可用的客户端搜索工具，不冒充联网。强制指定托管搜索仍拒绝。32项回归通过，包含附带搜索与强制搜索的区别、原始回滚以及默认配置精准修复。


## 2026-10-13 Custom 工具参数错误恢复

针对 Custom tool input must be a string：MCP 入口验证 custom 参数必须是仅包含字符串 input 的对象；返回 isError 工具结果供 Kiro 纠正，不提前结束 Responses。累计 3 次错误则返回 invalid_tool_arguments 并清理 ACP 进程；不将对象强制序列化为原始工具文本。日志仅含工具名、字段名/类型、尝试次数，不记录值。

34项回归通过。模拟 ACP 覆盖 input 缺失、对象、数字、数组、直接字符串及多余字段后成功纠正；覆盖连续错误次数限制、SSE 失败无无效工具调用、进程清理，以及测试秘密值不进入诊断日志。此结果不保证所有真实模型都能自行纠正，真实错误参数形状需新日志提供证据。
