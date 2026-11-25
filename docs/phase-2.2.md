# Easy Agent — Phase 2.2：内置工具、Workspace 与本地受控执行

> 日期：2026-11-25  
> 前置条件：用户确认 Phase 2.1 已完成。本文未独立核验当前 Git 仓库，实际类名、公共类型、文件路径、测试命令与接口签名均以现有代码为准。

## 1. 阶段目标与设计原则

Phase 2.2 在现有 **Agent Loop、ToolRegistry、ToolExecutor、Session / Execution、CLI 与 Composition** 的基础上实现以下最小可用场景：

1. **办公文件任务**：浏览工作区、读取文档、创建报告并根据反馈修改内容。
2. **Vibe Coding 任务**：读取项目、修改代码、执行构建或测试、解析命令结果并继续修复。
3. **受控工具执行**：写文件及 Terminal 操作受人工审批、取消、超时与 Workspace 访问协调约束。

坚持：**Harness 定义协作契约；Runtime 实现执行能力与资源治理；Agent / Session 选择和绑定能力；Agent Loop 只通过统一 Tool 契约工作；Composition / Bootstrap 负责装配。**

不为本阶段重建 Agent Loop、Execution 状态机、Tool Runtime 或 Session 调度；不提前开发后续阶段的事件持久化、跨进程恢复和高级控制能力。

**跨平台交付目标**：Phase 2.2 的核心 Runtime、FileSystem、Workspace、Approval 与 Terminal 工具应在 **Windows、macOS、Linux** 原生环境下工作。跨平台指工具**接口、生命周期与结果契约统一**，不代表 `ls`、`rm`、`grep` 等 Shell 命令在各系统具备相同语义；用户/模型提交的命令必须适配当前选定的 Shell。不得将 WSL、Git Bash、Docker 作为 Windows 基本可用性的前置条件，也不把“Node.js 能启动进程”当作“进程清理已通过跨平台验证”。

## 2. 十二项已确认设计决策（强制基线）

| 编号 | 事项                           | 已确认方案                                                                                                                                                    |
| ---- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Sandbox                        | **本地受控执行**；FileSystem 受 Workspace 范围限制；Terminal 依靠审批、超时、取消与进程管理；不引入 Docker / OS 级沙箱，绝不声称 Shell 被文件系统隔离         |
| 2    | FileSystem Tool                | **按操作注册独立工具**：浏览目录、读文件、创建/写文件、局部编辑、创建目录；本阶段不要求删除/移动/批量重命名                                                   |
| 3    | Terminal                       | 使用 **Shell 命令字符串**；由独立 `TerminalExecutor` 管理本地子进程、超时、输出和清理；不得将 Shell 实现写死在 Tool Handler                                   |
| 4    | Tool Permission                | **不新增独立 Tool Permission 系统**；Agent / Session 从已注册工具中选择可用工具，Execution 使用选定工具集合；未知工具只作正常工具查找失败处理                 |
| 5    | Approval 交互与 Execution 状态 | Runtime `ApprovalService` 管理审批；CLI 经事件与 Application Service 接收/提交决策；审批等待期间 Execution **保持 `RUNNING`**，不新增 `WAITING_APPROVAL` 状态 |
| 6    | Approval Policy                | 工具级审批仅实现 **`always` / `never`**；`sensitive` 留待有明确需求时再讨论；未配置策略须保守处理（建议默认 `always`），不得静默放行                          |
| 7    | Workspace 创建                 | `WorkspaceManager` 同时支持**注册已有目录**和**创建新目录**；Workspace 独立于 Session；删除注册记录不自动删除磁盘文件                                         |
| 8    | Workspace 并发                 | Tool Runtime 根据工具注册元数据统一申请 Workspace **操作粒度、写优先读写锁**；Terminal 默认作为 `write`；审批期间不持锁                                       |
| 9    | 路径安全                       | FileSystem 工具**禁止通过符号链接访问**；检查 `..`、绝对路径越界、目录组件、符号链接以及校验-打开竞态；不夸大为强隔离                                         |
| 10   | Approval 超时                  | 支持**独立、可配置审批等待超时**；到期后审批失效且工具不得执行；审批等待时间不计入实际工具运行超时                                                            |
| 11   | Terminal 取消与清理            | 超时/取消后终止受管理 Shell 及其子进程，确认清理后释放 Workspace 保护；**无法确认清理结果时，在解锁前置 Workspace 为 `UNSAFE`**                               |
| 12   | UNSAFE 后续处理                | **新的 Workspace 工具操作立即返回 `WORKSPACE_UNSAFE`**，包括读写；用户检查环境后通过 Application Service 显式恢复，不自动等待或自动重试                       |

其他已确认约束：**同一 Session 的 Execution 串行，不同 Session 可以并发；同 Workspace 允许并发读，读写与写写互斥；Session 创建时绑定 Workspace，已创建 Session 不切换 Workspace；仍被 Session 引用的 Workspace 禁止删除**。

**跨平台补充（不改变以上十二项决策）**：TerminalExecutor 负责屏蔽 Shell 启动、输出解码和进程树清理的 Windows/POSIX 差异；WorkspacePathResolver 负责屏蔽路径格式与文件系统边界差异；所有受支持系统均需对应原生验证。

## 3. 总体架构与模块职责

