# Easy Agent — Coding Agent 指令入口

> 供 Codex 等 Coding Agent 自动发现。详细规则以 [`docs/AGENT.md`](docs/AGENT.md) 为准。Cursor 同样引用这套统一规范。

## 开始工作前

1. 先阅读 `docs/AGENT.md` 和 **`docs/phase-1.3-agent-loop.md`**，确认当前任务范围；`docs/phase-0.md` 保留工程基线与历史验收；Logging 是已完成的运行基础设施，涉及日志时先读 `src/runtime/logging/README.md` 与 `changes.md`。
2. 阅读 `docs/architecture.md`、`docs/conventions.md`，按需参考 `docs/roadmap.md`。
3. **定位本次变更所属模块**，先读对应 `src/<module>/README.md` 和 `src/<module>/changes.md`；如存在更深一层的能力子模块，优先读该子模块文档，并按需阅读父模块。
4. 修改全局架构或跨模块行为时，再阅读 `docs/changes.md` 中相关决策记录。
5. 先检查仓库实际内容，不覆盖有效代码，不把尚未实现的规划写成已完成。

## 必须遵守

- **当前阶段是 Phase 1.3：以 `docs/phase-1.3-agent-loop.md` 为唯一阶段依据，实现 Harness AgentLoop 契约、Execution DefaultAgentLoop 及离线测试；不自动进入 Phase 1.4。**
- Easy Agent 定位为开箱即用、灵活可扩展的通用 Agent；原则为 Easy to Use / Easy to Extend。
- 架构：Application / Agent / Execution / Runtime 四个运行职责层；Harness 横向支撑；Composition / Bootstrap 统一装配。
- 保留 Agent Loop（策略）与 Execution Engine（机制）的设计分离；不把 Harness 做成请求必经层，不强制逐层调用。
- 按能力域组织 Runtime；不提前进行全组件插件化、复杂 DI 或分布式改造。
- AgentLoop 契约允许自定义实现不使用模型/工具；通用 Context.model 可选，DefaultAgentLoop 运行时才要求有效模型配置。默认策略仅使用 ModelClient.stream()，工具按返回顺序串行，正常 loop_end 返回权威结果和完整上下文。
- 默认策略配置只在 Context 的 extensions.defaultAgentLoop 中读取：maxModelRetries 默认 2，仅在当前模型尝试尚未公开事件且 ModelError.retryable 时重试；主动取消和工具调用不自动重试。无模型/工具/迭代总次数上限，无默认全局超时。
- Phase 0、Logging、Phase 1.1 Model 和 Phase 1.2 Tool 是已完成基线，不修改其公共契约。Phase 1.3 实现默认流式模型—串行工具—模型闭环；不实现 Engine、Session 调度、CLI、MCP、Skill、Sandbox、Approval 或工具并行。
- **每个一级职责模块必须有就近 `README.md` 和 `changes.md`**，目前为 `src/application`、`src/agent`、`src/execution`、`src/harness`、`src/runtime`、`src/composition`。它们是有效说明文档，不是业务功能占位实现。
- 新增职责独立的子模块/能力域时，随着实际功能落地创建对应 `README.md` 与 `changes.md`，不要求每个文件、工具类或普通子目录都有独立文档。
- 不为未来能力批量创建空实现、无用接口或占位类。
- 运行日志通过 `src/runtime/logging` 的统一 Logger 门面输出到 stderr，不散落 `console.log` 或直接依赖 Pino；禁止记录密钥、认证头和完整敏感载荷。
- 不提交密钥、`.env`、生成产物；不要凭空宣称测试通过。
- **模块级实质性变更**：更新受影响的模块 `README.md` 并追加其 `changes.md`，记录时间、修改前后、原因、影响，多次修改保留时间线。
- **全局/跨模块实质性变更**：再更新项目级现行规范，追加 `docs/changes.md` 的决策摘要并关联模块日志；不要重复粘贴多份完整历史。

## 结束任务时

汇报：变更文件、已执行的验证命令及结果、尚未实现的功能、是否更新了对应模块的现行说明和变更时间线、以及需要用户确认的设计问题。
