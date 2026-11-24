# Agent — 会话与任务管理层 — 变更记录

> 本文件仅记录 **`src/agent/` 模块范围内** 实质性设计和实现变化。当前有效实现以 [README.md](README.md) 和代码为准；历史记录只追加不覆盖。

## 记录范围与规则

- 本模块职责、行为、内部技术方案、接口、重要问题修复或实现取舍发生实质性变化时，追加记录。
- 每条记录填写真实日期、稳定主题 ID、变更前、变更后、原因、影响范围，必要时附测试/关联决策。
- 同一主题多次修改使用同一主题 ID，**按发生时间持续追加**，不得覆盖历史。
- 纯拼写、格式化等非实质性修改不必记入。
- 跨模块或全局架构变化：同时更新涉及的模块说明，并在 [`docs/changes.md`](../../docs/changes.md) 记录全局决策摘要，链接到模块详细记录；避免双份完整内容。

## 记录模板

```markdown
### YYYY-MM-DD — <标题>

- 主题 ID：`agent.topic`
- 变更前：...
- 变更后：...
- 修改原因：...
- 影响范围：...
- 依据/验证：...（可选）
- 现行说明：[README.md](README.md)
```

## 变更时间线

Phase 0 创建说明文档建立初始基线；以下随实际功能落地追加演进记录。

### 2026-11-24 — Phase 1.5 进程内 Session Agent Management

- 主题 ID：`agent.session-management`
- 变更前：Agent 目录只有职责说明；现有 Engine/Loop 可驱动单次执行，但没有 Session 所有权、排队或多轮上下文提交。
- 变更后：新增 `DefaultAgentManager` 与内部 Session 实现，同步 submit 入队、每 Session 单泵 FIFO、跨 Session 并发、执行前读取最新历史、成功完整上下文提交、默认/单次配置解析、空闲删除及 ID 去重。公共接口由 Harness 提供，未修改 Phase 1.1–1.4 公共契约。
- 修改原因：将已完成的单次执行闭环组织为可独立观察、等待结果和连续交互的进程内 Session，同时保持自定义 Loop/Engine 可替换。
- 影响范围：`src/agent/`、Agent 公共导出与离线测试；不接入持久化、Inbox、Workspace、CLI 或网络入口。
- 实现边界：Engine 流由 Session 内部唯一消费；观察流 break/overflow 不取消执行。唯一合法 execution_end 后仍确认 EOF/清理，先提交上下文再 resolve 结果，再处理下一项；异常统一 FAILED/internal_error，不伪造 Engine 事件。排队取消立即独立结算，运行取消使用每提交 signal 并等待 Engine 真实终态。
- 快照决策：沿用已确认的 unknown 数据图/opaque 能力边界，普通数据与循环/别名强隔离，函数、未知实例、Proxy 和 accessor 能力保留引用/描述符；不将合法 CustomLoop 数据限制为 JSON。结果根仅保留公开 union 字段，防止额外 then 接管独立结果 Promise；data/details 不丢值。
- 资源决策：事件缓存默认 512 条，溢出释放缓存且只使观察流失败；内部任务结算后释放任务引用，Manager 只保留已发放 ID 字符串以防重用。自定义工厂负责跨 Manager ID 唯一性；不合作清理不强制超时或提前放行下一任务。统一 Logger 诊断不携带业务载荷，故障 best effort。
- 依据/验证：B/C 基础与独立集成定向 8/8 通过；全仓 typecheck、Agent 与基础测试定向 ESLint/Prettier 通过。D 独立控制与全仓最终验收由后续记录补齐。
- 现行说明：[README.md](README.md)

### 2026-11-24 — Phase 1.5-E 离线验收完成

- 主题 ID：`agent.session-management`
- 变更前：B/C 基础和上下文集成已通过，取消、观察流及全仓工程验收待收口。
- 变更后：A–D 契约、Manager、FIFO/配置、取消/缓冲、异常 Engine 流及二进制快照回归全部完成。原生 typed-array/DataView/Buffer 槽位使用原生 prototype getter 读取，不触发调用方同名 accessor；待处理 reader 仅在事件快照成功后移交兑现。
- 修改原因：确认独立结果、上下文事务顺序、异常清理与观察者解耦在真实 Engine 和替代实现中均成立，并防止复制过程意外执行外部 getter。
- 影响范围：本模块最终验收；既有 Engine 的同类内部快照修复另见 [Engine 变更记录](../execution/engine/changes.md)，Phase 1.1–1.4 公共契约保持不变。
- 验证：`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm test` 均实际退出码 0。全仓 **216/216** 测试通过，失败 0、跳过 0；原 **187** 项基线保留，本阶段新增 **29** 项（契约 6、Manager 基础 4、真实 Engine 集成 5、错误流边界 4、取消/观察流 9、二进制快照 1）。
- 现行说明：[README.md](README.md)