```text
CLI ─────────────────────────────────────┐
  │ 展示工具/审批事件、读取用户决策          │
  ▼                                      │
AgentApplicationService <───────────────┘
  │  Session 创建、工具选择、Workspace 绑定、审批决策入口
  ▼
SessionAgent → ExecutionEngine → AgentLoop
                                   │  Tool 契约
                                   ▼
                            Tool Runtime
                             ├─ 已选工具集合解析（不存在则普通 ToolNotFound）
                             ├─ 参数解析 + Schema 校验
                             ├─ ApprovalPolicy → ApprovalService
                             ├─ WorkspaceAccessCoordinator（读写锁、UNSAFE）
                             └─ Tool Handler
                                  ├─ FileSystem Tools → WorkspacePathResolver → FS
                                  └─ Terminal Tool → TerminalExecutor → Shell / 子进程

WorkspaceManager：注册、创建、获取、列表、删除及 Session 引用关系
Composition：启动时注册内置工具、审批服务、Workspace 服务及 CLI 事件桥接
```

### 3.1 职责表

| 组件                         | 职责                                                                      | 不负责                                     |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------ |
| ToolRegistry / ToolSelection | 注册全局工具、允许 Agent / Session 选择已注册工具；Execution 使用选定集合 | 人工审批和额外的 Permission ACL            |
| ToolExecutor / 执行包装层    | 统一参数校验、审批、锁、取消和结果处理；尽量复用 Phase 1 既有调度         | 具体文件读写和进程管理                     |
| ApprovalPolicy               | 根据工具注册配置返回 `always` / `never`                                   | 解析 Shell 是否“安全”、判断 Agent 身份权限 |
| ApprovalService              | 管理单次审批请求、状态、超时、取消、决策、事件                            | 终端输入输出                               |
| WorkspaceManager             | Workspace 的注册、创建、查询、删除与 Session 关联                         | 实际文件访问与执行锁                       |
| WorkspaceAccessCoordinator   | 每 Workspace 的读写锁、写优先队列、排队取消、UNSAFE 检查与恢复阻断        | 操作系统文件锁或进程隔离                   |
| WorkspacePathResolver        | 将文件工具路径约束在 Workspace 根目录内，拒绝符号链接/越界路径            | 约束 Shell 进程可访问的所有路径            |
| FileSystem Handlers          | 目录列表、文件读取/创建/编辑、大小控制、原子写入（适用时）                | 审批策略与跨工具锁编排                     |
| TerminalExecutor             | Shell 启动、平台差异适配、进程组/进程树清理、退出码、输出截断、超时与取消 | 审批 UI、Workspace 授权                    |
| CLI / Application Service    | 展示审批事件、接收决策与 Workspace 恢复确认                               | 直接调用 Tool Handler 绕过 Runtime         |

工具注册元数据建议包含 `workspaceAccess: "none" | "read" | "write"` 与 `approval: "always" | "never"`，优先采用 **Runtime 注册信息**，不强行改动 Harness 中已有的 `ToolSpec`。元数据不完整的工具不能被默认为低风险自动执行。

## 4. Workspace 生命周期与绑定

### 4.1 Workspace 模型（示意）

```typescript
interface Workspace {
  id: string;
  name: string;
  rootPath: string; // 注册时规范化的实际目录位置
}
```

- 支持 `register(existingDirectory)` 与 `create(newDirectory)`；注册已有目录时必须校验实际目录存在，创建新目录不得清空/覆盖既有内容。
- 为一个实际物理根目录维护唯一的锁协调身份；Phase 2.2 可**拒绝重复或重叠 Workspace 根路径**，避免分别加锁导致同一文件并发写入。
- 支持默认 Workspace，Session 在创建时使用显式 `workspaceId` 或项目默认 Workspace；不存在的 ID 拒绝创建 Session。
- 已创建的 Session 不切换 Workspace；多个 Session 可引用同一 Workspace；有引用时拒绝移除 Workspace。
- `remove` 仅移除注册数据，不删除用户目录及文件。
- Phase 2.2 暂以进程内元数据实现；后续持久化阶段再实现重启加载。不要假定本阶段可以跨重启保持 Workspace 状态。
- Windows 的驱动器盘符、UNC 路径（例如 `\\server\share`）、大小写不敏感目录、长路径以及 Junction 等需要在注册/重叠判断中正确处理；禁止用原始路径字符串比较判断两个 Workspace 是否相同或嵌套。无法可靠识别同一物理目录时应保守拒绝注册或明确报错，不得建立两个互不协调的锁域。

### 4.2 并发规则

- 同 Session Execution 仍保持 Phase 1 FIFO 串行；不同 Session Execution 可以同时运行。
- 同 Workspace 读/读并行；读/写与写/写互斥；不同 Workspace 可并发操作。
- **写优先**：当写入等待者已经入队，新的读请求不持续插队导致写入饥饿；仍要保证取消后的队列维护正确。
- **操作粒度锁**：只覆盖 Handler 实际访问 Workspace 的区间，不覆盖模型生成、Approval 等待或整个 Execution 生命周期。
- Terminal 默认 `write`，包括看似只读的测试/构建脚本；避免依靠 Shell 文本字符串判断是否写入。
- Tool Runtime 统一协调锁。获取锁之前完成所需审批，等待锁时可取消；获得锁后、实际执行前再次检查取消状态及 Workspace `UNSAFE`。
- Workspace 读写锁仅协调**经过本进程同一协调器的工具**，不阻止用户的编辑器、其他 Agent 进程或系统进程访问文件。

### 4.3 UNSAFE 状态与人工恢复

```text
NORMAL ── Terminal 清理无法确认 ──► UNSAFE
UNSAFE ── 用户确认已检查并显式恢复 ──► NORMAL
```

