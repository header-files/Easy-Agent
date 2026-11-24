# CLI — 本地交互适配

## 职责与边界

本地 `easy-agent chat` 聊天、帮助和版本入口。CLI 只通过 Composition 的 `loadConfig` / `bootstrap` 获取统一 `AgentApplicationService`，不创建 ModelClient、ToolExecutor、AgentLoop、ExecutionEngine 或 Session 调度器；没有 HTTP、SSE、远程 CLI、Session 文件或持久化恢复。

`run-cli.ts` 负责参数、终端输入和信号；`render-execution.ts` 只负责事件及最终结果展示。`bin.ts` 在 `import.meta.main` 时运行，导入无执行副作用。运行日志仍由统一 Logger 输出 stderr；终端正文是 Application 的交互输出。

## 运行方式

在仓库根目录：

```bash
npm run chat -- --config easy-agent.config.example.json
node src/application/cli/bin.ts --help
node src/application/cli/bin.ts --version
npm run build
node dist/application/cli/bin.js chat --config easy-agent.config.example.json
```

模型连接和配置示例见 [Composition README](../../composition/README.md) 与 [easy-agent.config.example.json](../../../easy-agent.config.example.json)。Provider 密钥可写在本地 JSON，或通过配置中的 `${ENV}` 引用**已导出的**进程环境变量（如 `OPENAI_API_KEY`）；不提供密钥命令行选项，不提供/不加载 `.env.example` 或 `.env`。优先级统一为 CLI 显式选项 > 环境变量 > 指定配置文件 > 内置默认值。

支持 `--config <path>`、`--model <provider/model>`、`--max-model-retries <count>` 和 `--no-stream`。`--model` 必须是已注册完整模型标识。`--help` / `--version` 不读取模型配置或装配组件。

## 交互和生命周期

- `/model`：列出 Registry 显式注册模型，当前 Session 模型前加 `*`。
- `/model <provider-id/model-id>`：校验并切换**当前 Session** 默认模型；无效选择保持原值。
- `/new` 创建并切换至新的空 Session，旧 Session 留在进程内，不复制历史、不删除旧会话。
- `/exit` 在当前轮最终结果完成后消费，随后执行 `dispose()`。CLI 每轮等待最终结果再接受下一条指令；即使管道一次传入多行，也按输入顺序处理，不会让预读的 `/exit` 取消第一轮。
- 活动任务期间 Ctrl+C 显式调用 `service.cancel(sessionId, executionId)`，重复信号不重复提交取消；继续等待实际最终结果和底层协作收尾，不将取消请求当作终态。空闲时 Ctrl+C 退出。
- EOF 处理完已收到的输入并等待当前轮结果再清理。退出只释放本 CLI 创建的 readline 和信号监听，输入/输出流由调用方拥有。
- 空行忽略，未知 `/` 指令清晰提示。执行/结果错误会显示失败，进程退出码为 1；主动取消显示 `CANCELLED`，允许继续下一轮。

## 输出与观察语义

正文只展示 `loop_event.event.output_delta`，不重复打印 `model_event.text_delta` 或任意工具结果。模型新一轮 `message_start` 只用于划分预览，不打印其正文；工具前置解释与最终模型回答分别比较，避免把整次模型往返的增量拼接后又重复打印最终回答。最终 `result` 是权威来源：完整输出与最后一轮增量相同不重印，是已显示文本的扩展时只补后缀；自定义 Loop 最终输出与预览不一致时显示明确的“最终答案，替换此前预览”区块。终端或管道已经写出的预览字节无法撤销，此区块表示替换，不将完整答案冒充新增增量。`--no-stream` 只显示最终答案。

观察流抛错（包括 Agent 缓冲溢出）只提示观察中断，仍等待独立 `result`，不发取消、不将观察结束当作执行成功。进入事件观察前就为结果 Promise 注册拒绝处理，避免注入组件的提前拒绝成为未处理异常；标准 Phase 1.5 结果始终 resolve 的契约不变。

用户输出与错误分开写入 stdout/stderr；原始启动、执行、观察和清理异常不透传堆栈或配置内容。

## 可测试入口与验证

`index.ts` 导出 `runCli(args, options)`，返回退出码而不调用 `process.exit()`。`options` 可注入 `Readable` 输入、`Writable` 输出/错误流、`SIGINT` 信号源、配置加载函数和 Bootstrap 函数，便于 CLI 单元及完整离线集成测试；不会向 Harness 添加测试字段。

`node --test tests/cli.test.ts` 覆盖帮助/版本、参数映射、`/model`、管道多轮、新 Session、实时输出、去重及权威结果补足、观察错误、最终结果失败/拒绝、Ctrl+C、EOF 和资源收尾。完整工程检查见 [规范](../../../docs/conventions.md)，阶段依据见 [Phase 2.1](../../../docs/phase-2.1.md)。
