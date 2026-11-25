# Runtime Tool — 变更记录

> 当前实现以 [README.md](README.md) 与已验证代码为准。真实日期追加，同一主题保留时间线。

## 2026-11-22 — Phase 1.2 Tool Runtime 实现基线

- 主题 ID：`runtime.tool-system`
- 变更前：Runtime 已有 Logging 与 Model System，仅支持模型 Tool Calling 数据，不执行工具。
- 变更后：实现 DefaultToolRegistry、DefaultToolExecutor、同步 draft-07 Schema 校验及两项 Model Bridge；本地 Handler 由注册表快照执行，参数与控制状态按调用隔离。
- 修改原因：用户确认 Phase 1.2 任务书，为后续 Phase 1.3 Agent Loop 提供可直接依赖的 ToolExecutor；先通过 Harness Tool Contracts 基础验收再实施 Runtime。
- 设计取舍：Ajv 8.20.0 为直接生产依赖；禁用默认值、类型转换和未知字段删除，拒绝不支持/无法解析/异步 Schema，不加载外部 Schema。不同 Schema 独立实例，不引入缓存协议、持久化或全局锁。
- 结果与控制：普通失败返回三类统一 ToolResult，固定消息不暴露 Handler 原始异常；只有当前调用主动取消或超时抛 ToolExecutionError。单次取得稳定注册记录，注销/重注册不影响在途调用，不重试、不声称副作用回滚。
- 稳定性：声明使用自身数据属性，拒绝 accessor；调用身份、选项和 Handler content 各按一次快照校验，避免动态 getter 改变已确认的数据类型。
- 影响范围：`src/runtime/tool`、Runtime 父模块、本地工具测试与跨模块桥接；不修改 Model 1.1 契约与实现，不进入 Loop、Engine、Session 或完整模型调用循环。
- 验证：`npm run typecheck`、定向 ESLint、Prettier 与 `git diff --check` 通过；契约 6 项、Runtime 14 项、集成 13 项共 33 项 Tool 测试通过，覆盖注册/Schema/快照、并发、取消/超时、迟到拒绝、日志和桥接；最终整仓验收以项目阶段记录为准。
- 关联：[Harness Tool 时间线](../../harness/contracts/tool/changes.md)、[Runtime 时间线](../changes.md)、[项目级记录](../../../docs/changes.md)。

### 2026-11-25 — GuardedToolExecutor 与工具运行时元数据

- 主题 ID：`runtime.guarded-tool-executor`
- 变更前：DefaultToolExecutor 用单一 timeout 包裹校验与 Handler；无审批/Workspace 前置。
- 变更后：注册可选 `approval`/`workspaceAccess` 元数据；GuardedToolExecutor 顺序为校验→审批（不计工具超时、不持锁）→Workspace 锁→Handler（单独 timeout）。
- 修改原因：Phase 2.2 分阶段超时与统一前置链。
- 验证：`tests/approval-guarded-tool.test.ts`。

### 2026-11-25 — 锁持有、Terminal 清理与文件打开竞态修补

- 主题 ID：`runtime.guarded-tool-executor`
- 变更前：`Promise.race` 超时后即可退出锁区，Handler/Terminal 清理可能仍在运行；`write_file` 用 resolve+rename，存在覆盖竞态。
- 变更后：`ExecutionControl.runUntilSettled` + Guarded 在超时/取消后等待 Handler 结束或宽限后 `UNSAFE` 再放锁；Terminal 在返回前 `await` 终止流程；FS 读写使用 `O_NOFOLLOW`/`O_EXCL` 等贴近 open 的标志。
- 修改原因：验收发现问题 1/2/4——锁与清理边界、文件竞态。
- 验证：`tests/workspace-lock-hold.test.ts`、`tests/filesystem-tools.test.ts`、`tests/terminal-tool.test.ts`；全仓 283 通过。

### 2026-11-25 — 原子覆盖、路径加固与批准参数快照

- 主题 ID：`runtime.guarded-tool-executor`
- 变更前：覆盖/编辑可能先 `O_TRUNC` 清空目标；无 `O_NOFOLLOW` 时静默普通打开；Handler 可能用可变参数对象。
- 变更后：`writeFileOverwrite` 先同目录临时文件再 `rename`；无 `O_NOFOLLOW` 时依赖逐组件 `lstat`（有 Workspace 根）否则拒绝不可证路径；`list_directory` 经 `openDirRead`；Guarded 使用批准快照 `arguments`。
- 修改原因：二次验收——失败写入毁原文件、路径竞态与批准后参数约束。
- 影响范围：`builtins/safe-fs.ts`、`filesystem.ts`、`guarded-tool-executor.ts`。
- 验证：`tests/safe-fs-approval.test.ts`、`tests/filesystem-tools.test.ts`；残留 TOCTOU / Windows 原生路径仍见 Phase 2.2 §14。

### 2026-11-25 — list_directory 目录替换越界失败关闭

- 主题 ID：`runtime.guarded-tool-executor`
- 变更前：`openDirRead` 后仍 `fs.readdir(dir)`；打开与枚举间隙可将目录换成区外符号链接并泄露区外条目。
- 变更后：`listVerifiedDirectoryNames` 持句柄，`readdir` 前后及子项 `lstat` 前后用 `dev`/`ino`（及非 symlink）断言同一目录；不匹配则 `invalid_path`。
- 修改原因：三次复查可复现 Workspace 越界。
- 影响范围：`safe-fs.ts`、`filesystem.ts`。
- 验证：`tests/filesystem-tools.test.ts`（注入 readdir 间隙替换）。

### 2026-11-25 — Terminal 等待进程组后代后再释放语义

- 主题 ID：`runtime.guarded-tool-executor`
- 变更前：Shell `exit` 即返回成功；同组后台任务（如 `(sleep 1; echo x > f) &`）可在 Workspace 锁释放后继续写文件。
- 变更后：POSIX 下 Shell 退出后轮询 `kill(-pgid,0)` 直至进程组空闲；超时/取消则 SIGTERM/SIGKILL 进程组，仍存活则 UNSAFE。Windows 仍为 best-effort（tasklist 根 PID）。
- 修改原因：五次复查——不得仅凭主进程退出认定后代退出。
- 影响范围：`terminal-executor.ts`。
- 验证：`tests/terminal-tool.test.ts`（后台 sleep 写 marker）。