- `UNSAFE` 由 WorkspaceAccessCoordinator 管理，表示**已检测到的进程清理结果不确定**，不是全局安全证明。
- Terminal 清理失败时，在持有写锁且**释放前**原子标记 `UNSAFE`；后续新申请和已排队等待授权的 Workspace 工具操作都不得越过阻断，应返回明确错误，而不是无限挂起。
- `UNSAFE` 阻断**读与写**；工具不得自动重试或自行恢复。
- Application Service 暴露查询状态和显式确认恢复入口，CLI 提供对应交互（例如 `/workspace status`、`/workspace recover`，具体命令按 CLI 现有语法确定）。恢复需向用户展示残留进程风险并要求明确确认，**不是自动终止残留进程或自动判定环境安全**。
- 已提交但无需 Workspace 的普通模型对话可继续；涉及该 Workspace 的工具调用按上述规则返回错误。
- `UNSAFE` 当前仅进程内有效；重启会丢失此状态，但**绝不可宣称重启自动清除了可能残留的进程**。在文档和错误信息中说明这项限制，跨重启保障留待后续阶段。

## 5. FileSystem 工具设计

### 5.1 内置工具清单

| 工具（建议名，具体以仓库命名习惯为准） | 作用                                 | Workspace 访问 | 默认审批 |
| -------------------------------------- | ------------------------------------ | -------------- | -------- |
| `list_directory`                       | 浏览目录、限制条目与深度             | `read`         | `never`  |
| `read_file`                            | 读取文本文件、限制体积和模型返回内容 | `read`         | `never`  |
| `create_directory`                     | 创建目录                             | `write`        | `always` |
| `write_file`                           | 创建新文件 / 按显式参数覆盖已有文件  | `write`        | `always` |
| `edit_file`                            | 精确文本局部替换，避免整文件重写     | `write`        | `always` |
| `terminal`                             | 执行 Shell 命令                      | `write`        | `always` |

建议本阶段**不引入**删除文件、移动文件、目录递归清理、批量重命名等高破坏性工具；未来确有需求再讨论提前开发与风险策略。

### 5.2 路径规则

- Tool 参数允许相对于 Workspace 的路径或指向 Workspace 内部的绝对路径；规范化后必须实际处于 Workspace 根目录或其子目录，不能仅用字符串 `startsWith()` 判定。
- 路径内 `.`、`..` 规范化后仍在 Workspace 内可以接受；越界路径必须拒绝。
- **路径中任何需要通过符号链接到达目标的部分都拒绝访问**，无论最终指向内部还是外部。Workspace 根路径注册时明确规范化并固定物理根目录，后续工具路径遵守无符号链接规则。
- 对新文件（尚不存在）必须校验所有存在的父路径组件与最终位置；对目录列表/读取/编辑/覆盖需要验证目标类型和符号链接情况。
- 检查必须尽可能贴近最终 `open` / 文件系统操作，必要时采用不跟随符号链接的文件打开机制；**`realpath()` 预检查本身不足以消除并发替换导致的 TOCTOU 竞态**。实现上应给出可验证的防护及剩余风险，不能把该设计描述为 OS 级隔离。
- 文件工具执行时仍要受 Workspace 锁保护。`write_file` 默认不得无提示覆盖已有文件；可通过显式 overwrite 参数表达覆盖意图，并展示在 Approval 中。
- `edit_file` 要求精确匹配；原文不存在或出现多个不明确匹配时返回失败，不猜测修改范围；尽可能保证失败不破坏原文件。
- 读取、列表、写入都应有合理大小/数量限制，并返回截断或限制错误，不让大文件或大量目录项无限占用内存及上下文。
- **跨平台路径要求**：使用 Node.js 的 `path` / `fs` 平台感知 API 解析与校验路径；Windows 需覆盖不同盘符、UNC、根路径/兄弟目录、大小写差异、路径分隔符、尾随点/空格及设备保留名等边界。不要用仅适用于 POSIX 的绝对路径或前缀规则。对可疑 Windows 特殊路径（如 Alternate Data Streams 形式）必须有明确的拒绝/校验策略。
- **链接规则跨平台一致**：POSIX 符号链接与 Windows 符号链接、Junction/可识别的重解析点都不得作为 FileSystem Tool 的中间路径或最终访问目标。使用 `lstat` 等手段逐组件检查，结合最终文件打开方式尽量缩小检查-使用竞态；如果当前平台不能可靠证明路径未通过链接，应拒绝操作并报告限制，不得把“允许访问”作为降级方案。此规则不约束已批准的 Shell 进程。

## 6. Terminal Tool 与 TerminalExecutor

### 6.1 命令契约与执行

Terminal Tool 输入为 Shell 命令字符串，例如（仅用于说明）：

```typescript
terminal({ command: 'npm install && npm test', timeoutMs: 120000 });
```

- 在 Workspace 根目录启动 Shell；如果允许 `cwd` 参数，必须先经过 Workspace 内路径解析并满足相同安全边界，默认以根目录执行即可。
- `spawn` 可用于**启动 Shell**，无需限制为 `executable + args` 模式。Shell 种类与 Windows/macOS/Linux 差异由 TerminalExecutor 或其平台适配处理。
- Terminal 的 `cwd` 限制**不能阻止命令访问 Workspace 外部的文件和网络**；这是一项必须在文档与 CLI 审批信息中明确标注的安全限制。
- 使用退出码、标准输出、标准错误及超时/取消/启动失败等结构化结果。非零 Exit Code（例如测试失败）作为实际命令执行结果反馈给 Agent，不一律视为 Runtime 异常。
- stdout/stderr 分别设置有界缓冲与最终返回限制；发生截断仍持续消费进程输出，防止管道阻塞。不要在日志中泄露敏感环境变量或密钥。
- 执行命令应取得 Workspace `write` 锁，并一直保护到命令退出或终止流程完成/处理不确定状态。

