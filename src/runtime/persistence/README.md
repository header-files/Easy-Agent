# Persistence — Transaction Journal、Event Log 与 Projection

> Runtime 能力域。实现 Phase 2.4 本地文件持久化；不负责 LLM/Tool 副作用重放或 HTTP 事件订阅。

## 职责

- 全局 **Transaction Journal**（唯一提交依据）：`PREPARED` → Operations → `COMMITTED`。
- **Session Write Coordinator**：每 Session FIFO、Sequence 分配、跨 Session 可并发。
- **Session Event Log** / **Workspace Registry**：JSONL 追加，fsync 持久化。
- **Roll Forward**：仅补写已固化的本地 Operations；不执行 LLM/Tool。
- **Projection 重放**：Session / Execution / Message / Workspace；未 COMMITTED 不可见。
- **Workspace Lifecycle Coordinator**：Session 创建与 Workspace 删除引用协调（≠ AccessCoordinator）。
- **PersistenceBridge**：业务侧 fail-closed 提交门槛。

## 不负责

- Snapshot、数据库、多进程共享写。
- Event Replay 重新调用模型或工具。
- 未完成 Execution 的自动恢复 / 重新入队。
- Phase 2.2 文件读写锁（仍由 `WorkspaceAccessCoordinator` 负责）。

## 布局

```text
<dataDir>/
  journal/transactions.jsonl
  sessions/<session-id>/events.jsonl
  workspaces/registry.jsonl
  .write.lock
```

配置：`persistence.dataDir`（Composition；支持前导 `~/`，与 `workspace.path` 相同）。同一 dataDir 仅允许一个写 Runtime。

## 启动顺序

1. 获取写锁 → Roll Forward → 重放 Registry / Event Log → 重建 Projection（**仅此冷启动路径**将未终态 CREATED/STARTED 升为 INTERRUPTED）。
2. Bootstrap **先**幂等写入 `execution/interrupted_detected`，再登记默认 Workspace / 恢复 Session；Runtime 在 `interrupted_detected` 落盘前对冷启动中断集合在每次 refresh 后重放，避免被普通刷新冲回 CREATED/STARTED。
3. 再接受 CLI / Application 新操作。进程内新产生的 CREATED/STARTED **不会**被标为中断。

## 关键提交门槛（摘要）

| 阶段                  | 必须先 COMMITTED                     |
| --------------------- | ------------------------------------ |
| Execution 入队        | `user/message` + `execution/created` |
| LLM 调用              | `llm/request`                        |
| Tool 执行 / 审批生效  | `tool/call`、`approval/resolved`     |
| 下一步 Agent Step     | `tool/result`                        |
| Terminal 启动         | `workspace/terminal_intent`          |
| Workspace 恢复 NORMAL | `workspace/recovered`                |

## 测试

- `tests/persistence-journal.test.ts`：JSONL / Journal / Roll Forward / 锁 / Registry。
- `tests/phase-2.4-persistence.test.ts`：续聊、中断、Message Projection、UNSAFE、引用删除。

## 访问保护

- 数据目录与子目录创建为 `0700`，Journal / Event Log / Registry / 锁文件为 `0600`（owner-only）。
- Event Log 可含对话与工具结果，不得把 `dataDir` 放在共享可写位置；Windows 上 mode 位可能被忽略，需依赖 NTFS ACL。
- 不在 Event Log 中写入 API Key；模型/工具正文按业务需要保留以便恢复。

## 已知限制

- 单写进程；不扫描历史 PID 接管 Shell。
- Application `createSession` / `setSessionModel` / `deleteSession` 为 async；创建与模型切换仅在对应事件 COMMITTED 后对外确认；删除提交 `session/deleted` 后冷启动不再恢复。
- `session/created` 保存模型参数、extensions 与初始 context；`execution/completed` 写入权威 `context` 快照（完整替换 Message Projection）。
- COMMITTED 后 Projection 刷新失败抛出 `durableCommitted`；`commit_uncertain` 不得当作「未发生」回滚。
- Session ID 仅允许安全单段路径字符，事件文件不得逃出 `dataDir/sessions`。
- Journal 追加故障冻结**全部**新事务；单 Session Event Log 故障仅冻结该 Session。
- Projection 刷新串行执行，避免跨 Session 并发提交后旧重放覆盖新视图。
- 冷启动校验 Session→Workspace 引用；PREPARED 内 Operation/record 的 `transactionId` 必须与事务一致，否则 `corrupt_store` 拒绝可写启动。
- Journal `indexJournal`：同事务 `COMMITTED` 不得出现在其 `PREPARED` 之前；拒绝内容冲突或重复的 `COMMITTED` 标记（`corrupt_store` / `conflict`）。
- Session Projection 保留 `initialContext.messages` 与 `initialContext.data`；权威 `execution/completed.context` 另存 `committedContextData`。
- 持久化载荷仅接受 JSON 安全值（`null` / boolean / 有限 number / string / 数组 / 纯对象）；`Date`/`Map`/`Set`/class / `undefined` / 非有限数字在 `stableStringify` 处以 `invalid_record` 拒绝，禁止静默写成 `{}`。
- Windows / Linux 持久化路径未在本阶段做完整原生验收（darwin 本地验证）。
- §13 完整崩溃注入矩阵与真实工具往返/Terminal 清理故障的专项覆盖仍可继续加强。
