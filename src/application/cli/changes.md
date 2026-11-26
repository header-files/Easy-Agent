# CLI — 变更记录

> 当前行为见 [README.md](README.md)。按实际日期记录实质性变化，保留时间线。

## 2026-11-24 — 建立本地 CLI 和独立结果展示

- 主题 ID：`application.local-cli`
- 变更前：Application 只有统一应用服务，没有终端适配或可执行聊天入口。
- 变更后：新增 `easy-agent chat`、帮助/版本、`/new`、`/exit`、Ctrl+C、流式正文和最终结果展示；通过 Composition 获取统一 Service，不直接实例化或调度底层业务组件。提供可注入 IO、信号、配置与 Bootstrap 的 `runCli`，直接导入 bin 不启动应用。
- 修改原因：将 Phase 1.1～1.5 已完成能力接入首个本地用户入口，同时为后续 HTTP 保留共享应用服务边界。
- 关键语义：每轮等待实际 result 后接受下一输入；管道已收到行和 EOF 不丢任务。活动 Ctrl+C 显式取消并等待收尾，空闲时退出，重复信号/正常退出只清理一次，初始化期间退出也等待装配再收尾。观察异常不取消业务；模型原始增量不重复打印，工具往返按模型 message_start 划分预览，最终输出一致时不重印、缺后缀时补足、不一致时明确替换预览。
- 影响范围：本 CLI 子模块、可执行入口、CLI 离线测试和 Application 模块说明；不修改 Phase 1.1～1.5 公共契约、队列、Loop 策略或 Engine 控制语义，不实现 HTTP 或持久化。
- 验证：`node --test tests/cli.test.ts` 12 项通过，类型检查、定向 Lint 和格式检查通过；完整工程结果由 [Phase 1.6](../../../docs/phase-1.6.md) 实际验收记录维护。
- 关联：[Application](../README.md)、[Composition](../../composition/README.md)、[项目记录](../../../docs/changes.md)。

### 2026-11-24 — CLI /model 与新默认模型选项

- 主题 ID：`application.local-cli`
- 变更前：仅支持 `--model` 作为单模型名，以及 `--base-url`；无交互模型列表/切换。
- 变更后：`--model` 映射已注册的 `defaultModel`；删除 `--base-url`；交互增加 `/model` 与 `/model <id>`，仅作用于当前 Session。
- 修改原因：Phase 2.1 要求本地用户可查看和切换显式注册模型。
- 影响范围：arguments、run-cli、帮助文本与 CLI/集成测试。
- 验证：`tests/cli.test.ts`、`tests/phase-1.6-integration.test.ts` 通过。
- 现行说明：[README.md](README.md)。

### 2026-11-24 — 文档去掉 .env.example 指引

- 主题 ID：`application.local-cli`
- 变更前：CLI README 仅强调不读 `.env`，仍间接依赖仓库环境变量清单叙事。
- 变更后：改为指向 JSON 示例；说明密钥可写本地配置或引用已导出进程环境变量，不提供/不加载 `.env.example`。
- 修改原因：仓库已删除未使用的 `.env.example`，文档需一致。
- 影响范围：本子模块 README；行为不变。
- 关联：[Composition](../../composition/changes.md)、[docs/changes.md](../../../docs/changes.md)。

### 2026-11-25 — CLI Workspace 与审批交互

- 主题 ID：`application.local-cli`
- 变更前：无 `/workspace`；执行渲染不处理审批。
- 变更后：启动展示 OS/Shell；`/workspace status|list|recover`；`renderExecution` 订阅审批并通过共享 readline `ask` 决策（无通道则拒绝）。
- 修改原因：Phase 2.2 要求本地闭环可查看 Workspace 并批准写工具/Terminal。
- 影响范围：run-cli、render-execution、arguments 帮助文案与集成测试。
- 验证：`tests/phase-2.2-application.test.ts`、`tests/cli.test.ts`。
- 现行说明：[README.md](README.md)。

### 2026-11-25 — CLI 选择能力与审批展示加固

