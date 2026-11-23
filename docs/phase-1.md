# Phase 1 — 最小 Agent 的分阶段索引

> 当前仅授权 **[Phase 1.4 Execution Engine](phase-1.4.md)**。本索引按 2026-11-22 用户确认的顺序维护，不是自动接续任务清单。

Phase 0 工程和统一 Logging 已完成；Phase 1 按独立能力逐步形成最小 Agent：

| 阶段                      | 目标                                                                                | 状态                                         |
| ------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| [Phase 1.1](phase-1.1.md) | Model System：统一模型契约、Chat Completions、流式/Tool Calling、并发及生命周期日志 | 已完成，保留 76 项历史验收                   |
| [Phase 1.2](phase-1.2.md) | Tool Runtime：注册、严格校验、执行、结果、取消/超时、并发和轻量 Model Bridge        | 已完成，保留 109 项历史验收                  |
| [Phase 1.3](phase-1.3.md) | AgentLoop 通用契约与 DefaultAgentLoop：流式模型、串行工具、完整历史和结果           | 已完成；保留阶段 146 项及后续修复 151 项记录 |
| [Phase 1.4](phase-1.4.md) | ExecutionEngine 通用契约与默认内存实现：生命周期、事件/结果、取消与快照             | **已完成，187 项验收；当前阶段基线**         |
| Phase 1.5                 | Agent Management：Session、输入与 Execution 协调                                    | 待授权                                       |
| Phase 1.6                 | Composition + CLI 与整体集成验收                                                    | 待授权                                       |

Harness 定义公共契约，Runtime 提供可替换实现；Loop 策略与 Engine 机制保持分离，Composition 后续统一装配。本阶段只以 [Execution Engine 技术方案](phase-1.4.md) 为唯一设计依据；Engine 驱动任意 AgentLoop，不依赖默认算法。ExecutionEvent 仅为内存通知，Session Event Log 读写、事务、持久化及恢复均未实现。当前可独立创建和复用模型、工具、Loop 与 Engine 组件，不为后续阶段创建空接口或业务占位。

当前实现以模块就近 README 为准，阶段验收分别保存于对应阶段文件。未来能力边界见 [路线图](roadmap.md)，调整原因见 [项目变更记录](changes.md)，全局依赖规则见 [架构](architecture.md)。
