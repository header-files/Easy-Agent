# Runtime Approval — 变更记录

### 2026-11-25 — 建立 ApprovalService

- 主题 ID：`runtime.approval-service`
- 变更前：无审批能力。
- 变更后：进程内 PENDING→APPROVED/REJECTED/CANCELLED/EXPIRED；可订阅、列表与 decide；独立超时；无通道时 unavailable。
- 修改原因：Phase 2.2 写文件与 Terminal 默认 always 审批。
- 验证：`tests/approval-guarded-tool.test.ts`。

### 2026-11-25 — 无订阅者故障关闭与迟到订阅重放

- 主题 ID：`runtime.approval-service`
- 变更前：`channelOpen` 默认为 true 且可不设订阅者；审批可能无限等待。
- 变更后：`require` 在 `listeners.size===0` 时立即 `unavailable`；`subscribe` 重放当前 PENDING；Guarded 默认 `approvalTimeoutMs=120s`。
- 修改原因：验收问题 3——无审批接收方须失败关闭。
- 验证：`tests/approval-guarded-tool.test.ts`。

### 2026-11-25 — 审批参数深克隆深冻结

- 主题 ID：`runtime.approval-service`
- 变更前：仅浅冻结顶层 `arguments`，监听器可改嵌套字段后仍被批准执行。
- 变更后：`structuredClone` + `deepFreeze`；嵌套篡改抛错；Handler 侧使用同一冻结快照。
- 修改原因：二次验收——批准期间参数可变。
- 验证：`tests/safe-fs-approval.test.ts`。
