# Runtime Workspace — 变更记录

> 当前行为见 [README.md](README.md)。

### 2026-11-25 — 建立 WorkspaceManager 与 AccessCoordinator

- 主题 ID：`runtime.workspace-baseline`
- 变更前：Runtime 无 Workspace 能力域实现。
- 变更后：新增进程内 Workspace 注册/创建、默认 Workspace、Session 引用计数、重叠根路径拒绝、写优先读写锁与 `UNSAFE`/`recover`。
- 修改原因：Phase 2.2 要求文件/终端工具在统一 Workspace 边界与访问协调下运行。
- 影响范围：本子模块及后续 GuardedToolExecutor / CLI 装配。
- 验证：`node --test tests/workspace.test.ts`。
