# CLI — 变更记录

> 当前行为见 [README.md](README.md)。按实际日期记录实质性变化，保留时间线。

## 2026-11-24 — 建立本地 CLI 和独立结果展示

- 主题 ID：`application.local-cli`
- 变更前：Application 只有统一应用服务，没有终端适配或可执行聊天入口。
- 变更后：新增 `easy-agent chat`、帮助/版本、`/new`、`/exit`、Ctrl+C、流式正文和最终结果展示；通过 Composition 获取统一 Service，不直接实例化或调度底层业务组件。提供可注入 IO、信号、配置与 Bootstrap 的 `runCli`，直接导入 bin 不启动应用。
- 修改原因：将 Phase 1.1～1.5 已完成能力接入首个本地用户入口，同时为后续 HTTP 保留共享应用服务边界。
- 关键语义：每轮等待实际 result 后接受下一输入；管道已收到行和 EOF 不丢任务。活动 Ctrl+C 显式取消并等待收尾，空闲时退出，重复信号/正常退出只清理一次，初始化期间退出也等待装配再收尾。观察异常不取消业务；模型原始增量不重复打印，工具往返按模型 message_start 划分预览，最终输出一致时不重印、缺后缀时补足、不一致时明确替换预览。
- 影响范围：本 CLI 子模块、可执行入口、CLI 离线测试和 Application 模块说明；不修改 Phase 1.1～1.5 公共契约、队列、Loop 策略或 Engine 控制语义，不实现 HTTP 或持久化。
- 验证：`node --test tests/cli.test.ts` 12 项通过，类型检查、定向 Lint 和格式检查通过；完整工程结果由 [Phase 1.6](../../../docs/phase-1.6.md) 实际验收记录维护。
- 关联：[Application](../README.md)、[Composition](../../composition/README.md)、[项目记录](../../../docs/changes.md)。
