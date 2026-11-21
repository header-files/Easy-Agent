# Logging — 变更记录

> 现行接口与行为见 [README.md](README.md)。按真实日期追加，同一主题保留完整时间线。

## 2026-11-21 — 建立 Logging 基础设施

- 主题 ID：`runtime.logging`
- 变更前：Phase 0 只有工程工具链与职责文档，没有统一日志接口或实现。
- 变更后：新增供应商无关的 Logger、四级日志、模块和结构化字段、错误信息、子 logger、环境级别与 stderr 默认输出；内部由 Pino 实现，写入前统一安全序列化和脱敏。
- 修改原因：用户要求先在 Phase 0 基线上完成 Logging，供后续功能统一使用；不进入 Model 或其他 Agent 业务实现。
- 设计取舍：只提供显式初始化与轻量 child 绑定；不引入全局 DI、文件轮转、完整 tracing 或可观测性平台。保留最小 write 目的地接口以支持离线测试。四个保留字段不允许调用方覆盖，Error 在脱敏后再交给 Pino。
- 影响范围：`src/runtime/logging`、Runtime 父模块说明、依赖与 Logging 离线测试。
- 已执行验证：`npm run typecheck`、Logging 定向 ESLint 和格式化通过；`node --test tests/logging-redaction.test.ts` 的 6 项测试通过。手动注入目的地验证了 JSON 字段、原生 TypeError 和子模块保留字段；完整验收结果由项目记录补充。
- 关联：[Runtime 日志](../changes.md)、[项目级变更记录](../../../docs/changes.md)。

## 2026-11-21 — 修正组合脱敏的重叠边界

- 主题 ID：`runtime.logging.redaction`
- 变更前：文本规则顺序替换时，显式敏感值与标签名称、URL 用户信息或 Bearer 文本重叠，可能破坏后续识别或留下部分敏感值。
- 变更后：所有规则在原文上收集遮盖范围，再合并后统一替换；保留递归字段和异常序列化的处理边界。
- 修改原因：独立审阅与回归用例发现，`redactValues: ['token']` 会影响 `api_token` 标签，跨 URL 用户信息的显式值也不能依赖替换后的文本匹配。
- 影响范围：Logging 文本、模块名、结构化字符串和异常信息；公共 Logger 接口未变。
- 验证：新增标签/查询参数、Bearer、URL 和字面值重叠回归；脱敏测试 7 项通过。完整工程验收结果见项目级记录。
- 现行说明：[README.md](README.md)。
