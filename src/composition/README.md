# Composition / Bootstrap — 配置与应用装配

## 职责与当前状态

已实现 [Phase 1.6](../../docs/phase-1.6.md) 的统一配置解析、默认组件装配和应用生命周期。它是初始化边界，不是新的业务运行层：不实现 Loop 算法、Session FIFO、上下文提交、HTTP 或持久化。

入口 [index.ts](index.ts) 导出 `resolveConfig`、`loadConfig`、`bootstrap`、配置/应用类型及安全错误。项目根入口也提供这些导出。

## 配置

`resolveConfig({ fileConfig?, env?, overrides? })` 是纯函数；`loadConfig({ filePath?, env?, overrides? })` 异步读取显式指定的 JSON 文件，默认在此边界读取 `process.env`。不自动查找配置、不加载 `.env`。优先级：**overrides（CLI） > env > 文件 > 默认值**。参数按键合并，其嵌套值整体替换，返回独立 JSON 数据。

| 配置                  | 环境变量                     | 默认值                                 |
| --------------------- | ---------------------------- | -------------------------------------- |
| model.provider        | —                            | openai-compatible                      |
| model.name            | EASY_AGENT_MODEL             | 必填，无隐含真实模型                   |
| model.baseUrl         | EASY_AGENT_BASE_URL          | Adapter 默认 https://api.openai.com/v1 |
| model.apiKey          | OPENAI_API_KEY               | 可选，支持无认证本地服务               |
| model.parameters      | —                            | 省略                                   |
| agent.maxModelRetries | EASY_AGENT_MAX_MODEL_RETRIES | 2                                      |
| cli.stream            | EASY_AGENT_STREAM            | true                                   |
| logging.level         | LOG_LEVEL                    | info                                   |

布尔环境值支持 true/false/1/0，日志级别忽略大小写和首尾空白。校验必填模型名、非负安全整数重试、无用户信息/query/fragment 的 HTTP(S) URL、凭据头换行、JSON 参数和常用参数范围。未知配置字段拒绝，不能借配置引入 Loop 总次数上限。配置错误只返回固定字段说明，不回显原值、文件路径或 JSON 正文。详细 Provider 参数冲突仍由既有 Model Runtime 在请求边界校验。

示例见 [JSON 配置](../../easy-agent.config.example.json) 和 [环境变量说明](../../.env.example)。密钥优先用环境变量，不写入示例或日志；本地 `easy-agent.config.json`、`easy-agent.config.local.json` 与 `.env` 已被 Git 忽略，仍需通过 `--config` 显式选取 JSON。连接信息不会进入 Session Context。

## 装配与替换

```typescript
import { bootstrap, loadConfig } from './src/index.ts';

const config = await loadConfig({
  filePath: './easy-agent.config.example.json',
});
const app = await bootstrap(config);
try {
  const { sessionId } = app.service.createSession();
  const execution = app.service.submit(sessionId, '请计算 2 加 3');
  const result = await execution.result; // 不观察 events 也照常执行
} finally {
  await app.dispose();
}
```

默认依次装配 OpenAI-compatible ModelClient、ToolRegistry / ToolExecutor、DefaultAgentLoop、DefaultExecutionEngine、DefaultAgentManager、DefaultAgentApplicationService。全程只使用 Phase 1.1～1.5 公共接口。同实例长期复用组件，Session 默认映射模型名/参数以及 `extensions.defaultAgentLoop.maxModelRetries`。

默认仅注册纯计算工具 `add({a,b})`，无网络、文件或命令执行；多工具执行继续由默认 Loop 串行完成。`bootstrap(config, options)` 可注入共享 `modelClient`、`loop`、`engine`、`manager`、`logger`，或用 `tools` 注册额外 ToolSpec/Handler。注入上层组件时跳过它覆盖的下层默认创建；无复杂容器或热插拔体系。

离线测试可直接 `bootstrap(config, { modelClient: mock, logger })`，无需密钥或网络。自定义 Loop 仍满足原有通用契约；应用配置的模型名属于本次产品配置，不能据此收窄 Harness 的可选模型协议。

## 生命周期与所有权

应用只暴露统一 `service` 与 `dispose()`。Composition 包装 Service，登记经它提交且尚未结算的句柄用于关闭，不复制 Session 历史、队列或调度状态。外部共享 Manager 中绕过 Service 提交的任务仍由外部调用方管理。

`dispose()` 同步关闭应用操作入口、返回同一个 Promise，然后取消全部已登记运行/排队任务、等待各自 `result`，再逆序释放自有资源。清理采用既有协作语义，不设置隐藏超时，也不宣称任意不合作底层组件已物理停止；DefaultAgentLoop 对底层模型 finalizer 的既有尽力清理边界不变。重复或取消回调重入 dispose 不会重复释放。退出后 Service 返回 `application_disposed`。

旧组件没有通用 dispose 接口，不能通过猜测方法自动关闭注入组件。共享注入项及 Logger 输出目标由调用方所有，Bootstrap 不调用它们的释放方法。需要由本次装配拥有的自定义模型时，提供 `createModelClient(providerConfig) => {client, dispose?}`；捕获的 dispose 在启动失败回滚/正常退出时执行一次，与 `modelClient` 互斥。工厂在返回前失败时，其尚未移交资源由工厂自身回收。

初始化错误归一为 `BootstrapError(initialization_failed, stage)`，保留失败阶段且不暴露原始第三方异常；回滚失败附带 cleanupFailed 标记。释放函数失败不重复运行，最终返回安全 `cleanup_failed`。无原始错误正文或堆栈透传。

## 文件、验证与边界

- [config.ts](config.ts)、[load-config.ts](load-config.ts)：优先级、校验和显式文件读取。
- [bootstrap.ts](bootstrap.ts)：装配与所有权；[lifecycle.ts](lifecycle.ts)：Service 关闭门及活跃句柄收尾。
- [demo-tool.ts](demo-tool.ts)：纯计算演示工具。
- [配置测试](../../tests/composition-config.test.ts)、[装配测试](../../tests/bootstrap.test.ts)：离线优先级、装配、失败回滚、共享/自有资源、幂等/重入及协作清理。

执行 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm test`。最终实测结果见 [阶段验收](../../docs/phase-1.6.md)，历史决策见 [changes.md](changes.md)。HTTP Server、Session Event Log、持久化恢复及后续能力未实现。
