# Logging — 统一日志基础设施

## 定位与当前状态

在 Phase 0 工程基线上提供可直接使用的 Logging 能力，为后续模块提供统一的日志入口。公共接口独立于日志供应商，当前使用 Pino 10.4.0 输出结构化 JSON；更换实现时，调用方继续依赖 `Logger`。

本模块负责四种级别、模块标识、结构化字段、错误序列化、子 logger、级别配置、输出目的地和脱敏。Logging 在 Phase 1 业务前已完成，当前 Model System 通过此门面记录调用生命周期；日志模块不承担模型请求、Agent、Loop、Engine、Session 或工具执行，也不提供全局 DI、日志轮转、文件管理、HTTP 日志中间件、分布式 tracing 或完整可观测性平台。

## 公共入口

从 `src/runtime/logging/index.ts` 导入 `createLogger`、`Logger`、`LoggerOptions`、`LogLevel`、`LogFields` 和 `LogDestination`。

```typescript
import { createLogger } from './src/runtime/logging/index.ts';

const logger = createLogger({ module: 'easy-agent' });
logger.info('Application initialized', { version: '0.0.0' });

const runtimeLogger = logger.child('runtime', { component: 'bootstrap' });
runtimeLogger.debug('Configuration loaded', { source: 'environment' });
runtimeLogger.error('Initialization failed', {
  err: new Error('Required configuration is missing'),
});
```

默认配置下 `debug` 不输出。日志直接写入 stderr，stdout 留给未来业务输出。

```typescript
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(module: string, bindings?: LogFields): Logger;
}
```

日志供应商类型仅出现在内部 `pino-logger.ts`；公共接口不暴露 Pino 类型或实例。模块依赖通过调用方显式传入 logger，当前没有全局单例或容器。

## 初始化与级别

| 选项                                                  | 行为                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `module?: string`                                     | 默认 `easy-agent`；要求非空文本；子 logger 使用传入的完整名称          |
| `level?: LogLevel`                                    | 显式覆盖环境配置；`LogLevel` 为 `debug` / `info` / `warn` / `error`    |
| `env?: Readonly<Record<string, string \| undefined>>` | 默认 `process.env`；可注入独立环境映射，仅使用 `LOG_LEVEL`             |
| `destination?: LogDestination`                        | 默认 `process.stderr`；自定义目标只需实现 `write(chunk: string): void` |
| `redactValues?: readonly string[]`                    | 已知敏感值的额外脱敏列表；用于无字段标签的文本和错误信息               |

初始化优先级为 `options.level` → `LOG_LEVEL` → `info`。环境值会去除首尾空白并忽略大小写，例如 `LOG_LEVEL=DEBUG`、`LOG_LEVEL=' warn '`。空值或不支持的级别抛出固定配置错误，不把原始环境内容放入异常消息。阈值在创建时确定；修改环境不会改变已创建实例。

```bash
npm run build
LOG_LEVEL=DEBUG node --input-type=module --eval 'import { createLogger } from "./dist/runtime/logging/index.js"; createLogger().debug("Logging ready");'
```

上面的命令通过已构建的模块验证默认初始化。也可以在测试中注入环境和目的地：

```typescript
const lines: string[] = [];
const logger = createLogger({
  module: 'configuration',
  env: { LOG_LEVEL: 'debug' },
  destination: {
    write: (line) => {
      lines.push(line);
    },
  },
});
logger.debug('Configuration checked', { valid: true });
```

自定义目的地的创建、关闭、flush 和文件生命周期由调用方管理，本模块不隐式创建文件或后台 worker。

## JSON 记录与错误

每条记录为一行 JSON，包含 `level`（大写标签）、`time`（ISO 8601 时间）、`module`、`msg`，并将结构化字段合并到顶层。例如：

```json
{
  "level": "INFO",
  "time": "2026-11-21T00:00:00.000Z",
  "module": "runtime",
  "component": "bootstrap",
  "version": "0.0.0",
  "msg": "Application initialized"
}
```

时间由记录写入时生成，示例中的时间不代表真实执行记录。`level` / `time` / `module` / `msg` 是保留字段，调用字段或子 logger 绑定不能覆盖它们。

通过 `logger.error('Operation failed', { err })` 记录异常。原生 Error 的不可枚举 `name`、`message`、`stack` 和 `cause` 会被结构化保留，嵌套错误和自定义字段经过同一脱敏路径；不依赖 Pino 的默认 Error 序列化绕过安全处理。

结构化对象（包括 Error 字段）中值为 `undefined` 的属性省略；数组中的 `undefined` 和空位按 JSON 语义输出为 `null`。例如，没有 HTTP 状态码时不输出 `err.status`，有状态码时保留数字值。

## 子 logger 与上下文

`logger.child('runtime.logging', { component: 'startup' })` 返回共享同一阈值、输出目标和脱敏配置的 logger。子 logger 使用**精确传入**的模块名，继承已有绑定，新绑定和每次调用字段依次覆盖同名普通字段。

绑定创建时复制并脱敏，后续修改调用方的原始绑定不会改变已创建 logger。父 logger 不受子 logger 的绑定影响。当前绑定只是显式结构化字段；没有自动 request/session/trace 上下文或 tracing 协议。

## 脱敏与安全序列化

日志消息、模块名、普通字段、子 logger 绑定和错误信息在进入 Pino 前统一经过 `redact.ts`。敏感字段按名称递归脱敏；文本中可识别的凭据表达和显式 `redactValues` 被替换为 `[REDACTED]`。两类文本规则在原文上识别后合并遮盖范围，避免显式值与字段名、URL 或认证文本重叠时相互干扰。循环引用及不能安全读取的字段以安全占位处理，不修改调用方对象，不执行对象的自定义 `toJSON`。

例如，调用方已经掌握一段无标签的敏感值时，应在初始化时传入：

```typescript
const logger = createLogger({
  module: 'configuration',
  redactValues: ['example-secret-for-redaction'],
});
logger.error('Configuration rejected', {
  apiKey: 'example-secret-for-redaction',
  err: new Error('Credential example-secret-for-redaction was rejected'),
});
```

脱敏能力不能识别所有未标记、未配置的任意秘密。调用方仍应仅记录必要诊断字段，避免记录完整请求、环境或认证配置。具体规则及边界由安全序列化测试约束。

## 文件与验证

- `logger.ts`：供应商无关的公共契约和初始化选项。
- `pino-logger.ts`：Pino 适配、阈值、模块与绑定、JSON 输出。
- `redact.ts`：文本脱敏、安全字段复制和 Error 序列化。
- `index.ts`：公共导出。

离线测试覆盖四级阈值、环境优先级、JSON 格式、stderr、子 logger 隔离、Error/cause 和敏感字段。完整命令为 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm test`；实际执行结果由本次交付和项目验收记录报告，不需要 API Key 或外部服务。

相关说明：[Runtime Model](../model/README.md)、[Runtime](../README.md)、[工程规范](../../../docs/conventions.md)、[Phase 0](../../../docs/phase-0.md)、[本模块时间线](changes.md)。实现依据：[Pino API](https://github.com/pinojs/pino/blob/main/docs/api.md)。
