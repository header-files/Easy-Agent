# Execution Loops — 变更记录

> 当前实现见 [README.md](README.md)。按真实日期追加，保留同主题演进，不把未来能力写成已完成。

## 2026-11-22 — 建立 Phase 1.3 DefaultAgentLoop 实现基线

- 主题 ID：`execution.default-agent-loop`
- 变更前：Execution 只有职责文档，没有实际 Loop，Model/Tool 能力独立运行。
- 变更后：基于已验证 AgentLoop 契约实现流式模型调用、实时事件、串行工具批次、结果回填、再次模型请求及 completed/stopped 正常终态；没有 BasicLoop 别名、非流式模式或总调用上限。
- 修改原因：用户确认唯一 Phase 1.3 技术方案，需要在既有 Phase 1.1/1.2 能力上形成可替换的默认执行策略；按 A 契约、B 算法、C 控制并发、D 验收顺序实施。
- 配置与重试：策略来自 Context 扩展，默认额外重试 2 次，只重试未公开当前尝试事件的可重试模型错误；每轮预算独立，工具不重试。timeout 沿用既有 Runtime 的整数范围，明确校验而不修改底层协议。
- 资源与快照：每次消费创建 linked signal 并统一传给模型与工具，return 立即取消内部控制；消息/配置/事件独立副本，data 原样作为 readonly 不透明数据携带。完整 EOF 确认前不执行工具，清理错误不能覆盖原能力失败或触发重试。
- 兼容取舍：仅在 ModelRequest 副本将 null 且无 toolCalls 的 assistant.content 转为空字符串，解决既有 Model 请求映射与公共消息类型的边界；内部历史和 updatedContext 保留 null，Phase 1.1/1.2 源码与契约不变。
- 影响范围：本模块、Execution 父文档、公共 AgentLoop 使用与离线测试；不引入 Execution Engine、Session、持久化或工具并行。
- 验证：基础算法、独立控制/并发和协议边界测试通过；完整工程与真实 Runtime 离线链路最终结果见阶段验收记录。
- 关联：[Harness AgentLoop 时间线](../../harness/contracts/agent-loop/changes.md)、[Execution 时间线](../changes.md)、[项目级记录](../../../docs/changes.md)。

## 2026-11-22 — 避免不合作模型 finalizer 阻塞异常退出

- 主题 ID：`execution.default-agent-loop`
- 变更前：提前停止时若模型 next 已结束、Loop 正暂停在输出事件，清理会 await 底层 iterator.return；不结束的 finalizer 可挂住顶层 return，模型异常路径也可能被清理等待阻塞。
- 变更后：异常或提前停止仅请求底层 return 并接管迟到拒绝，不无限等待依赖的 finalizer；正常模型成功仍以完整 EOF 为确认边界。
- 修改原因：独立取消清理审阅复现了 consumer return 挂起及取消监听未及时移除的问题。任意自定义迭代器不合作时无法强制其 finally 完成，不能把这一等待变成 Loop 的隐藏阻塞。
- 影响范围：默认 Loop 的模型资源清理与原始错误传播，不改模型/工具公共契约，不提前执行任何后续工具。
- 验证：新增独立不结束 finalizer 回归与原有取消/模型错误测试，最终结果见阶段验收。