- 主题 ID：`application.local-cli`
- 变更前：`/new` 仅默认 Session；`/workspace` 无 register/create/use；审批只截断 args 前 200 字符；submit 后再订阅可能竞态失败关闭。
- 变更后：`/workspace register|create|use`、`/new [workspaceId]`、`/tools`；submit 前 `subscribeApprovalPrompts`；审批展示 workspace/shell/cwd/command/path 与 argsHash。
- 修改原因：验收问题 5/6。
- 验证：`tests/phase-2.2-application.test.ts`。
- 现行说明：[README.md](README.md)。

### 2026-11-25 — 审批展示全文与敏感字段脱敏

- 主题 ID：`application.local-cli`
- 变更前：`command`/`path` 截断后仍可批准完整操作；`otherArgs` 直接打印可能含正文/口令。
- 变更后：`command`/`path` 全文；`content`/`oldText`/`newText`/口令类键只显示长度类型摘要；其余有界摘要。
- 修改原因：二次验收——展示与可批准内容不一致、敏感参数泄露。
- 验证：定向 lint/format；行为见 `render-execution.ts`。
- 现行说明：[README.md](README.md)。

### 2026-11-25 — Terminal command 展示启发式脱敏

- 主题 ID：`application.local-cli`
- 变更前：`command` 原文完整打印，含令牌/口令时泄露到终端。
- 变更后：展示侧对常见 `Authorization`/`Bearer`/`password=`/令牌形态做启发式脱敏，保留可审阅结构与 `commandChars`；`argsHash` 与执行仍用完整冻结参数。非完备秘密检测。
- 修改原因：三次复查——完整待批准命令 vs 敏感信息保护需明确取舍。
- 验证：`tests/filesystem-tools.test.ts` 中 `redactCommandForDisplay` 用例。
- 现行说明：[README.md](README.md)；决策见 [Phase 2.2 §14](../../../docs/phase-2.2.md)。

### 2026-11-25 — Authorization 脱敏收窄为单 token

- 主题 ID：`application.local-cli`
- 变更前：`Authorization\s*:\s*[^"'\s]+(?:\s+[^"'\s]+)*` 过宽，会吞掉 `&& rm ...` 等后续命令，审批界面与真实执行不一致。
- 变更后：仅替换 `Authorization: Bearer <one>` 或 `Authorization:<one>` 的单个凭证 token；后续 Shell 语法原样保留。
- 修改原因：四次复查——脱敏不得隐藏实际将执行的操作。
- 验证：`tests/filesystem-tools.test.ts`（`&& rm -rf report` 用例）。

### 2026-11-25 — 凭证 token 在 Shell 元字符处截断

- 主题 ID：`application.local-cli`
- 变更前：`\S+` 仍会把 `abc&&rm` / `abc;touch` / `abc|sh` 整段当 token，漏显后续操作。
- 变更后：凭证字符类为 `[A-Za-z0-9._~+/=-]+`，在 `&|;` 等元字符前截断。
- 修改原因：五次复查——无空格紧邻运算符。
- 验证：`tests/filesystem-tools.test.ts`。

### 2026-11-26 — 恢复 Session 继续会话与历史 Execution 查询

- 主题 ID：`application.local-cli`
- 变更前：启动总是 `createSession`；无切换已有 Session 或查询 Execution 的命令。
- 变更后：有恢复 Session 时默认继续最后一个；新增 `/sessions`、`/session <id>`、`/executions [id]`。
- 修改原因：phase-2.4 §11 要求 CLI/Application 加载已有 Session 并查询历史 Execution。
- 验证：`tests/cli.test.ts` Session 切换用例。
- 现行说明：[README.md](README.md)。

### 2026-11-26 — /session 支持唯一 ID 前缀

- 主题 ID：`application.local-cli`
- 变更前：`/session` 必须输入完整 sessionId。
- 变更后：精确匹配优先；否则在已加载 Session 中按前缀匹配，唯一则切换，多个则拒绝并提示加长。
- 修改原因：完整 UUID 不便手输。
- 验证：`tests/cli.test.ts` 前缀唯一/歧义用例。
- 现行说明：[README.md](README.md)。