### 6.2 超时、取消和清理

```text
请求启动 → STARTING → RUNNING ── 正常退出 ──► FINISHED
                      │
                      └─ 超时 / 取消 ─► STOPPING
                                           ├─ 进程/进程组清理确认 → FINISHED
                                           └─ 清理不确定 → 标记 Workspace UNSAFE → 返回明确错误
```

- 优先尝试正常终止受管理进程，宽限期后升级强制终止；支持平台适配的进程组/进程树清理。
- **取消的是实际进程，不只是 Promise/AbortSignal 的等待**。ToolExecutor 已有超时包装不得通过提前 `Promise.race` 返回而导致写锁先释放、子进程仍在运行。
- 进程正常结束或确认清理完成后，才能普通释放 Workspace 锁。清理无法确认时先置 `UNSAFE`，再解除协调锁并返回 `CLEANUP_UNCERTAIN` 等明确错误。
- 本地子进程可能自行创建脱离进程组的后台任务，**无法保证 100% 发现或终止**；仅对已经检测到的不确定性执行 `UNSAFE` 阻断。测试、错误提示和文档应承认该边界。
- 检查工具启动前、锁获取后、执行前的取消信号，防止在等待审批或锁期间已取消的命令后来启动。

### 6.3 Windows / macOS / Linux 适配要求（Phase 2.2 必交付）

**目标**：Terminal Tool 对模型保持统一 `command`（Shell 命令字符串）与 `timeoutMs` 等输入，以及退出码、stdout、stderr、取消、超时、清理状态等结构化输出；平台细节仅存在于 `TerminalExecutor` 内部或其轻量平台适配函数，**不扩散到 Agent Loop、ToolSpec 或 ModelClient**。

| 平台    | 默认 Shell（可配置）                                                      | 基本执行要求                                                                                 | 清理实现方向                                                                                    |
| ------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| macOS   | `/bin/sh`                                                                 | 使用 POSIX Shell 语法执行命令字符串                                                          | POSIX 进程组/信号与退出确认                                                                     |
| Linux   | `/bin/sh`                                                                 | 同上，不假设一定安装 `bash`                                                                  | POSIX 进程组/信号与退出确认                                                                     |
| Windows | 系统 `ComSpec` 指向的 `cmd.exe`（无效时显式报错或采用经验证的系统默认值） | 支持 `cmd.exe` 语法及常见 `.cmd` / `.bat` 程序（例如 npm），正确处理路径空格、引号和工作目录 | 采用 Windows 适用的进程树终止策略（如受控调用 `taskkill /T /F` 或等效方案），验证退出及清理结果 |

- 使用 Node.js `child_process.spawn()` 启动配置的 Shell；`spawn()` 与 Shell 命令字符串不是互斥方案。选择与传参必须符合平台语义，不能在 Windows 上照搬 `/bin/sh -c`，也不能在 POSIX 上照搬 `cmd.exe /d /s /c`。除经过验证的本机默认 Shell 外，可选的 PowerShell/Bash 为**显式配置扩展**，不是本阶段 Windows 必装依赖。
- 默认 Shell 在 **应用配置/TerminalExecutor 初始化时**确定，不允许模型通过本次 ToolCall 直接指定任意 Shell 可执行路径以绕过审批。Approval 展示实际 Shell、原始命令、Workspace/cwd；审批后执行的命令与目录必须和展示内容一致。
- 不提供 Shell 命令的跨平台自动翻译。例如 `ls -la` 不应被偷偷改成 `dir`；`&&`、管道、重定向及转义遵循当前 Shell 本身的语法。CLI/系统提示需要告知模型所使用的 OS、Shell 类型，避免在 Windows 原生 `cmd.exe` 下生成仅适用于 Unix 的命令。
- 对 Windows `.cmd`、`.bat` 和包含空格的安装路径（如 `C:\Program Files\...`）进行原生测试；不能把仅在 macOS/Linux 运行通过的命令示例作为 Windows 验收依据。
- 不直接假定 Unix `SIGTERM`、负 PID 或 `process.kill(-pid)` 在 Windows 上可用。POSIX 与 Windows 应分别实现进程树终止和清理确认；优先正常终止，在无法温和终止时依配置执行强制清理。Windows 的 `taskkill` 等机制也不能保证发现所有主动脱离进程树的后台进程，因此仍要如实暴露清理不确定状态，触发 Workspace `UNSAFE`。
- 避免仅凭 Shell 主进程的退出就认定全部后代退出。必须尽可能收集受管理进程的退出/关闭证据；已检测到清理无法确认时，**先标记 `UNSAFE`，再释放 Workspace 锁**。不得因平台不支持某种清理方式就静默视为成功。
- stdout/stderr 按字节流有界收集并执行明确的字符解码策略。优先采用 UTF-8；考虑 Windows 程序可能使用不同代码页，需要明确可配置/可检测的解码策略和失败时的替代显示，不能因为多字节输出被拆包而产生乱码或内存无界增长。
- 路径分隔符、换行符、文本编码、环境变量语法及路径大小写差异由平台实现或文档处理；既有 `ToolResult` 字段保持一致。`cwd` 必须由 Workspace 路径校验后确定，而 Shell 本身仍不具备超出 Workspace 的文件访问隔离。

### 6.4 跨平台支持声明与降级规则

- **Windows、macOS、Linux 都是 Phase 2.2 的目标支持平台**；至少验证各自的本地原生 CLI 流程，不以 WSL 或容器代替 Windows 验收。
- 对进程树清理、Junction/重解析点、路径大小写边界等平台相关安全行为，模拟测试只能补充，不能代替真实平台集成测试。
- 若某平台或某项安全关键能力无法达到同等约束，开发结果必须明确列出限制与未通过用例；**不能把未验证的平台标记为已支持**。安全前提无法满足时，应在能力初始化或执行前明确报错，而非放松 Workspace 或取消/清理规则。

