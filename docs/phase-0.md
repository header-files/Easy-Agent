# Phase 0 — 工程初始化与架构骨架搭建（已完成的工程基线）

> **Phase 0 目标：建立结构清晰、规范可执行、可检查与可构建的 TypeScript / Node.js 项目。**
>
> **本阶段不实现 Agent 业务功能，不以能和模型对话作为验收条件。**
>
> **历史交付状态：2026-11-20 已完成本阶段工程验收。Logging 基础设施随后已完成独立验收，作为 Phase 1 的工程基线；2026-11-21 用户已授权 Phase 1.1；当前任务见 [phase-1.1.md](phase-1.1.md)。以下任务与验收记录描述 Phase 0 当时范围。**

## 1. 阶段边界

| 方向       | Phase 0 必须完成                                                                     | 明确不做                                       |
| ---------- | ------------------------------------------------------------------------------------ | ---------------------------------------------- |
| 工程初始化 | `package.json`、lockfile、Node.js / TypeScript / ESM 配置、`.gitignore`              | 数据库、容器编排、微服务                       |
| 工程质量   | `typecheck`、`lint`、`format:check`、`build`、`test` 脚本及实际通过                  | 复杂 CI/CD、发布流水线                         |
| 工程结构   | 为六个一级职责模块建立目录及就近 `README.md`、`changes.md`，写清职责与当前未实现状态 | 批量空 `.ts` 文件、占位服务与未用接口          |
| 基础源码   | 只有保证编译/测试入口有效所必需的少量源码                                            | AgentManager、Loop、Engine、ModelClient 的实现 |
| 基础测试   | 不需要密钥与网络的工程 smoke test                                                    | 模型真实请求、业务单测、伪造对话测试           |
| 文档       | 根目录与模块两级现行文档、各自变更记录、阶段计划保持一致                             | 在 README 中宣称 Agent 已可用                  |

说明：当前阶段应**实际建立六个一级职责模块目录及其有意义的 README/changes 文档**；这并非空目录。更深层的 Model、Tool、CLI 等子能力目录仍只在 `docs/architecture.md` 规划，实际开发时才创建代码与本地文档；不添加 `.gitkeep` 或空业务 `index.ts`。

`.env.example`、模型 API Key 配置及 CLI 交互命令属于 Phase 1；在 Phase 0 没有使用者时不要提前创建虚假配置。

## 2. 推荐工程结构（Phase 0 交付）

```text
 easy-agent/
 ├── README.md
 ├── AGENTS.md
 ├── .cursor/rules/easy-agent.mdc
 ├── docs/
 │   ├── AGENT.md
 │   ├── architecture.md
 │   ├── conventions.md
 │   ├── phase-0.md              # Phase 0 历史基线
 │   ├── roadmap.md              # 后续阶段规划
 │   └── changes.md              # 变更时间线
 ├── package.json
 ├── package-lock.json
 ├── tsconfig.json               # 源码与测试统一检查
 ├── tsconfig.build.json         # 只构建源码
 ├── eslint.config.js
 ├── .prettierrc.json
 ├── .prettierignore
 ├── .nvmrc                     # Node.js 26
 ├── .gitignore
 ├── src/
 │   ├── index.ts                # 最小可构建入口，不承载 Agent 业务
 │   ├── application/
 │   │   ├── README.md
 │   │   └── changes.md
 │   ├── agent/
 │   │   ├── README.md
 │   │   └── changes.md
 │   ├── execution/
 │   │   ├── README.md
 │   │   └── changes.md
 │   ├── harness/
 │   │   ├── README.md
 │   │   └── changes.md
 │   ├── runtime/
 │   │   ├── README.md
 │   │   └── changes.md
 │   └── composition/
 │       ├── README.md
 │       └── changes.md
 └── tests/
     └── smoke.test.ts          # 验证测试与入口可正常使用
```

这是**推荐结构，不要求文件名严格一字不差**。使用已验证的最简工具链，避免额外抽象。六个一级职责模块的目录和本地文档必须真实创建；Phase 1 的业务源码目录和更细的能力子模块仍只在 `docs/architecture.md` 规划，Phase 0 无需提前创建。

## 3. 任务拆分

### A. 初始化工程

