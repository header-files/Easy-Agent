# Runtime Workspace — 变更记录

> 当前行为见 [README.md](README.md)。

### 2026-11-25 — 建立 WorkspaceManager 与 AccessCoordinator

- 主题 ID：`runtime.workspace-baseline`
- 变更前：Runtime 无 Workspace 能力域实现。
- 变更后：新增进程内 Workspace 注册/创建、默认 Workspace、Session 引用计数、重叠根路径拒绝、写优先读写锁与 `UNSAFE`/`recover`。
- 修改原因：Phase 2.2 要求文件/终端工具在统一 Workspace 边界与访问协调下运行。
- 影响范围：本子模块及后续 GuardedToolExecutor / CLI 装配。
- 验证：`node --test tests/workspace.test.ts`。

### 2026-11-26 — Workspace 冷启动 restore 固定 ID

- 主题 ID：`runtime.workspace.persistence.phase-2.4`
- 变更前：仅能 register/create 生成新 ID。
- 变更后：新增 `restore({ id, name, rootPath })` 供 Bootstrap 按 Registry Projection 重建；AccessCoordinator 仍管进程内锁与 UNSAFE。
- 修改原因：Phase 2.4 Workspace Registry 与 Session 引用一致性。
- 影响范围：WorkspaceManager；物理路径规则不变。
- 现行说明：[README.md](README.md)。

### 2026-11-26 — live Terminal 活动登记

- 主题 ID：`runtime.workspace.persistence.phase-2.4`
- 变更前：Coordinator 仅有锁与 UNSAFE；无法区分「intent 已提交但仍在运行」与「进程已结束但未 settled」。
- 变更后：`beginTerminalActivity` / `endTerminalActivity` / `listLiveTerminalActivities`；Terminal Handler 在 intent COMMITTED 后登记、返回时清除。
- 修改原因：复查指出 `recoverWorkspace` 可覆盖仍在运行的 Terminal intent。
- 影响范围：AccessCoordinator、Terminal 内置工具、Application `recoverWorkspace`。
- 验证：phase-2.4「运行中 Terminal intent 拒绝人工恢复」。
- 现行说明：[README.md](README.md)。
