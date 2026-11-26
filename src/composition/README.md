# Composition / Bootstrap — 配置与应用装配

## 职责与当前状态

已实现统一配置解析、多 Provider 静态工厂装配、Model Registry / Router 注入、可选 Persistence 打开与冷启动恢复，以及应用生命周期。它是初始化边界，不是新的业务运行层：不实现 Loop 算法、Session FIFO、上下文提交或 HTTP。

入口 [index.ts](index.ts) 导出 `resolveConfig`、`loadConfig`、`bootstrap`、配置/应用类型及安全错误。项目根入口也提供这些导出。

## 配置

`resolveConfig({ fileConfig?, env?, overrides? })` 是纯函数；`loadConfig({ filePath?, env?, overrides? })` 异步读取显式指定的 JSON 文件，默认在此边界读取 `process.env`。不自动查找配置、不加载 `.env`。优先级：**overrides（CLI） > env > 文件 > 默认值**。参数按键合并，其嵌套值整体替换，返回独立 JSON 数据。

| 配置                          | 环境变量                       | 默认值 / 规则                                                                       |
| ----------------------------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| `providers.<id>.type`         | —                              | 必填协议实现：`openai-compatible` 或 `openai-responses`（不是厂商名）               |
| `providers.<id>.baseURL`      | 可用 `${ENV}` 整串引用         | **必填**；由用户显式填写，代码不预设厂商地址                                        |
| `providers.<id>.apiKey`       | 可用 `${ENV}` 整串引用         | Compatible 可选；Responses 必填                                                     |
| `models`                      | —                              | 必填显式列表，格式 `providerId/modelId`                                             |
| `defaultModel`                | `EASY_AGENT_DEFAULT_MODEL`     | 必须已在 `models` 中注册                                                            |
| `agent.maxModelRetries`       | `EASY_AGENT_MAX_MODEL_RETRIES` | `2`                                                                                 |
| `cli.stream`                  | `EASY_AGENT_STREAM`            | `true`                                                                              |
| `logging.level`               | `LOG_LEVEL`                    | `info`                                                                              |
| `workspace.path`              | —                              | 可选默认 Workspace 根目录；存在则 register，否则 create；支持前导 `~/`              |
| `workspace.approvalTimeoutMs` | —                              | 可选审批等待上限（与 toolTimeout 独立）                                             |
| `terminal.shell`              | —                              | 可选覆盖默认 Shell（POSIX `/bin/sh`，Windows `ComSpec`→`cmd.exe`）                  |
| `persistence.dataDir`         | —                              | 可选本地数据目录；配置后启用 Journal/Event Log/Registry 与冷启动恢复；支持前导 `~/` |

Provider ID 只表示配置实例身份，**不能**决定协议实现；实现由 `type` 选择。模型标识按第一个 `/` 拆分，上游 Model ID 可继续含 `/`。未知 `type`、未知 Provider、重复模型、未注册默认模型、非法 URL/密钥在启动时拒绝。不保留 Phase 1 单 `model` 配置兼容层。

布尔环境值支持 true/false/1/0，日志级别忽略大小写和首尾空白。配置错误只返回固定字段说明，不回显原值、文件路径或 JSON 正文。

示例见 [JSON 配置](../../easy-agent.config.example.json)。密钥可用配置明文或 `${ENV}` 引用进程环境变量，不写入会提交的示例或日志；本地 `easy-agent.config.json`、`easy-agent.config.local.json` 与 `.env` 已被 Git 忽略，仍需通过 `--config` 显式选取 JSON。连接信息不会进入 Session Context。

## 装配与替换

```typescript
import { bootstrap, loadConfig } from './src/index.ts';

const config = await loadConfig({
  filePath: './easy-agent.config.example.json',
});
const app = await bootstrap(config);
try {
  const { sessionId } = await app.service.createSession();
  const execution = app.service.submit(sessionId, '请计算 2 加 3');
  const result = await execution.result; // 不观察 events 也照常执行
} finally {
  await app.dispose();
}
```

