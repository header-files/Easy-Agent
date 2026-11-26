# Application — 应用接入层 — 变更记录

> 本文件仅记录 **`src/application/` 模块范围内** 实质性设计和实现变化。当前有效实现以 [README.md](README.md) 和代码为准；历史记录只追加不覆盖。

## 记录范围与规则

- 本模块职责、行为、内部技术方案、接口、重要问题修复或实现取舍发生实质性变化时，追加记录。
- 每条记录填写真实日期、稳定主题 ID、变更前、变更后、原因、影响范围，必要时附测试/关联决策。
- 同一主题多次修改使用同一主题 ID，**按发生时间持续追加**，不得覆盖历史。
- 纯拼写、格式化等非实质性修改不必记入。
- 跨模块或全局架构变化：同时更新涉及的模块说明，并在 [`docs/changes.md`](../../docs/changes.md) 记录全局决策摘要，链接到模块详细记录；避免双份完整内容。

## 记录模板

```markdown
### YYYY-MM-DD — <标题>

- 主题 ID：`application.topic`
- 变更前：...
- 变更后：...
- 修改原因：...
- 影响范围：...
- 依据/验证：...（可选）
- 现行说明：[README.md](README.md)
```

## 变更时间线

Phase 0 创建说明文档建立初始基线；以下随实际功能落地追加演进记录。

### 2026-11-24 — Phase 1.6-A 统一应用服务

- 主题 ID：`application.shared-service`
- 变更前：Application 只有职责说明，没有 CLI 与后续 HTTP 可复用的共享交互入口。
- 变更后：定义 AgentApplicationService、最小只读 SessionInfo 和 AgentApplicationError，默认实现委托 Harness AgentManager/SessionAgent，透传 SessionExecution。构造时可提供 Bootstrap 持有的默认 Session 配置，并沿用参数键、工具名单和 extensions 命名空间覆盖规则。
- 修改原因：用户授权 Phase 1.6，希望本地 CLI 与未来 HTTP 共享应用操作，避免复制队列、上下文和执行策略。
- 边界决定：非空白交互输入在应用层校验；缺失 Session 明确失败，不自动创建。忙碌删除与跨 Session 取消保持 Agent 语义。错误仅输出固定安全描述，不附带原始异常、输入或配置；application_disposed 分类供 Composition 包装使用，默认 Service 本身不管理资源或退出状态。
- 影响范围：src/application 公共服务与实现、模块文档及应用服务测试；Phase 1.1～1.5 公共契约不变，不引入 CLI/HTTP 依赖或第二套调度状态。
- 验证：7/7 定向离线测试通过；npm run typecheck 和定向 ESLint/Prettier 通过。覆盖 Fake Manager 透传、非 CLI 适配器、真实 Agent/Engine 的 FIFO/上下文及取消隔离、删除、配置和安全错误。
- 现行说明：[README.md](README.md)；跨模块摘要由 Phase 1.6 最终项目记录关联。

### 2026-11-24 — Phase 1.6-C 本地 CLI 接入共享服务

- 主题 ID：`application.local-cli`
- 变更前：统一 Service 已完成，尚无面向本地用户的终端适配。
- 变更后：新增 CLI 能力子模块与就近文档，通过 Composition 配置和 Bootstrap 获取 Service；支持聊天、帮助/版本、多轮、新 Session、顺序退出、实时正文、独立最终结果和 Ctrl+C。入口不直接创建模型、工具、Loop 或 Engine。
- 修改原因：贯通首个实际交互入口，验证 Service 可供终端和未来 HTTP 共享，并保持运行与观察生命周期独立。
- 边界决定：每轮等待最终结果后处理下一输入；管道行/EOF 不提前丢弃。活动取消等待实际收尾，空闲 Ctrl+C 退出，初始化中退出也等待装配再清理。只以 output_delta 输出正文，按模型响应边界避免工具往返的最终回答重印；观察异常后仍获取权威 result。
- 影响范围：Application 父模块、CLI 子模块、CLI 单元和集成入口；原 Service 的传输中立性与 Phase 1.1～1.5 公共契约保持不变，无 HTTP 或持久化实现。
- 验证：CLI 定向 12/12 项通过，npm run typecheck、定向 ESLint/Prettier 通过；整体实测由 [Phase 1.6](../../docs/phase-1.6.md) 验收记录维护。
- 详细记录：[CLI changes](cli/changes.md)，现行说明：[CLI README](cli/README.md)、[Application README](README.md)。

### 2026-11-24 — Application 模型目录与 Session 切换

- 主题 ID：`application.model-catalog`
- 变更前：Service 只委托 Session 提交/取消，不暴露已注册模型列表或 Session 模型切换。
- 变更后：要求注入 `modelCatalog`；新增 `listModels` / `getSessionModel` / `setSessionModel`；创建、提交与切换均校验已注册模型，无效切换不污染 Session。
- 修改原因：为 CLI `/model` 与未来适配器提供传输中立的模型管理入口。
- 影响范围：Application Service、lifecycle 转发、CLI、离线测试。
- 验证：`tests/agent-application-service.test.ts` 与 CLI/集成回归通过。
- 现行说明：[README.md](README.md)、[CLI README](cli/README.md)。

### 2026-11-25 — Phase 2.2 Application/CLI Workspace 与审批闭环

