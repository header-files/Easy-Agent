# Phase 1 — 最小 Agent MVP 阶段索引与总验收（v0.1.0）

> **Phase 1（Phase 1.1～1.6）已全部完成，对应首个 MVP 里程碑版本 `v0.1.0`**，发布说明见 [v0.1.0 Release Notes](releases/v0.1.0.md)。后续 Phase 2 及以上功能尚未启动，需经用户明确授权。

Phase 0 工程与统一 Logging 基线完成后，Phase 1 按独立能力逐步交付最小可运行 Agent：

| 阶段                      | 目标                                                                                | 状态                                           |
| ------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- |
| [Phase 1.1](phase-1.1.md) | Model System：统一模型契约、Chat Completions、流式/Tool Calling、并发及生命周期日志 | 已完成；保留 76 项历史验收（后续补充兼容回归） |
| [Phase 1.2](phase-1.2.md) | Tool Runtime：注册、严格校验、执行、结果、取消/超时、并发和轻量 Model Bridge        | 已完成；保留 109 项历史验收                    |
| [Phase 1.3](phase-1.3.md) | AgentLoop 通用契约与 DefaultAgentLoop：流式模型、串行工具、完整历史和结果           | 已完成；保留阶段 146 项及后续修复 151 项记录   |
| [Phase 1.4](phase-1.4.md) | ExecutionEngine 通用契约与默认内存实现：生命周期、事件/结果、取消与快照             | 已完成；保留 187 项历史验收                    |
| [Phase 1.5](phase-1.5.md) | Agent Management：内存 Session、FIFO、上下文、取消和独立事件/结果观察               | 已完成；保留 216 项历史验收                    |
| [Phase 1.6](phase-1.6.md) | 统一 Application Service、配置/装配、本地 CLI 与端到端集成验收                      | 已完成；保留 254 项阶段验收                    |

## Phase 1 整体能力总结（v0.1.0）

- **分层与可替换契约**：Harness 定义 Model、Tool、AgentLoop、Execution、Agent 公共契约；Runtime 提供 OpenAI-compatible 模型适配与本地 Ajv 严格校验工具执行；Execution 保持 `DefaultAgentLoop`（策略）与 `DefaultExecutionEngine`（机制）分离；Agent 层统一内存 Session、每 Session FIFO、跨 Session 并发、成功上下文提交和独立观察流；Application 提供传输中立的 `AgentApplicationService` 和本地 CLI；Composition 集中配置解析、默认装配、组件注入、启动回滚和幂等 `dispose()`。
- **端到端闭环**：支持本地 `easy-agent chat` 多轮对话、流式 `output_delta` 输出、`--no-stream`、模型→串行工具→模型往返（内置无副作用演示工具 `add({ a, b })`）、`/new` 切换 Session、`/exit` 顺序收尾与 Ctrl+C 显式取消等待协作收尾。
- **兼容与安全边界**：Model Runtime 兼容流式空白工具标识与 `null` 占位字段；配置优先级为 CLI > 环境变量 > 显式 JSON > 默认值（不自动加载 `.env`）；运行日志统一经 `Logger` 输出 stderr，并对敏感字段、敏感值及异常载荷做脱敏与最小化记录。

## Phase 1 端到端总验收记录（v0.1.0）

2026-11-24 在 `v0.1.0` 里程碑收尾阶段执行完整离线检查，全部退出码 0：

| 检查命令               | 实际结果                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `npm run typecheck`    | 通过                                                                                       |
| `npm run lint`         | 通过，0 警告                                                                               |
| `npm run format:check` | 通过                                                                                       |
| `npm run build`        | 通过                                                                                       |
| `npm test`             | **256 项通过，0 失败，0 跳过**（32 个测试文件；Phase 1.6 254 项 + 2 项 Model `null` 回归） |

同步验证 `npm run chat -- --help`、`node src/application/cli/bin.ts --version`、`node dist/application/cli/bin.js --help` 与 `node dist/application/cli/bin.js --version`（均输出 `easy-agent 0.1.0`），以及 `dist/index.js` 和 `dist/application/cli/bin.js` 在 `--no-strip-types` 模式下的无副作用 ESM 导入。自动化测试全程离线，不依赖外部网络、模型密钥或数据库。

## 尚未实现的能力（非 Phase 1 范围）

- HTTP Server、REST / SSE、远程 CLI、Web UI 与正式 npm SDK 发布（当前为 `private: true` 私有包，不含 `npm link` 安装验收）。
- Session Event Log JSONL 读写、Transaction Journal、Write Coordinator、持久化投影、事件重放与崩溃恢复（当前 Session 与快照仅存内存）。
- Runtime Event Bus、持久化 Inbox、Steer / Follow-up、Approval / HITL、完整 Turn / Step / Attempt 状态机。
- MCP、Skill、Memory、上下文压缩与 Token 预算、Workspace、Sandbox、多 Agent、工具并行执行，以及日志轮转与分布式 Tracing。

当前实现细节以各模块就近 README 为准，各子阶段验收保留于对应阶段文件。未来能力规划见 [路线图](roadmap.md)，历史决策见 [项目变更记录](changes.md)，全局架构约束见 [架构](architecture.md)。
