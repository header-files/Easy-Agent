# Phase 1 — 最小可运行 Agent（后续计划，尚未启动）

> **本文件只记录后续实现计划，不是当前任务清单。** 当前阶段是 [`Phase 0`](phase-0.md)：工程初始化及架构骨架。只有 Phase 0 验收后且用户明确下达新任务，才能开展此阶段。

## 1. 阶段目标

在已完成的工程基础上，交付一个能够通过 CLI 与 OpenAI-compatible 模型进行连续对话的最小 Agent，验证统一组件装配、Session 管理、Execution Engine / Agent Loop 分离及 Model Runtime 契约。

## 2. 计划实现范围

| 模块                    | Phase 1 计划能力                              | 暂不涉及                               |
| ----------------------- | --------------------------------------------- | -------------------------------------- |
| Configuration           | 加载模型配置并提供清晰的错误处理              | 配置中心、动态配置系统                 |
| Composition / Bootstrap | 使用简单 Factory 装配默认组件，可注入替身     | DI 容器与完整插件生命周期              |
| Harness Contracts       | 最小 `ModelClient`、`AgentLoop` 契约          | 预定义全部 Runtime 接口                |
| Model Runtime           | 一个真实可调用的 OpenAI-compatible 模型适配器 | 多协议全面支持                         |
| Agent                   | AgentManager / SessionAgent、进程内多轮历史   | 持久化 Inbox / Scheduler               |
| Execution               | Execution Engine + 可替换 Basic Loop          | 完整 Step/Attempt/RecoveryState 状态机 |
| CLI                     | 读取配置、连续提问、返回回复、`/exit` 退出    | 复杂 TUI、Web、HTTP                    |
| 测试                    | Fake ModelClient、离线单测与最小集成测试      | 联网请求作为自动测试必需条件           |

每次用户输入对应一个新的 Execution，同一 Session 内串行处理；这些约束在 Phase 1 结合真实代码实现。此阶段不提前实现 Follow-up / Steer 事务、审批、恢复机制。

## 3. 建议任务顺序

1. 配置读取、必要契约和默认 OpenAI-compatible Provider。
2. Basic Loop、Execution Engine、AgentManager / SessionAgent。
3. Composition / Bootstrap 装配入口及 CLI。
4. Fake ModelClient 离线测试、错误处理、可选真实模型烟测。
5. 更新对应模块 `README.md` 的实现状态、关键文件与测试方式；局部变更追加本模块 `changes.md`，跨模块决策更新项目级 `docs/changes.md`。更新仓库 README 的真实使用说明。

具体函数签名、状态定义及组件交互方式应在 Phase 1 编码时确定，不提前作为 Phase 0 的约束。

## 4. 计划验收标准

- [ ] 有有效模型配置时，可通过 `npm run dev -- chat`（或届时文档确定的命令）进入 CLI。
- [ ] 连续输入两轮问题，保留当前进程内的 Session 历史并正常退出。
- [ ] 每次用户输入创建新的 Execution；同一 Session 串行执行。
- [ ] Basic Loop / ModelClient 可以通过注入替身参与离线测试。
- [ ] 模型异常、配置缺失等错误清晰呈现，不伪造成功。
- [ ] 类型检查、构建、lint、格式检查和离线测试全部通过。
- [ ] 仓库 README 只记录实际可用的命令；实现过的模块 README 说明实际入口和测试方式，模块 changes 记录实质性修改，跨模块决策记录在项目级 changes。

## 5. 非目标

Tool Calling、MCP、Skill、Memory、HTTP API、SSE、发布版 SDK、完整持久化、Inbox/Scheduler、Approval、Recovery、复杂权限与多 Agent。后续安排见 [`roadmap.md`](roadmap.md)。
