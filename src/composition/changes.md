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

### 2026-11-24 — Phase 2.1 Providers/Models 配置与工厂装配

- 主题 ID：`composition.multi-model-bootstrap`
- 变更前：单 `model` 配置字段与 `modelClient` / `createModelClient` 单 Provider 装配。
- 变更后：统一 `providers` / `models` / `defaultModel`；静态 `Provider Type → Factory`；按 Provider ID 创建独立实例并注入 Registry/Router；`providerFactories` 可覆盖内置工厂。删除旧单模型配置兼容与 `--base-url` 相关装配路径。非法 client 返回前已捕获的 dispose 仍参与回滚。
- 修改原因：Phase 2.1 要求 type 选实现、ID 作实例身份，并集中管理多模型注册。
- 影响范围：config/bootstrap/lifecycle、示例配置、配置与装配测试、Application 默认模型注入。
- 验证：配置/Bootstrap 定向测试与全仓 266 项通过。
- 现行说明：[README.md](README.md)；跨模块摘要见 [项目变更](../../docs/changes.md)。

### 2026-11-24 — 增加 OpenAI / Qwen / DeepSeek Compatible 厂商预设

- 主题 ID：`composition.vendor-compatible-presets`
- 变更前：仅有通用 `openai-compatible` 与 `openai-responses` 两种 type。
- 变更后：新增 `openai` / `qwen` / `deepseek` 静态工厂，复用 `OpenAICompatibleModelClient`，分别应用官方默认 baseURL 与 Token 字段；仍按 type 选实现，允许覆盖 baseURL；云厂商预设要求 apiKey。
- 修改原因：用户要求按官方文档落地三家 OpenAI-compatible Provider，避免手工抄写端点。
- 影响范围：config/bootstrap、示例配置、Runtime presets、离线测试与模块说明。
- 验证：`node --test tests/provider-presets.test.ts` 与工程检查。
- 现行说明：[README.md](README.md)。

### 2026-11-24 — 取消厂商预设 type/默认 baseURL

- 主题 ID：`composition.protocol-only-providers`
- 变更前：存在 `openai` / `qwen` / `deepseek` 厂商 type，并在工厂内硬编码官方 baseURL。
- 变更后：仅保留协议 type `openai-compatible` 与 `openai-responses`；`baseURL` 配置必填并由用户显式提供；同一协议可用不同 Provider ID 对接任意厂商。
- 修改原因：用户要求 type 只表达协议实现，不在代码中预设厂商地址或厂商 type。
- 影响范围：config/bootstrap、示例配置、模块说明与离线测试。
- 验证：`npm run typecheck` / `lint` / `test`。
- 现行说明：[README.md](README.md)。

### 2026-11-24 — 删除未使用的 .env.example

- 主题 ID：`composition.remove-env-example`
- 变更前：仓库保留 `.env.example` 作为环境变量清单，文档多处链接。
- 变更后：删除该文件及 `.gitignore` 例外；文档改为指向 JSON 示例与 `${ENV}` / 进程环境说明。
- 修改原因：应用不读取 `.env`，用户确认清单文件无运行时用途后要求删除。
- 影响范围：根目录模板、README/Composition/阶段文档链接。
- 验证：确认无 dotenv、无代码/测试加载 `.env.example`。