- 确定当前维护的 Node.js LTS 版本要求，在 `package.json` 或开发说明中注明。
- 初始化 npm、ESM、TypeScript 严格模式及必要的源代码/构建目录配置。
- 生成 `package-lock.json` 并作为版本控制文件交付；忽略 `node_modules/`、构建输出和秘密配置。实际 Git commit / push 仍遵循 [Git 授权规范](AGENT.md#9-版本控制)，仅在用户明确要求时执行。
- 保持单仓库、单进程预期；不创建 Monorepo 或多个 npm 包。

**验收：** 在干净环境可安装依赖，TypeScript 与模块系统配置自洽。

### B. 工程质量工具

- 配置 TypeScript 编译与 `npm run typecheck`。
- 配置 lint、格式化检查与对应脚本。
- 配置 `npm run build` 和离线 `npm test`。
- 保证工程命令不依赖 API Key、第三方网络模型或数据库。

**验收：** 质量检查脚本可实际运行且成功，不能用空脚本假装通过。

### C. 组织项目骨架

- 保持架构职责边界清晰，依据 `docs/architecture.md` 约定未来模块位置。
- 在六个一级模块内交付**具有真实背景和边界内容**的 `README.md`，说明目的、负责/不负责的内容、当前状态、未来开发范围、协作关系，并链接全局文档。
- 在每个一级模块内交付 `changes.md`，含记录规则、变更模板和真实历史；没有真实变更时明确注明“暂无记录”，不虚构版本演进。
- 如工程需要，可创建 `src/index.ts` 作为最小构建入口。
- 不提前定义业务契约、创建会话状态、装配 Agent 组件或绑定 Provider。
- 不为架构图完整性创建未来模块的占位实现。

**验收：** 项目地图清晰；六个一级模块的说明与本地变更记录均可定位；源码与文档对目录的约定不存在冲突。

### D. 基础离线验证

- 建立最小 smoke test，证明测试框架能加载项目入口或工程模块。
- 不编造 Agent 回答、虚构 Fake ModelClient 或无真实调用方的业务对象。
- 验证构建输出在约定 Node.js 环境中能够被正常加载（如项目确有入口）。

**验收：** `npm test` 能在无模型密钥环境下运行；测试所验证的范围被准确描述。

### E. 文档校验和收尾

- 核对 README 中当前阶段与真实可用命令。
- 核对 AGENTS/Cursor 规则和文档索引没有将 Phase 1 写成当前任务。
- 确认模块 README 真实描述“Phase 0 只有文档，无业务实现”，模块变更记录未虚构历史。
- 如本模块发生实质性调整，更新本模块 `README.md` 并追加本地 `changes.md`；全局工程方案或跨模块调整才追加项目级 `docs/changes.md`。
- 汇报实际执行的验证命令、结果和待完成事项。

**验收：** 所有现行文档与交付代码一致，历史记录保留必要变更原因。

## 4. Definition of Done

- [x] 已完成 TypeScript / Node.js / ESM 工程初始化，生成锁文件并纳入交付；依据 Git 授权规范，本次未执行 commit / push。
- [x] `strict` 类型检查与基本工程规则已启用。
- [x] `npm run typecheck` 成功。
- [x] `npm run lint` 成功。
- [x] `npm run format:check` 成功。
- [x] `npm run build` 成功。
- [x] `npm test` 成功，且不配置 API Key、不访问外部服务即可执行。
- [x] README、架构、工程规范、阶段文档、Coding Agent 规则与实际工程一致。
- [x] 六个一级职责模块均有非空且具体的 `README.md`，包含背景、职责边界、当前实现状态、待实现能力和文档关联。
- [x] 六个一级职责模块均有自己的 `changes.md`，包含模板和真实变更历史（如无变更注明暂无记录）；与项目级 `docs/changes.md` 的职责分工清晰。
- [x] 没有假实现、冗余空文件或大批量占位模块。
- [x] 未提前实现 Session、Engine、Loop、ModelClient、CLI 对话或其他 Phase 1 功能。
- [x] 六个模块的现行说明与日志已复核，无模块实质性调整；公共工程选型已追加到 `docs/changes.md`。

### 2026-11-20 实际验收记录

环境：Node.js `v26.8.2`、npm `11.19.1`。直接开发依赖均已按锁文件安装，无运行时依赖。

| 命令/核对                                                                         | 实际结果                                                                      |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm install`（使用临时 npm 缓存）                                                | 成功，生成 `package-lock.json`，安装 100 个开发依赖包                         |
| `npm ci --offline --cache /private/tmp/easy-agent-npm-cache --no-audit --no-fund` | 成功，使用已下载缓存从锁文件重建依赖；验证阶段无联网                          |
| `npm run typecheck`                                                               | 成功，源码与测试严格类型检查通过                                              |
| `npm run lint`                                                                    | 成功，0 错误、0 警告                                                          |
| `npm run format`、`npm run format:check`                                          | 完成统一格式化，格式检查通过                                                  |
| `npm run build`                                                                   | 成功，生成 `dist/index.js`，未输出测试文件                                    |
| `npm test`                                                                        | 成功，2 项通过、0 失败、0 跳过；包含源码 ESM 导入及构建产物直接加载           |
| `git remote -v`、`git symbolic-ref --short HEAD`                                  | `origin` 为用户指定的 SSH 地址，当前分支为 `main`                             |
| `git check-ignore`                                                                | 依赖目录、构建产物、`.env`、`.env.local`、常见密钥文件及 `.DS_Store` 均被忽略 |

六个一级模块的 README/changes 已有完整有效基线，本次保留原文；项目级说明与工程选型记录已同步。测试范围仅为工程加载，不代表 Agent 业务已实现。未发现需用户确认的架构冲突。

## 5. Phase 0 Coding Agent 任务指令（可直接复制）

> 请先阅读仓库根目录的 `AGENTS.md`、`docs/AGENT.md`、`docs/architecture.md`、`docs/conventions.md`、`docs/phase-0.md`，并根据即将维护的模块阅读对应的 `src/<module>/README.md` 与 `changes.md`；涉及全局/跨模块决策时阅读 `docs/changes.md`。**本次只完成 Phase 0：TypeScript / Node.js 工程初始化、工程质量脚本、六个一级职责模块的 README/changes 文档骨架及基本离线 smoke test。** 不实现 AgentManager、SessionAgent、Execution Engine、Basic Loop、ModelClient、模型 Provider 或 CLI 聊天功能；不要新增无用途的空模块。执行并报告 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm test`。模块级变更需更新 `src/<module>/README.md` 和本地 `changes.md`；全局或跨模块决策再维护 `docs/changes.md` 摘要，写明日期、前后差异、原因与影响。完成后汇报文件改动和真实验证结果，不提前开展 Phase 1。

## 6. Phase 1 启动条件

完成并验收 Phase 0 后，由用户另行明确发起后续阶段。在统一 Logging 基线已完成后，用户已于 2026-11-21 明确要求实现 [Phase 1.1 Model System](phase-1.1.md)，本历史文档不再作为当前实现范围。阶段文档与路线图的存在仍不等于自动接续开发授权。
