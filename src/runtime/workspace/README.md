# Runtime Workspace — 工作区注册与访问协调

## 定位

Phase 2.2 进程内 Workspace 管理：注册/创建根目录、Session 引用、重叠路径拒绝、读写锁（写优先）与 `UNSAFE` 显式恢复。不提供 OS 文件锁、跨进程协调或强隔离沙箱。

## 入口

```typescript
import {
  WorkspaceAccessCoordinator,
  WorkspaceManager,
} from './src/runtime/workspace/index.ts';

const coordinator = new WorkspaceAccessCoordinator();
const manager = new WorkspaceManager({ coordinator });
const ws = await manager.register('docs', '/absolute/existing');
manager.bindSession(ws.id, sessionId);
await coordinator.run({
  workspaceId: ws.id,
  access: 'read',
  signal,
  task: async () => {
    /* FileSystem / Terminal handlers */
  },
});
```

## 规则摘要

| 能力       | 行为                                                                          |
| ---------- | ----------------------------------------------------------------------------- |
| `register` | 已存在目录；经 `realpath` 规范到物理根做身份/重叠比较；物理根不得仍是符号链接 |
| `create`   | 路径不得已存在；父目录须真实存在且非链接                                      |
| 重叠       | 同一物理根或父子嵌套拒绝（Windows 上比较忽略大小写）                          |
| 删除       | 仅移除注册；有 Session 引用时拒绝；不删磁盘文件                               |
| 锁         | 读共享；读/写与写/写互斥；写排队时新读不插队                                  |
| `UNSAFE`   | Terminal 清理不确定时标记；阻断后续读写；`recover` 显式恢复                   |

审批等待不得持有本协调器锁；锁只覆盖 Handler 实际访问区间。

## 验证

```bash
node --test tests/workspace.test.ts
```

## 已知限制

- 状态仅进程内有效；重启不保留 `UNSAFE`，也不证明残留进程已消失。
- 锁不阻止编辑器或其他进程访问同一目录。
- 允许通过符号链接路径注册，但身份固定到 `realpath` 物理目录；若解析后仍是链接则拒绝。工具路径组件级链接规则见 PathResolver。
