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