## 7. Tool Approval 完整方案

### 7.1 工具选择不等于单独 Permission 系统

- 工具注册后由 Agent / Session 选择。Execution 在提交时使用已确定的工具集合，模型只获取该集合中的工具定义。
- 执行链通过当前 Execution 的选中工具集合**解析工具调用**；不存在则返回普通 `ToolNotFound` 错误，不引入额外 Tool Permission/ACL 检查或重复授权层。
- 不声称模型不会发出未知工具名称；普通工具查找失败仍需健壮处理，且不得自动回落到全局 Registry 执行未选工具。

### 7.2 Approval Policy

- 工具注册时关联 `approval: "always" | "never"`。只读 FileSystem 默认 `never`；文件写入和 Terminal 默认 `always`。
- 未配置 Approval 的操作必须采用保守策略（建议默认 `always`），未接入审批入口时**拒绝或明确失败，不得自动批准**。
- `sensitive` 动态风险判断当前不实现；不通过 Shell 命令包含某些关键字来推断“安全”。
- 审批只表示允许**本次具体操作**继续，不代表工具执行成功。审批仍不绕过文件路径校验、大小限制和 Workspace `UNSAFE`。

### 7.3 审批状态和绑定内容（示意）

```typescript
interface ApprovalRequest {
  id: string;
  executionId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>; // 用于展示和验证，必要时脱敏
  argumentsHash: string; // 对规范化实际参数的摘要
  workspaceId?: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';
}
```

- 实际结构按项目现有 Execution / ToolCall / Event 契约适配，**不强制重建状态模型**。
- 审批应绑定具体工具名、规范化执行参数、Workspace / cwd、Execution 和 ToolCall 标识；用户批准后不能替换参数或工作目录。
- 保留必要的审阅信息，避免把敏感参数、密钥或环境变量原样打印到 CLI/日志中。
- `PENDING → APPROVED / REJECTED / CANCELLED / EXPIRED` 为一次性终态，重复决策、取消之后迟到的批准都不得重新触发执行。处理决策与取消之间的竞态需原子化。

### 7.4 审批与 Execution / CLI

```text
Tool Call
  ↓ 参数解析 + Schema 校验
Approval Policy
  ├─ never ──────────────────────────────────────────────┐
  └─ always → ApprovalService 请求，发 approval/requested │
                       │                                 │
               CLI 展示审批内容                          │
                       │                                 │
          用户通过 Application Service 提交决策          │
                       │                                 │
              APPROVED ──────────────────────────────────┤
              REJECTED / CANCELLED / EXPIRED → 拒绝/终止  │
                                                         ▼
                                             Workspace 锁 → Handler
```

- 审批时 Execution 继续表示 `RUNNING`，Tool Call 以异步 Promise 等待，无新 Execution 状态。
- 审批等待期间不占 Workspace 锁、不启动命令、不写入文件。CLI **不由 Runtime 直接读取终端输入**。
- `ApprovalService` 对 Application Service 暴露审批列表/决策入口，使用现有事件词汇或最小新增审批事件通知 CLI；事件机制与未来 HTTP 接入可复用。
- **Approval Timeout 与 Tool 执行超时分离**：独立配置审批最长等待；超时变 `EXPIRED`，不得执行工具。锁排队等待和 Terminal 真正运行的时间也分别处理；Execution 全程取消信号始终有效。
- 取消等待审批时，立即取消/终止 Approval，后续批准不得生效；批准后到启动前仍要重新检查取消。
- 没有可用审批交互通道则故障关闭（拒绝/明确错误），不能默认批准。
- Phase 2.2 使用进程内审批；进程退出后不恢复旧审批，持久化留待后续阶段。

## 8. Tool Runtime 统一执行流水线

推荐以下**逻辑顺序**，只要满足契约可依仓库现有代码做最小重构：

1. 从 Execution 当前选中工具集合解析工具；不存在时返回普通工具不存在错误。
2. 完成已有 ToolExecutor 的 ToolCall 解析、非截断检查、JSON Object / Schema 校验；校验失败不能进入审批与 Handler。
3. 通过工具注册元数据查询 `approval`；`always` 时创建并等待 ApprovalService。等待期间无锁，审批超时/拒绝/取消时不执行。
4. 检查 Execution 取消；根据 `workspaceAccess` 申请 Workspace 锁；等待支持取消，获取时再次检查 `UNSAFE`。
5. 锁内根据 Tool 参数进行必要路径/工作目录复核；FileSystem 禁止符号链接，Terminal 按约定的 Workspace 目录启动。
6. 调用 Handler；Terminal 必须等待进程终止/清理流程完成才能宣告 Handler 结束。
7. 退出锁保护区；若清理不确定，先在同一 Workspace 协调边界内标记 `UNSAFE`，再释放锁；返回结构化 ToolResult。

伪代码（不作为精确签名）：

```typescript
const registration = executionTools.resolve(call.name); // 未找到正常返回 ToolNotFound
const args = parseAndValidate(registration.spec, call.arguments);

await approvalService.requireIfNeeded({
  approval: registration.approval,
  toolCall: call,
  args,
  executionId: context.executionId,
  workspaceId: context.workspaceId,
  signal: context.signal,
});

assertNotCancelled(context.signal);

return workspaceCoordinator.run({
  workspaceId: context.workspaceId,
  access: registration.workspaceAccess,
  signal: context.signal,
  task: async () => {
    assertNotCancelled(context.signal);
    return registration.handler.execute(args, context);
  },
});
```

