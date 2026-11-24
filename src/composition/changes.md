# Composition / Bootstrap — 装配与启动入口 — 变更记录

> 本文件仅记录 **`src/composition/` 模块范围内** 实质性设计和实现变化。当前有效实现以 [README.md](README.md) 和代码为准；历史记录只追加不覆盖。

## 记录范围与规则

- 本模块职责、行为、内部技术方案、接口、重要问题修复或实现取舍发生实质性变化时，追加记录。
- 每条记录填写真实日期、稳定主题 ID、变更前、变更后、原因、影响范围，必要时附测试/关联决策。
- 同一主题多次修改使用同一主题 ID，**按发生时间持续追加**，不得覆盖历史。
- 纯拼写、格式化等非实质性修改不必记入。
- 跨模块或全局架构变化：同时更新涉及的模块说明，并在 [`docs/changes.md`](../../docs/changes.md) 记录全局决策摘要，链接到模块详细记录；避免双份完整内容。

## 记录模板

```markdown
### YYYY-MM-DD — <标题>

- 主题 ID：`composition.topic`
- 变更前：...
- 变更后：...
- 修改原因：...
- 影响范围：...
- 依据/验证：...（可选）
- 现行说明：[README.md](README.md)
```

## 变更时间线

Phase 0 创建说明文档建立初始基线；以下随实际功能落地追加演进记录。

### 2026-11-24 — 统一配置、默认装配与应用生命周期

- 主题 ID：`composition.bootstrap`
- 变更前：只有模块职责文档，各调用方手动创建与连接 Model/Tool/Loop/Engine/Manager，没有统一配置或应用关闭边界。
- 变更后：实现纯 resolveConfig、显式 JSON / 环境加载及 CLI > 环境 > 文件 > 默认优先级；bootstrap 复用已确认组件，返回共享 Service 与幂等 dispose，注册无外部副作用的 add 工具。
- 修改原因：Phase 1.6 要求本地 CLI 和未来适配器复用统一入口与装配，不复制 Session 调度或默认 Loop 策略。
- 生命周期决定：只跟踪经 Service 提交的未结算句柄；先关闭入口、取消并等待结果，再逆序释放自有资源。无新通用 dispose 契约，借入组件不释放；自有模型工厂显式移交一次释放函数，初始化失败回滚。幂等 Promise 在调用外部取消前建立，防止重入重复收尾。
- 配置与安全：模型名必填，默认重试 2、流式 true、日志 info；连接字段只传 Adapter，重试放既有 defaultAgentLoop 命名空间。不读 .env，不回显配置原文、原始第三方错误或密钥。
- 影响范围：Composition、Application Service 生命周期包装、根公共导出、CLI 装配和离线测试；Phase 1.1～1.5 公共契约和实现保持原状，无 HTTP/持久化能力。
- 验证：配置 3 项、Bootstrap 6 项定向离线测试通过；全仓 typecheck、Lint、格式检查、构建和测试均通过，254/254 项成功（既有 216 + 本期 38）。完整结果见 [Phase 1.6](../../docs/phase-1.6.md)，跨模块记录见 [项目变更](../../docs/changes.md)。
- 现行说明：[README.md](README.md)。
