# Phase 1 — 最小 Agent 的分阶段索引

> 当前仅授权 **[Phase 1.3 Agent Loop](phase-1.3-agent-loop.md)**。本索引按 2026-11-22 用户确认的顺序维护，不是自动接续任务清单。

Phase 0 工程和统一 Logging 已完成；Phase 1 按独立能力逐步形成最小 Agent：

| 阶段                                 | 目标                                                                                | 状态                        |
| ------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------- |
| [Phase 1.1](phase-1.1.md)            | Model System：统一模型契约、Chat Completions、流式/Tool Calling、并发及生命周期日志 | 已完成，保留 76 项历史验收  |
| [Phase 1.2](phase-1.2.md)            | Tool Runtime：注册、严格校验、执行、结果、取消/超时、并发和轻量 Model Bridge        | 已完成，保留 109 项历史验收 |
| [Phase 1.3](phase-1.3-agent-loop.md) | AgentLoop 通用契约与 DefaultAgentLoop：模型流式调用、串行工具、完整历史和最终结果   | **当前**                    |
| Phase 1.4                            | Execution Engine：执行机制与生命周期                                                | 待授权                      |
| Phase 1.5                            | Agent Management：Session、输入与 Execution 协调                                    | 待授权                      |
| Phase 1.6                            | Composition + CLI 与整体集成验收                                                    | 待授权                      |

Harness 定义公共契约，Runtime 提供可替换实现；Loop 策略与 Engine 机制保持分离，Composition 后续统一装配。本阶段只以 [Agent Loop 技术方案](phase-1.3-agent-loop.md) 为唯一设计依据；默认实现依赖既有模型、工具契约，自定义 Loop 不强制依赖它们。当前可以独立创建和复用模型、工具和 Loop 组件，不为后续阶段创建空接口或业务占位。

当前实现以模块就近 README 为准，阶段验收分别保存于对应阶段文件。未来能力边界见 [路线图](roadmap.md)，调整原因见 [项目变更记录](changes.md)，全局依赖规则见 [架构](architecture.md)。
