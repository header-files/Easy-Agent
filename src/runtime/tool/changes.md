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