**关键实现约束：** 普通 `run()` 的 `finally` 释放锁不能掩盖 Terminal “已超时但进程未清理”的情况；必须由 TerminalExecutor/包装层在返回之前完成终止确认或 `UNSAFE` 标记。若仓库既有 `ToolExecutor` 的超时是整个调用范围的一次性计时器，必须先适配分阶段超时语义，避免审批时间被算入命令运行时间。

## 9. Composition 与 CLI 集成

- Bootstrap 注册内置 FileSystem/Terminal 工具及其 Approval、Workspace 访问元数据；不复制 Phase 1 的 ToolRegistry / ToolExecutor。
- 将 WorkspaceManager、WorkspaceAccessCoordinator、ApprovalService 通过已有应用装配方式注入执行链；是否新建类/文件以现有模块结构的最小清晰边界为准。
- CLI 支持 Session 创建时选择 Workspace（或默认 Workspace）及所需已注册工具；不引入额外 Tool Permission 配置。
- CLI 接收 `approval/requested` 等审批事件，向用户展示 Tool 名称、受影响 Workspace、执行命令或文件改动摘要，提供批准/拒绝并通过 Application Service 提交结果。
- Application Service 需要暴露 Workspace 状态查询和人工确认恢复能力；CLI 增加对应最小交互（命令形式按现有 CLI 命令路由规则实现）。
- CLI 的用户输入管理不能和 Approval 等待互相死锁；Execution 取消时等待 Approval、Workspace 锁、Terminal 进程的相应取消机制都应生效。
- CLI / Agent 上下文应展示当前宿主系统与 Terminal 所选 Shell；不得在 Windows 原生 Shell 下默认引导模型使用仅适用于 POSIX 的命令。路径展示和输入需兼容带空格目录、Windows 盘符与 UNC 路径。
- HTTP/API 不在 Phase 2.2 实现，但新服务接口应可供后续 HTTP 直接复用。

## 10. 实施任务与交付顺序

| 任务                              | 内容                                                                                                                                                                                    | 完成条件                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **2.2.0 基线检查**                | 阅读 `AGENTS.md`、架构文档、Phase 1 / 2.1 模块 README / changes；核对 ToolExecutor 超时取消机制、Session 配置、CLI 事件分发、Composition 装配及测试框架；确认目标平台及 CI/原生测试环境 | 输出真实接口/模块影响清单，标明与本文伪接口差异；列出 Windows/macOS/Linux 平台风险和验证手段；不未经核对重写公共契约 |
| **2.2.1 Workspace 基础**          | WorkspaceManager、注册已有目录、创建新目录、默认 Workspace、Session 绑定、引用检查、重叠路径校验、访问协调器读写锁及 UNSAFE 状态                                                        | 可以绑定两个 Session 共享 Workspace，验证读/写互斥、写优先、取消及显式恢复                                           |
| **2.2.2 Tool Runtime 统一前置链** | 复用工具注册及选择机制；增加工具级 Approval / WorkspaceAccess 元数据，ApprovalService 最小实现、审批事件、阶段化超时与取消                                                              | 审批通过/拒绝/超时/取消均正确；审批等待不持锁；未选择工具只能普通解析失败；不新增 Permission ACL                     |
| **2.2.3 FileSystem Tools**        | 目录列表、文本读取、新建/覆盖文件、精确编辑、创建目录；WorkspacePathResolver、大小限制、符号链接及越界拒绝；补齐 Windows 驱动器、UNC、大小写与 Junction 规则                            | 正常读写可用；路径穿越/链接与 Junction/重复编辑命中/覆盖语义都有跨平台测试                                           |
| **2.2.4 Terminal Tool**           | Shell Executor、cwd、stdout/stderr、exit code、超时、取消、进程组/进程树清理；Windows `cmd.exe`、`.cmd`/`.bat`、输出编码与 Windows 清理分支；无法确认清理时 UNSAFE                      | 三平台原生 Shell 命令可执行；非零返回码可分析；取消/超时不会在清理前错误释放锁；UNSAFE 阻断后续工具                  |
| **2.2.5 CLI 闭环**                | Workspace 选择、工具选择、审批事件展示/决策、Workspace 状态/显式恢复交互                                                                                                                | 用户可从 CLI 完整完成读文档写报告、修改代码运行测试与审批拒绝流程                                                    |
| **2.2.6 回归验收与文档**          | 单测、集成测试、Windows/macOS/Linux 原生 CLI 端到端、Phase 1/2.1 回归；README / changes / 项目阶段文档更新                                                                              | 三平台测试结果逐项可追溯；未测或失败不得宣称支持；明确记录实现边界和遗留风险                                         |

以上顺序允许 Coding Agent 在不改变架构边界的前提下调整细粒度提交；每个任务完成后独立测试、记录变更，不要求一次性大规模重写。

## 11. 验收标准与建议测试矩阵

### 11.1 端到端验收

1. **办公场景**：创建 Session 并绑定 Workspace，选择 `list_directory`/`read_file`/`write_file`；读取本地 Markdown 文件，发起创建报告审批，批准后实际落盘并验证内容；拒绝后文件不应创建。
2. **Coding 场景**：读取项目、定位代码、通过 `edit_file` 修改、审批执行 `terminal("npm test")` 等命令；Agent 获取 stdout、stderr、退出码，测试失败时继续修复并再次验证。
3. **模型与工具整合**：Phase 2.1 的任一已注册模型走现有 Tool Calling → Tool Runtime 链路；不因新增审批或 Workspace 改动破坏流式工具调用和会话历史。
4. **不同 Session**：同 Session 保持 FIFO，不同 Session 可并发；共享 Workspace 的读/写锁正确，不同 Workspace 不互相阻塞。