- 主题 ID：`application.workspace-approval`
- 变更前：Service 无 Workspace/审批 API；CLI 只渲染 `output_delta`，无法交互批准工具。
- 变更后：Service 增加 Workspace CRUD/状态/recover、Session Workspace 查询、审批 list/decide/subscribe 与 Terminal Shell 查询；创建 Session 可绑定默认或显式 Workspace。CLI 展示 OS/Shell，支持 `/workspace`，并在 `renderExecution` 中通过共享输入 `ask` 完成审批（无通道则拒绝）。
- 修改原因：Phase 2.2 要求内置写工具与 Terminal 经 Application 决策，且不把审批挂在 Engine 状态机上。
- 影响范围：Application Service、lifecycle、CLI、Composition 注入、离线测试。
- 验证：`tests/phase-2.2-application.test.ts`；完整回归见 Phase 2.2 验收。
- 现行说明：[README.md](README.md)、[CLI README](cli/README.md)。

### 2026-11-25 — CLI 审批展示与 Runtime 二次修补对齐

- 主题 ID：`application.workspace-approval`
- 变更前：审批 UI 截断 command/path 且可能打印敏感正文。
- 变更后：全文展示可批准的 command/path，敏感键脱敏；细节见 [CLI changes](cli/changes.md)。
- 修改原因：与 Runtime 原子写入/深冻结修补同一轮二次验收。
- 验证：见 Phase 2.2 §14 与 CLI 子模块记录。

### 2026-11-25 — Terminal command 展示脱敏决策

- 主题 ID：`application.workspace-approval`
- 变更前：`command` 原文完整输出。
- 变更后：启发式脱敏展示 + `argsHash`；见 [CLI changes](cli/changes.md) 与 Phase 2.2 §14 设计例外表。
- 修改原因：三次复查要求明确取舍。

### 2026-11-26 — Application 接入 Workspace Registry 与恢复

- 主题 ID：`application.persistence.phase-2.4`
- 变更前：Workspace 注册/恢复仅内存；remove/recover 同步。
- 变更后：可选 PersistenceBridge；注册/删除/恢复走 Registry 事务；`recoverWorkspace`/`removeWorkspace` 改为 async；删除前检查 Projection 引用索引。
- 修改原因：Phase 2.4 Workspace 独立 Registry 与 fail-closed 恢复。
- 影响范围：DefaultAgentApplicationService、CLI、lifecycle 包装。
- 验证：`tests/phase-2.4-persistence.test.ts`。
- 现行说明：[README.md](README.md)。

### 2026-11-26 — createSession 锁内重检与登记失败回滚

- 主题 ID：`application.persistence.phase-2.4`
- 变更前：createSession 在共享锁外检查 Workspace；register/createWorkspace 在 Registry 提交失败后仍留在 WorkspaceManager。
- 变更后：共享锁内（及 bind 前）再次 `assertWorkspaceUsable`；Registry 提交失败时 `rollbackWorkspace` 从内存移除。
- 修改原因：复查复现删除与创建并发可指向已删 Workspace；登记失败导致内存与持久化不一致。
- 影响范围：`default-agent-application-service.ts`。
- 验证：phase-2.4 并发创建/删除与登记回滚用例；全仓 311 通过。
- 现行说明：[README.md](README.md)。

### 2026-11-26 — 已提交登记不因 Projection 刷新失败回滚

- 主题 ID：`application.persistence.phase-2.4`
- 变更前：register/createWorkspace 对任何异常回滚内存。
- 变更后：仅在非 `durableCommitted` 失败时回滚；Journal 已 COMMITTED 则保留内存可见性并返回成功。
- 修改原因：复查复现「接口失败且列表为空、重启却出现」。
- 验证：phase-2.4「登记已提交但 Projection 刷新失败时保留内存可见性」。
- 现行说明：[README.md](README.md)。

### 2026-11-26 — commit_uncertain 登记保留内存；文档对齐 Phase 2.4

- 主题 ID：`application.persistence.phase-2.4`
- 变更前：commit_uncertain 与确定失败一样回滚 Workspace 内存；README 仍称不实现 Event Log。
- 变更后：uncertain 保留内存可见性并报 operation_failed；README/须知改为引用 Phase 2.4。
- 修改原因：复查不确定提交被当未发生；文档过时。
- 验证：phase-2.4「COMMIT_UNCERTAIN 登记不得回滚内存可见性」。
- 现行说明：[README.md](README.md)。

### 2026-11-26 — Execution 查询与 CLI 继续已恢复 Session

- 主题 ID：`application.persistence.phase-2.4`
- 变更前：无历史 Execution 查询；CLI 启动总是新建 Session，无切回入口。
- 变更后：`listSessionExecutions` / `getExecution`；CLI `/sessions`、`/session`、`/executions`；启动优先继续已恢复 Session。
- 修改原因：对照 phase-2.4 §11 集成边界。
- 验证：phase-2.4 Execution 查询用例；cli `/session` 用例。
- 现行说明：[README.md](README.md)、[CLI README](cli/README.md)。

### 2026-11-26 — recoverWorkspace 拒绝覆盖 live Terminal intent

- 主题 ID：`application.persistence.phase-2.4`
- 变更前：`recoverWorkspace` 将全部 openIntents 写入 `workspace/recovered`，不检查活动是否仍在本进程运行。
- 变更后：若 Coordinator 对该 Workspace 仍有 live Terminal 活动则 `operation_failed`，不提交 recovered。
- 修改原因：复查复现运行中 intent 被提前人工恢复，重启呈 NORMAL 且未结束活动为 0。
- 验证：phase-2.4「运行中 Terminal intent 拒绝人工恢复」。
- 现行说明：[README.md](README.md)。
