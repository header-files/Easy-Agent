# Execution Engine — 变更记录

> 现行接口和边界见 [README.md](README.md)。按真实日期追加，不把实时内存事件当成持久化事实。

## 2026-11-23 — 建立 Phase 1.4 DefaultExecutionEngine 基线

- 主题 ID：`execution.engine`
- 变更前：Execution 已有 AgentLoop 策略与 Model/Tool 能力集成，没有统一 Execution 生命周期机制。
- 变更后：新增可复用 Engine，驱动任意 Harness AgentLoop，提供惰性单次消费、事件包装、生命周期协议校验、完成/失败/取消映射、内存快照和有界终态 FIFO。
- 修改原因：用户确认 Phase 1.4 方案，机制层需要统一执行生命周期，而不改变既有 Loop 策略或 Model/Tool 接口；按 A 契约、B 主流程、C 控制并发、D 验收顺序落地。
- 清理决策：取消仅先接受请求，Loop.return/finally 或实际 EOF 确认前保持 RUNNING；消费者退出不补终止事件。无 return 或 finalizer 继续 yield 时也要等待真正 EOF，不加隐藏清理 timeout，不声称强制停止底层能力。
- 快照决策：用户明确确认可复制数据图强隔离，函数、闭包、accessor、自定义私有状态、未知 native slots 和 Proxy 作为外部 opaque 能力保留引用并说明限制；不修改 Phase 1.3 unknown 类型或 JSON 化合法数据。已验证字段一次捕获物化，数据图别名/循环及 view/backing buffer 关系保留。
- 实现边界：默认保留终态 1000 条，可配置为 0；只淘汰终态。安全错误不携带原始异常，日志故障不改变清理或结果。1.1–1.3 源码与公共契约不变。
- 影响范围：Engine 子模块、Execution 父模块、Harness Execution 契约使用、离线验证和项目阶段说明。不实现 Session/队列、JSONL、Persistence、Transaction Journal、Event Bus、SSE 或 Phase 1.5。
- 验证：Engine 主流程 8 项、独立控制/并发/背压 11 项、协议边界 5 项、数据图快照 4 项及真实 DefaultAgentLoop 离线链路 3 项共 31 项测试通过；完整工程真实结果见阶段验收记录。
- 关联：[Harness Execution 时间线](../../harness/contracts/execution/changes.md)、[Execution 时间线](../changes.md)、[项目级记录](../../../docs/changes.md)。

## 2026-11-24 — 原生 binary view 快照不执行自定义槽访问器

- 主题 ID：`execution.engine`
- 变更前：typed array、DataView 和 Buffer 快照直接读取实例的 buffer/offset/length 属性，可能触发调用方覆盖的 getter。
- 变更后：通过内建原型 getter 读取原生内部槽，保留数据图复制和自定义属性的既有语义，不执行这些覆盖访问器。
- 修改原因：Phase 1.5 的 Agent/Engine 整链路验证发现该细节与已确认的未知 accessor 隔离边界不符，需要同步最小内部修复。
- 影响范围：Engine 的私有快照辅助函数和整链路回归；Phase 1.1–1.4 公共契约、执行状态及取消机制不变。
- 验证：新增 Agent 与真实 Engine 的 typed array、DataView、Buffer 参数化回归；最终结果见 Phase 1.5 验收记录。
