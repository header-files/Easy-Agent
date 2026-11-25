# Runtime Approval — 工具审批

进程内 `ApprovalService`：`always` 工具在获锁前等待人工决策。状态一次性终态；审批超时独立于工具超时。无可用决策通道时失败关闭，不默认批准。

`require` 对参数做 `structuredClone` + 深冻结后放入请求；监听器无法改嵌套字段。`GuardedToolExecutor` 批准后把该冻结快照交给 Handler。

详见 [Phase 2.2](../../../docs/phase-2.2.md)。验证：`node --test tests/approval-guarded-tool.test.ts tests/safe-fs-approval.test.ts`。
