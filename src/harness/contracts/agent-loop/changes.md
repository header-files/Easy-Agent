# AgentLoop Contracts — 变更记录

> 本文件记录公共 Loop 契约基线及后续调整。当前有效说明见 [README.md](README.md)，同一主题后续修改只追加历史。

## 设计基线

### 2026-11-22 — Phase 1.3 通用输入、事件流与最终结果

- 主题 ID：`harness.agent-loop-contracts`
- 修改前后：首次建立本能力域；此前只有独立 Model/Tool 契约，没有跨 Loop 实现的通用运行协议。本次按唯一阶段方案第三节新增 AgentLoopContext、AgentLoopResult、AgentLoopEvent 和 AgentLoop。
- 原因：为官方默认策略和可独立替换的第三方算法提供统一流式边界，避免将默认模型—工具循环写死在 Harness。
- 决策：model/tools 可选，details 不强制模型统计；单一 AsyncIterable 承载实时事件及最终 loop_end.result；updatedContext 如存在必须是完整快照；异常、取消和提前退出没有正常 loop_end。
- 依赖边界：直接引用现有 ModelMessage、ModelParameters、ModelStreamEvent、ToolCall 和 ToolResult，未修改 Phase 1.1/1.2 公共契约；不引入 DefaultAgentLoopOptions、总调用上限、BasicLoop、loop_result 或 getResult。
- 验证：独立严格类型检查通过，`node --test tests/agent-loop-contracts.test.ts` 6 项通过；确认基础契约后才通知开始 Execution 默认策略实现。
- 关联：[Harness 时间线](../../changes.md)、[唯一阶段设计](../../../../docs/phase-1.3.md)、[项目级记录](../../../../docs/changes.md)。