### 11.2 必测边界

| 类别               | 测试场景与预期                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 工具选择           | Session 仅选择部分工具；模型未选工具调用返回普通找不到工具错误，不落到全局 Handler                                          |
| 参数校验           | 非法 JSON、非对象参数、Schema 错误、截断工具参数均不能进入审批或执行                                                        |
| Approval           | `always` 审批通过/拒绝、重复批准、迟到批准、无交互通道、独立审批超时、Execution 取消时审批待决均正确                        |
| Approval 与锁      | 审批等待不持 Workspace 锁；批准后、锁排队时取消不执行；批准后与实际启动之间的取消不执行                                     |
| FileSystem 路径    | 相对与合法绝对路径、`..` 越界、兄弟目录假前缀、文件/父目录符号链接、内部符号链接、尚不存在的文件、错误文件类型              |
| FileSystem 写入    | 默认不覆盖、显式覆盖审批；精确编辑无命中/多命中失败且原文件保持一致；大文件/大目录受限                                      |
| Workspace 生命周期 | 现有目录注册、创建新目录、重复/嵌套目录拒绝、Session 引用时删除拒绝、删除 Workspace 不删除真实目录                          |
| Workspace 并发     | 读/读并发，写互斥，写优先，锁队列取消，外部进程不受锁保障这一限制写入文档                                                   |
| Terminal           | Shell 复合命令、工作目录、正常/非零退出、stdout/stderr 截断、启动失败、超时、Execution 取消、子进程树清理                   |
| UNSAFE             | 故障注入模拟清理无法确认；**先标记 UNSAFE 后解锁**；排队与新读写立即失败；人工确认恢复后再允许访问；不能自动清除            |
| 回归               | Phase 1 Tool Calling、取消、Session 串行与跨 Session 并发；Phase 2.1 多模型、Responses Provider、流式输出等原有能力继续有效 |

### 11.3 跨平台验收矩阵（必须覆盖）

| 验收能力                                         | macOS（原生）       | Linux（原生）       | Windows（原生）                   |
| ------------------------------------------------ | ------------------- | ------------------- | --------------------------------- |
| Workspace 注册/创建/默认绑定、重复及嵌套路径判定 | 必测                | 必测                | 必测：盘符、UNC、大小写           |
| FileSystem 读写编辑、路径越界与无链接访问        | 必测：符号链接      | 必测：符号链接      | 必测：符号链接、Junction/重解析点 |
| Terminal 基本命令与复合命令                      | `/bin/sh` 语法      | `/bin/sh` 语法      | `cmd.exe` 语法与 `.cmd`/`.bat`    |
| 包含空格的 cwd、stdout/stderr、非零退出码和截断  | 必测                | 必测                | 必测：路径与输出编码              |
| Terminal 超时、取消与子进程树清理                | 必测：受管理进程组  | 必测：受管理进程组  | 必测：Windows 进程树机制          |
| 清理不确定 → UNSAFE → 阻断 → 人工恢复            | 故障注入 + 集成测试 | 故障注入 + 集成测试 | 故障注入 + 集成测试               |
| Approval 与 Workspace 锁、Phase 1/2.1 回归       | 必测                | 必测                | 必测                              |

- 测试命令应在不同平台分别选择原生 Shell 等价场景，**不强制同一条 POSIX 命令在 Windows `cmd.exe` 中运行**。
- 推荐使用 CI 的 Windows、macOS、Linux 原生 Runner 执行自动化测试；涉及实际进程树终止、符号链接/Junction 权限限制的用例，应在具备必要权限的真实环境单独验证。若环境不具备创建链接等测试前提，标记为未验证，不算通过。
- 测试报告按 **平台 × 用例**记录通过、失败、跳过、未验证的情况及原因；所有目标平台安全关键能力未验收之前，不得写“已完整支持跨平台”。
- 对进程树清理、路径竞态和后台脱离进程的残余风险给出可观察的错误与文档说明。

## 12. 明确不在 Phase 2.2 的范围

- Docker、虚拟机、容器或真正的 OS 级文件系统/网络执行隔离；当前 Terminal 不是强安全 Sandbox。
- 不要求 WSL、Git Bash 或 Docker 才能在 Windows 原生环境使用基本 Terminal 功能；不实现任意 Shell 命令跨平台语法翻译，也不承诺所有第三方脚本/命令在三平台都存在。
- Tool Permission ACL 或单独的 Agent / Session 授权层；Session 选择工具即决定模型可用工具集合。
- `sensitive` 风险策略、复杂 Shell 命令分析、自动批准可信命令、会话级多层审批覆盖。
- 执行持久化、Session Event Log / Transaction Journal、Approval 持久化及跨重启恢复（按现有后续阶段计划实施）。
- Follow-up、Steer、持久化 Inbox、Pause/Resume、自动 Recovery 等 Phase 3 任务控制能力；**如后续提出提前开发，必须先明确确认调整阶段计划**。
- MCP、Skills、远程 CLI / HTTP API、Web UI、跨进程 Workspace 分布式锁等非本阶段能力。
- 文件删除、移动、批量重命名、项目全盘扫描与其他未明确要求的高风险文件操作。

## 13. 文档维护与交付要求

遵循项目现有文档约定：