默认关联链路：

`Provider Type → Factory → Provider Instance → Model Registry → Model Router → DefaultAgentLoop`

内置工厂（**按协议 type 选实现，绝不按 Provider ID 推断厂商；不内置厂商 baseURL**）：

| type                | 实现                          | 备注                               |
| ------------------- | ----------------------------- | ---------------------------------- |
| `openai-compatible` | `OpenAICompatibleModelClient` | Chat Completions 兼容；apiKey 可选 |
| `openai-responses`  | `OpenAIResponsesModelClient`  | 原生 Responses；apiKey 必填        |

同一协议 type 可按不同 Provider ID + 各自 `baseURL`/`apiKey` 创建独立实例（例如 OpenAI、Qwen、DeepSeek 都用 `openai-compatible`，只改地址与密钥）。Router 按完整模型标识路由，并向 Provider 发送去掉 Provider ID 后的上游 Model ID。Application 默认 Session 模型为 `config.defaultModel`。

默认注册内置 FileSystem/Terminal 工具；多工具执行继续由默认 Loop 串行完成。Bootstrap 装配 `WorkspaceManager`、`WorkspaceAccessCoordinator`、`ApprovalService` 与 `GuardedToolExecutor`（校验→审批→锁→Handler；审批不计入 toolTimeout）。配置了 `workspace.path` 时创建默认 Workspace 并在新建 Session 时绑定。`bootstrap(config, options)` 可注入 `providerFactories`、`loop`、`engine`、`manager`、`logger`，或用 `tools` 注册额外 ToolSpec/Handler（注入工具默认 `approval=never`）。注入上层组件时跳过它覆盖的下层默认创建；无复杂容器或热插拔体系。

离线测试可直接：

```typescript
bootstrap(config, {
  providerFactories: {
    'openai-compatible': () => ({ client: mock }),
  },
  logger,
});
```

## 生命周期与所有权

应用只暴露统一 `service` 与 `dispose()`。Composition 包装 Service，登记经它提交且尚未结算的句柄用于关闭，不复制 Session 历史、队列或调度状态。

`dispose()` 同步关闭应用操作入口、返回同一个 Promise，然后取消全部已登记运行/排队任务、等待各自 `result`，再逆序释放自有 Provider。清理采用既有协作语义，不设置隐藏超时。重复或取消回调重入 dispose 不会重复释放。退出后 Service 返回 `application_disposed`。

共享注入项及 Logger 输出目标由调用方所有。需要由本次装配拥有的 Provider 时，工厂可返回 `{client, dispose?}`；即使返回的 client 非法，已移交的 dispose 也会在启动失败回滚时执行一次。

初始化错误归一为 `BootstrapError(initialization_failed, stage)`，保留失败阶段且不暴露原始第三方异常；回滚失败附带 cleanupFailed 标记。释放函数失败不重复运行，最终返回安全 `cleanup_failed`。

## 文件、验证与边界

- [config.ts](config.ts)、[load-config.ts](load-config.ts)：优先级、校验和显式文件读取。
- [bootstrap.ts](bootstrap.ts)：工厂映射、Registry/Router 装配与所有权；[lifecycle.ts](lifecycle.ts)：Service 关闭门及活跃句柄收尾。
- [配置测试](../../tests/composition-config.test.ts)、[装配测试](../../tests/bootstrap.test.ts)：离线优先级、装配、失败回滚、自有资源、幂等/重入及协作清理。

执行 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm test`。阶段验收见 [Phase 2.4](../../docs/phase-2.4.md) §17 与 [Phase 2.2](../../docs/phase-2.2.md)，历史决策见 [changes.md](changes.md)。

配置 `persistence.dataDir` 时，Bootstrap 打开 Journal、**先**落盘冷启动 `interrupted_detected`、再登记默认 Workspace / 恢复 Session Projection，并注入严格提交门槛；详见 [Persistence README](../runtime/persistence/README.md)。HTTP Server、Provider 热更新、Docker/OS 沙箱及后续能力未实现。
