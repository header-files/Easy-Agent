# Tool Contracts — 变更记录

> 本文件记录工具公共契约的基线与后续调整；现行说明见 [README.md](README.md)。同一主题后续修改只追加历史。

## 设计基线

### 2026-11-22 — Phase 1.2 工具注册与执行契约

- 主题 ID：`harness.tool-contracts`
- 修改前后：首次建立本能力域。此前只有 Phase 1.1 模型侧的工具声明、调用与结果消息；本次按用户确认的任务书增加 ToolSpec、ToolHandler、ToolRegistry、ToolExecutor 和 ToolResult，以及执行上下文、选项和 ToolExecutionError。
- 原因：在 Agent Loop 之前提供稳定、可替换的真实工具执行边界。
- 决策：ToolCall 与既有 ModelToolCall 结构兼容；工具业务失败通过 ToolResult 返回，取消/超时单独抛异常；组件实例可复用，每次调用状态独立，不自动重试，注销不破坏在途调用。
- 工程取舍：ToolExecutionError 的 code 保持显式 readonly 字段，构造器参数与公共行为遵循方案；不使用工程禁止的 TypeScript 参数属性语法。
- 影响范围：本能力域公共类型与独立异常、契约测试、Harness 父模块说明；Phase 1.1 Model Contracts 未变。
- 验证：独立严格类型检查通过，`node --test tests/tool-contracts.test.ts` 6 项通过，定向 ESLint 与格式检查通过；先完成基础契约验证再进入 Runtime 编码。
- 非目标：不加入 Agent Loop、完整模型—工具循环、MCP、Skill、Sandbox、调度器或重试框架。
- 关联：[Harness 时间线](../../changes.md)、[项目级记录](../../../../docs/changes.md)。