1. **模块 `README.md`**：保持为当前事实，说明职责、对外契约、注入方式、配置示例、执行流程、错误语义、测试命令和已知限制；文档粒度按独立职责模块/包组织，以便 Coding Agent 进入该模块能快速理解背景。
2. **模块 `changes.md`**：按时间追加修改记录，必须包含**变更前设计、变更后设计、为什么修改、影响范围、测试/验证**，保留多次演进的时间线，不把历史修改原因覆盖掉。
3. **项目 `docs/changes.md`**：记录跨模块契约或生命周期设计变化，尤其是 Tool Runtime 前置链、Workspace 绑定、Approval 事件及原有超时语义调整。
4. **阶段文档**：实现中的偏差必须先核对已确认决策；不允许为了适配局部代码擅自改变阶段边界或核心原则；确认改动后同步更新本文、实际模块文档与验收项。
5. **交付报告**：列出实际改动文件、已完成能力、验收结果、测试命令、失败测试与剩余风险。不得把尚未验证的设计写成“已实现”。
6. **平台文档**：说明 Windows/macOS/Linux 默认 Shell、配置方式、命令语法差异、受支持的工作区路径形式、已验证的进程树清理范围和当前平台限制；在 CLI 帮助/示例中使用目标平台适用的命令。

**验收原则**：模型能安全地完成“读、写、改、执行、观察、继续”闭环；审批、路径边界、锁、取消、超时与不确定环境阻断是可靠的统一执行机制；不以牺牲 Phase 1/2.1 公共能力为代价，也不把本地受控执行描述为强隔离沙箱。

## 14. 本机验收报告（2026-11-25）

| 项         | 结果                                                           |
| ---------- | -------------------------------------------------------------- |
| 主机       | darwin（macOS）                                                |
| 命令       | `npm run typecheck` / `lint` / `format:check` / `test`         |
| 离线测试   | **290/290** 通过（含进程组等待与无空格运算符脱敏；以当次为准） |
| 默认 Shell | `/bin/sh`                                                      |

### 平台 × 用例

| 验收能力                                | macOS                | Linux  | Windows                            |
| --------------------------------------- | -------------------- | ------ | ---------------------------------- |
| Workspace 注册/创建/绑定、重叠拒绝      | 通过                 | 未验证 | 未验证                             |
| FileSystem 读写编辑、越界与符号链接拒绝 | 通过                 | 未验证 | 未验证（Junction 未测）            |
| Terminal 基本/复合命令、非零退出        | 通过（`/bin/sh`）    | 未验证 | 未验证（`cmd.exe` 语法仅代码分支） |
| Terminal 超时/取消/进程组清理           | 单测覆盖（故障注入） | 未验证 | 未验证（`taskkill` 路径未原生跑）  |
| 清理不确定 → UNSAFE → 阻断 → recover    | 通过（故障注入）     | 未验证 | 未验证                             |
| Approval + Workspace 锁 + CLI 闭环      | 通过                 | 未验证 | 未验证                             |
| Phase 1 / 2.1 回归                      | 通过                 | 未验证 | 未验证                             |

**不得宣称“已完整跨平台验收”。** Windows/Linux 原生 Runner 待补。二次修补后仍**不能**仅凭 darwin 离线测试认定 Phase 2.2「完全验收」。

### 已知限制

- Terminal **不是**强文件系统沙箱；已批准命令可访问 Workspace 外路径。
- POSIX 下同进程组后台任务会在 Shell 退出后继续等待（或超时杀组）；**脱离进程组**的后台进程仍无法保证发现/清理，不确定时标记 `UNSAFE`，重启后状态不保留。Windows 进程树检测为 best-effort，缺原生验收。
- 无 Docker/OS 沙箱、无 Tool Permission ACL、无审批/Workspace 持久化。
- Bootstrap `options.tools` 注入默认 `approval=never`（开发者显式工具）；内置写工具/Terminal 仍为 `always`。
- 文件路径仍存在检查—使用残留 TOCTOU（父目录替换；无 `openat` 时子项 `lstat` 间隙）。`list_directory` 已对「打开后路径换成区外链接」做 inode 身份失败关闭，但**不是** fd-scandir 级保证。无 `O_NOFOLLOW` 的平台依赖逐组件 `lstat`。Windows Junction/ADS 与进程树清理仍缺原生验证。
- 覆盖写入依赖同卷 `rename`；跨设备或平台 rename 语义差异未在 Windows/Linux 原生验收。
- CLI 审批对 `terminal.command` 仅做**启发式展示脱敏**（凭证字符类避开 `&|;` 等元字符，不得隐藏后续命令；非完备秘密检测）；批准与执行仍使用完整冻结参数 + `argsHash`。

**Phase 2.2 在本机（darwin）基线与多轮修补已落地；跨平台与路径边界未闭合前不宣称完全验收；不自动进入 Phase 2.3。**

### 设计例外与澄清（验收后修补）

| 项                                              | 处理                                                                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap `options.tools` 缺省 `approval=never` | **有意例外**：仅针对 Composition 显式注入的开发者工具，避免无审批 UI 的离线装配挂死；Registry 未声明元数据仍默认 `always`；内置写工具/Terminal 仍为 `always`。 |
| 未选入 `allowedNames` 的模型工具调用            | **保留 Phase 1 行为**：整批在执行前失败，不回落到全局 Registry；与「未注册 → Executor `tool_not_found`」区分。                                                 |
| Workspace `register` 与符号链接                 | 允许经链接路径注册，但身份固定为 `realpath` 物理根；物理根仍为链接则拒绝。                                                                                     |
| Terminal `command` 审批展示                     | **取舍**：凭证字符类 `[A-Za-z0-9._~+/=-]+`，在空白与 `&\|;<>()` 等处截断；+ `commandChars` + 权威 `argsHash`；不保证检出全部秘密。执行侧仍用批准快照原文。     |
