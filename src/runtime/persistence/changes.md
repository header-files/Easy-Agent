# Persistence — 变更记录

> 仅记录 `src/runtime/persistence/` 实质性变更。现行说明见 [README.md](README.md)。

## 变更时间线

### 2026-11-26 — Phase 2.4 落地 Journal / Coordinator / Roll Forward / Projection

- 主题 ID：`runtime.persistence.phase-2.4`
- 变更前：无本地事务与 Session Event Log；Workspace UNSAFE 仅进程内。
- 变更后：实现 Transaction Journal、Session Write Coordinator、JSONL 存储、Roll Forward、Projection 重放、Workspace Lifecycle Coordinator、PersistenceBridge；支持 `persistence.dataDir`。
- 修改原因：按 `docs/phase-2.4.md` 十项设计决策补齐可靠持久化与冷启动重建。
- 影响范围：Composition Bootstrap、Agent Session、Loop/Tool/Terminal、Application Workspace 管理。
- 依据/验证：`tests/persistence-journal.test.ts`、`tests/phase-2.4-persistence.test.ts`（darwin）。
- 现行说明：[README.md](README.md)

### 2026-11-26 — 恢复完整性、不确定冻结与关键载荷补全

- 主题 ID：`runtime.persistence.phase-2.4`
- 变更前：COMMITTED 不核验目标记录；COMMIT_UNCERTAIN 后仍可继续写；llm/request 与 tool/result 载荷过简。
- 变更后：启动时 verifyCommittedOperations；不确定提交冻结 scope；llm/request 存标准化请求，tool/result 含 content/error。
- 修改原因：对照 phase-2.4 恢复规则与关键事实完整性复查。
- 验证：`tests/persistence-journal.test.ts` 新增缺失记录/冻结用例；全仓 306 通过。

### 2026-11-26 — Journal 全局冻结与 dataDir owner-only 权限

- 主题 ID：`runtime.persistence.phase-2.4`
- 变更前：Journal 追加失败仅冻结当前 scope；数据目录/事件文件默认 755/644。
- 变更后：Journal PREPARED/COMMITTED 故障设置 `journalFrozen`，拒绝一切新事务；目标存储故障仍仅冻结对应 scope；`ensureDir`/`appendJsonl`/`WriteLock` 使用 `0700`/`0600`。
- 修改原因：复查指出全局 Journal 故障应停止全部 Session 新事务，且 Event Log 可含秘密需明确保护策略。
- 影响范围：`session-write-coordinator.ts`、`durable-fs.ts`、`write-lock.ts`、Persistence README。
- 验证：`tests/persistence-journal.test.ts` 全局冻结用例；`tests/phase-2.4-persistence.test.ts` 权限用例；全仓 311 通过。
- 现行说明：[README.md](README.md)。

### 2026-11-26 — session/deleted、durableCommitted 与创建载荷补全

- 主题 ID：`runtime.persistence.phase-2.4`
- 变更前：无 Session 删除事实；COMMITTED 后 Projection 刷新失败与提交前失败无法区分；`session/created` 载荷过简。
- 变更后：增加 `session/deleted` 与 Projection `removed`；`PersistenceError.durableCommitted` + Bridge 刷新失败标记；`session/created` 含 modelParameters/extensions/初始 context；测试可注入 `failNextProjectionRefresh`。
- 修改原因：复查复现删除复活、提交后误回滚、取消与 INTERRUPTED 冲突、初始上下文丢失。
- 验证：phase-2.4 新增删除/刷新失败/上下文恢复用例。
- 现行说明：[README.md](README.md)。

### 2026-11-26 — Session 路径安全、权威 context 与 commit_uncertain

- 主题 ID：`runtime.persistence.phase-2.4`
- 变更前：Session ID 可拼接逃逸 dataDir；Message Projection 仅追加 delta；无 `isCommitUncertain` 辅助。
- 变更后：`assertSafeSessionStorageId` + 路径边界校验；`execution/completed.context` 完整替换；导出 `isCommitUncertain`；Bridge 可注入 COMMITTED sync 失败。
- 修改原因：复查路径逃逸、updatedContext 替换失效、不确定提交被当确定失败。
- 验证：phase-2.4 路径/替换/uncertain 用例。
- 现行说明：[README.md](README.md)。

### 2026-11-26 — Projection 刷新串行化

- 主题 ID：`runtime.persistence.phase-2.4`
- 变更前：跨 Session 并发提交后各自独立重放并覆盖共享 Projection，旧刷新可覆盖新视图。
- 变更后：`refreshProjections` 经 Promise 链串行；每次重放在前一次结束后读取最新 Journal。
- 修改原因：复查指出并发提交可造成 Session/Workspace 引用与安全状态瞬时误判。
- 验证：phase-2.4「并发提交后 Projection 刷新不丢 Session」。
- 现行说明：[README.md](README.md)。

### 2026-11-26 — 引用完整性与 PREPARED 事务 ID 绑定校验

- 主题 ID：`runtime.persistence.phase-2.4`
- 变更前：Session 可引用缺失 Workspace 仍可写启动；PREPARED 不核验 Operation.record.transactionId。
- 变更后：`assertProjectionReferences`；`validatePrepared` 要求 record.transactionId（及 sessionId）与事务一致，否则 `corrupt_store`。
- 修改原因：复查复现悬空 Workspace 引用与事务 ID 错绑仍被提交却不可见。
- 验证：persistence-journal / phase-2.4 对应 corrupt_store 用例。
- 现行说明：[README.md](README.md)。

### 2026-11-26 — Journal COMMITTED 顺序与重复标记校验

- 主题 ID：`runtime.persistence.phase-2.4`
- 变更前：`indexJournal` 将 COMMITTED 直接加入 Set，不校验相对 PREPARED 的顺序，也不拒绝重复/冲突 COMMITTED。
- 变更后：同事务 COMMITTED 必须出现在其 PREPARED 之后；重复 COMMITTED（含同内容）与内容冲突分别以 `corrupt_store` / `conflict` 拒绝。
- 修改原因：复查复现异常 Journal 仍可写启动。
- 验证：`tests/persistence-journal.test.ts` 顺序/重复/可写启动用例。
- 现行说明：[README.md](README.md)。

### 2026-11-26 — 中断仅冷启动；Context data 进入 Projection

- 主题 ID：`runtime.persistence.phase-2.4`
- 变更前：每次 `replayProjections` 都把 CREATED/STARTED 升为 INTERRUPTED；`asInitialContext` 只保留 messages。
- 变更后：`interruptUnfinished` 仅 `openPersistenceRuntime` 开启；`initialContext.data` + 权威 `committedContextData`。
- 修改原因：复查活跃 Execution 被误报中断；恢复丢失 context.data。
- 验证：phase-2.4 进程内刷新与 Context data 恢复用例。
- 现行说明：[README.md](README.md)。

### 2026-11-26 — 冷启动中断经 refresh 保留；JSON 安全序列化

- 主题 ID：`runtime.persistence.phase-2.4`
- 变更前：冷启动 INTERRUPTED 在 Bootstrap 登记 Workspace 触发的 refresh 后回到 CREATED/STARTED；`stableStringify` 把 Date/Map 静默写成 `{}`。
- 变更后：`coldInterruptPending` 在 `interrupted_detected` 落盘前于 refresh 重放；`assertDurableJsonValue` fail-closed。
- 修改原因：复查启动后历史查询误报 CREATED；非 JSON data 报告成功却丢数据。
- 验证：phase-2.4 Bootstrap/refresh 中断用例；persistence-journal stringify 用例。
- 现行说明：[README.md](README.md)。
