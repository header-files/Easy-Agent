# Easy Agent — Phase 2.1：多模型与 Provider 管理

> 状态：**已完成并验收**（2026-11-24）。  
> 日期：2026-11-24  
> 目标位置：`docs/phase-2.1.md`  
> 前置条件：Phase 1（`v0.1.0`）已完成。本阶段按已确认设计落地，不进入 Phase 2.2。

## 1. 阶段目标

在 Phase 1 已有 `ModelClient`、OpenAI-compatible Provider、Agent Loop、Session/Execution、Composition 与 CLI 的基础上，支持**显式注册多个模型、按模型标识路由、在 Session 中切换模型、为每次 Execution 固定模型**，并新增 **OpenAI Responses 原生 Provider**。

本阶段属于 Model 能力增强，**不重建 Agent Loop、Execution Engine、Tool Runtime 或 Session 调度机制**。原则是“统一配置、集中路由、各 Provider 自行适配协议、已有执行行为不回归”。

## 2. 已确认且不得擅自修改的设计决策

| 事项                    | 最终方案                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模型标识                | 使用 `Provider ID / Model ID`，如 `openai/gpt-4.1-mini`；不引入 Model Alias                                                                                                   |
| Provider ID             | 表示 Easy Agent 的**Provider 配置实例**，不必等于厂商名称；可用不同 ID 配置同一厂商的不同协议                                                                                 |
| 模型标识解析            | 按**第一个 `/`** 分隔，允许上游 Model ID 自身包含 `/`；Provider ID、Model ID 均不得为空                                                                                       |
| Model Registry          | 只接受启动配置中**显式注册**的模型；负责查询、列表、校验及模型到 Provider 的关联                                                                                              |
| Model Router            | **实现现有 `ModelClient` 契约**，根据已确定的完整模型标识路由调用；不保存 Session 当前模型                                                                                    |
| Provider 配置与实现关联 | **`Provider Type → Factory → Provider Instance`**：配置中的 `type` 决定实现，Provider ID 决定实例身份；由 Bootstrap 静态注册工厂并创建实例，不根据 Provider ID 硬编码厂商判断 |
| 配置生命周期            | 应用启动时注册 Provider 和 Model，运行中允许选择已注册模型；修改 Provider/Model 配置需重启，不实现热更新                                                                      |
| 模型选择优先级          | **Execution 覆盖 > Session 默认 > Application 默认**                                                                                                                          |
| 模型生效时机            | 在 **Execution 提交时**解析、校验并固化所选模型；已提交的排队/运行任务不受后续 Session 切换影响                                                                               |
| 公共协议                | 尽量保持既有 `ModelClient`、`ModelRequest`、`ModelResponse`、`ModelStreamEvent` 不变；确有协议表达缺口时做最小扩展                                                            |
| 上下文                  | Easy Agent 统一管理；Responses Provider **不依赖** `previous_response_id` 或 Conversations API 存储跨请求会话                                                                 |
| 旧设计迁移              | 用新的 `Providers + Models + DefaultModel` 统一配置及 `Registry + Router` 装配**替换** Phase 1 旧单模型配置/单 Provider 装配；**不新增旧配置兼容层，不维护两套格式**          |

要保留的是 Phase 1 既有**能力和公共契约**，不是旧单模型配置或旧装配代码。已废弃设计的历史理由写入相关 `changes.md`，不能以“兼容旧设计”为由保留长期双轨实现。

## 3. 架构与职责

```text
Application / AgentApplicationService / SessionAgent
    │ 选择模型：Execution > Session > Application
    │ 在提交 Execution 时校验并固定 modelRef
    ▼
Execution Engine ──► Agent Loop ──► ModelClient 契约
                                           │
                                           ▼
                                      Model Router
                                           │ 解析已注册模型
                                           ├────► Model Registry
                                           │
                                           ├────► OpenAI-compatible Provider
                                           └────► OpenAI Responses Provider

Composition / Bootstrap：启动时加载统一配置，通过 Provider Type 对应的工厂创建 Provider 实例，构造 Registry / Router。
Harness / 能力域契约：定义已有 ModelClient 等协作约定。
```

- **配置加载/Composition**：读取并验证新格式，根据 Provider `type` 选择工厂、按 Provider ID 创建实例，构造并注入 Registry、Router；不为旧配置维护 Normalizer。
- **Provider 工厂映射**：在 Bootstrap/Model Runtime 内维护静态 `type → factory` 映射。`type` 指明协议实现，Provider ID 是配置实例名称；相同 `type` 可以创建多个使用不同凭据或地址的实例。无需为此先引入插件容器或独立工厂框架。
- **Model Registry**：持有 `Provider ID → Provider Instance` 与 `Full Model ID → (Provider ID, 上游 Model ID)` 的关联；提供只读查询和列表；启动时验证本地配置，不通过联网探测全部上游模型。
- **Model Router**：对外维持 `ModelClient.generate()` / `stream()`；收到完整模型标识后验证并选择 Provider，将**上游 Model ID**（不带 Provider ID）传给实际 Provider；转发取消、超时、工具定义和必要请求参数。禁止使用可被 Session 切换改变的“全局 currentModel”。
- **Provider Adapter**：负责协议字段转换，统一对外响应和流式事件；不能把上游协议差异推给 Agent Loop。
- **Agent / Application**：负责 Session 模型选择和 Execution 模型覆盖的优先级，调用 Registry 校验；Router 不反向读取 Session。
- **Execution**：执行开始后到所有模型调用结束，使用提交时已固定的模型；不改变现有 FIFO、并发和取消机制。

### 3.1 Provider 配置如何关联到实际实现（必须落实）

**核心关联链路：`Provider Type → Provider Factory → Provider Instance → Model Registry → Model Router`。** 配置中的 `providers.<providerId>.type` 选择具体的协议适配实现；`providerId` 只是本次配置实例的标识，**不能**用于推断厂商或决定实现类。

例如以下配置声明了三个 Provider 实例，但只需要两种 Provider 实现：

```yaml
providers:
  openai:
    type: openai-responses
    baseURL: https://api.openai.com/v1
    apiKey: ${OPENAI_API_KEY}
  deepseek:
    type: openai-compatible
    baseURL: https://api.deepseek.com
    apiKey: ${DEEPSEEK_API_KEY}
  custom:
    type: openai-compatible
    baseURL: https://example.com/v1
    apiKey: ${CUSTOM_API_KEY}

models:
  - openai/gpt-4.1-mini
  - deepseek/deepseek-chat
  - custom/my-model

defaultModel: openai/gpt-4.1-mini
```

启动关联过程：

```text
Config Loader 读取配置并校验
  └─ Composition / Bootstrap
       ├─ 根据 provider.type 在工厂映射中查找对应实现
       │    ├─ openai-responses  → OpenAIResponsesProvider
       │    └─ openai-compatible → OpenAICompatibleProvider
       ├─ 按每个 Provider ID 创建独立的配置实例
       │    ├─ openai   → Responses 实例（OpenAI 配置）
       │    ├─ deepseek → Compatible 实例（DeepSeek 配置）
       │    └─ custom   → Compatible 实例（自定义服务配置）
       ├─ Model Registry 登记 Provider 实例和显式模型映射
       └─ Model Router 从 Registry 解析并路由请求
```

可采用以下**伪代码**表达实现约束（不预先规定项目真实类名、签名与目录，须与 Phase 1 现有代码对齐）：

```typescript
// 启动时固定的协议实现映射；不需要复杂 IoC/插件框架。
const providerFactories = {
  'openai-compatible': (config: ProviderConfig) =>
    new OpenAICompatibleProvider(config),
  'openai-responses': (config: ProviderConfig) =>
    new OpenAIResponsesProvider(config),
};

const providerInstances = new Map<string, ModelClient>();
for (const [providerId, providerConfig] of Object.entries(config.providers)) {
  const factory = providerFactories[providerConfig.type];
  if (!factory)
    throw new Error(`Unsupported provider type: ${providerConfig.type}`);
  providerInstances.set(providerId, factory(providerConfig));
}

// Registry 持有 providerId → 实例，以及 fullModelId → providerId/modelId。
const registry = createModelRegistry(providerInstances, config.models);
const modelClient = new ModelRouter(registry); // 注入现有 Agent Loop
```

**职责和约束：**

1. **`type` 决定实现类，Provider ID 决定实例身份**。不同 Provider ID 可复用同一种实现类；必须分别使用各自的 `baseURL`、密钥和其他连接参数，避免共享可变凭据或配置。
2. **工厂只创建实例，不负责模型路由**。Model Registry 记录实例及显式模型的关联；Model Router 根据完整模型标识查询 Registry，向 Provider 传递去掉 Provider ID 前缀后的上游 Model ID。
3. **启动校验必须覆盖未知 `type`、未知 Provider ID、重复/非法模型和缺失必要配置**。未知 Provider Type 应在启动时失败，不能静默回退到某个默认 Provider。
4. **不要写 `if (providerId === "openai")` 这类硬编码分支**；Provider ID 由使用者自定义，不等于协议类型。例如同一厂商可用 `openai-chat` 与 `openai-responses` 配置不同协议。
5. **Phase 2.1 采用静态工厂映射**，配置修改需重启。工厂映射可先用函数或普通对象实现，**不强制新增独立 `ProviderFactory` 类**；运行时注册/卸载 Provider、第三方插件机制不在本阶段实现。
6. 工厂、Registry 和 Router 不应输出 API Key 等敏感配置；复用现有 `ModelClient` 契约，避免把创建逻辑放进 Agent Loop。

**后续扩展方式：** 新增 Gemini 原生协议时，增加对应 Adapter 并登记一个新的 `type → factory`，再在配置中创建 Provider 实例即可；Registry、Router 和 Loop 不需要硬编码具体厂商名称。本阶段只实现 OpenAI-compatible 和 OpenAI Responses 两类。

## 4. 统一配置方案

目标逻辑结构如下（**示例仅表达字段语义；实际使用 JSON、YAML、TS 或既有配置机制，由 Coding Agent 根据仓库确定，避免无谓新增解析依赖**）：

```yaml
providers:
  openai:
    type: openai-responses
    baseURL: https://api.openai.com/v1
    apiKey: ${OPENAI_API_KEY}
  deepseek:
    type: openai-compatible
    baseURL: https://api.deepseek.com
    apiKey: ${DEEPSEEK_API_KEY}
  openai-chat:
    type: openai-compatible
    baseURL: https://api.openai.com/v1
    apiKey: ${OPENAI_API_KEY}

models:
  - openai/gpt-4.1-mini
  - deepseek/deepseek-chat
  - openai-chat/gpt-4.1-mini

defaultModel: openai/gpt-4.1-mini
```

启动时至少验证：Provider ID 唯一且合法、Provider 类型受支持、模型标识合法且不重复、每个模型引用的 Provider 存在、默认模型已注册、必要凭据/连接配置齐全。未注册模型在提交 Execution 或切换模型时**立即报错**，不会隐式发起上游请求；不要求启动时验证云端模型实际存在或账号具备访问权。

配置可以引用原有 API Key 环境变量，但**不保留旧配置结构作为第二套解析入口**。更新 README、示例及相关测试，禁止在错误和日志中暴露凭据。若项目已有正式配置字段，先核对后迁移，不能凭上述示例直接覆盖所有现存字段。不提供或依赖 `.env` 自动加载。

## 5. 模型选择与 CLI 行为

- Application 配置一个默认模型；新 Session 若没有独立选择则继承该默认值。
- CLI `/model`：列出**显式注册的模型**并标示当前 Session 模型。
- CLI `/model <provider-id/model-id>`：校验并修改**当前 Session 的默认模型**，不修改 Application 默认模型或其他 Session。
- Execution 显式覆盖模型时，只影响本次任务，不修改 Session 默认模型。
- **提交时固定**：Session 模型切换只影响切换之后提交的 Execution；排队中的旧 Execution 和运行中的旧 Execution 均保留原模型。
- 不支持的模型、错误的标识、缺失 Provider：应清晰报错，保持原 Session 选择不变。
- 模型列表是 Registry 的只读视图；不调用上游动态发现模型，不引入别名或自动 Fallback。

例子：Session A 使用 `openai/gpt-4.1-mini` 提交 E1（即使 E1 排队）；随后执行 `/model deepseek/deepseek-chat`；再提交 E2。**E1 仍用 OpenAI，E2 用 DeepSeek**。其他 Session 不受影响。

## 6. OpenAI Responses Provider 的兼容要求

在 Phase 1 统一协议范围内完整实现：

1. 普通非流式文本生成与统一响应。
2. 流式文本事件的转换与完整终态处理。
3. Tool Calling 定义、函数调用参数、调用 ID 的解析与工具结果回填；`function_call` 与 `function_call_output` 的关联必须正确。
4. 超时、取消、错误、用量等现有统一协议**已经表达的字段**，不得静默丢失；不支持的必要字段需显式拒绝或说明。
5. 多轮上下文由 Easy Agent 本地提供完整必要历史；**不依赖服务端 `previous_response_id` / Conversation ID**。若某一模型/特性依赖现有契约无法表达的推理状态或特殊内容，记录限制并进行最小范围评估，不能静默截断导致工具链错误。

**不要求**一次支持所有 Responses 特有能力（例如内建 Web Search、文件搜索、图像/音频、原生服务端会话管理等）。协议实现应以编码时官方文档和实际 SDK 类型为准：

- [OpenAI Function Calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI Responses Streaming](https://developers.openai.com/api/docs/guides/streaming-responses)
- [OpenAI Conversation State](https://developers.openai.com/api/docs/guides/conversation-state)

## 7. Coding Agent 开发拆分

### 2.1.0 — 代码基线核对（必须先完成）

阅读 `AGENTS.md`、项目架构、Phase 1 总结，以及当前涉及模块的 `README.md` / `changes.md`。实际定位并核对：

- `ModelClient` / 请求 / 响应 / 流式事件的真实定义。
- 当前 Provider 的生成与流式实现、工具调用及工具结果 ID 映射。
- Composition 配置解析与 Provider 装配路径。
- Session 默认配置、Execution 提交配置覆盖及模型字段传递方式。
- CLI Session 切换/命令解析方式和现有测试。

产出**简短影响清单**：哪些组件可原样复用、哪些需扩展、哪些旧单模型配置/装配逻辑可删除。无需提前输出大型重构方案；如发现必须修改公共协议或已确认架构边界的重大冲突，先说明原因和范围，再请用户确认。

### 2.1.1 — 新配置与 Model Registry

- 引入统一 Providers / Models / DefaultModel 配置，替换旧单模型配置及测试样例。
- 明确 Provider ID 与 Provider Type 不同：在启动配置校验中识别受支持的 `type`，不以 Provider ID 决定协议实现。
- 实现配置本地校验、显式模型查询、列举和 Provider 关联。
- 本阶段仅启动注册，不开发运行时增删或热更新。

**验收**：多个 Provider/模型正确加载；无效配置、重复模型、未知 Provider、未注册默认模型均可靠拒绝；无需外网。

### 2.1.2 — Model Router 与 Composition

- 在 Composition 中实现静态 `Provider Type → Factory` 关联，根据每条 Provider 配置创建对应实例；同一实现类应支持多个不同 ID、连接地址与凭据的实例。
- 以现有 `ModelClient` 契约实现 `ModelRouter`，接入已有 OpenAI-compatible Provider。
- Composition 注入 Router 作为统一 ModelClient；移除不再使用的单 Provider 装配分支。
- `generate()`、`stream()` 正确分发并传递取消/超时/工具信息；不要重写 Loop。

**验收**：同一 Loop 通过 Router 使用至少两个显式模型；未注册模型调用失败且不发送请求；请求使用上游原始 Model ID；**相同 `type` 的不同 Provider ID 应正确创建独立实例并使用各自配置；未知 `type` 启动失败，不能错误地依据 Provider ID 选择实现。**

### 2.1.3 — Session / Execution 模型选择

- 按已确认优先级确定模型，提交时校验并固化；不得依赖执行时的可变 Session 默认值。
- Session 切换只影响后续提交；Execution 覆盖只影响单次任务。
- 尽量沿用现有 FIFO 和取消 API；不引入 Inbox/Follow-up 的新语义。

**验收**：不同 Session 可以并发使用不同模型；同一 Session 排队期间切换模型，旧执行不被改写；失败的模型选择不污染 Session。

### 2.1.4 — CLI 模型列表与切换

- 在现有 CLI 中加入 `/model` 与 `/model <full-id>`。
- 列表只展示 Registry 显式注册项；切换仅作用于当前 Session。
- 维持现有 CLI 会话、取消、流式输出方式。

**验收**：可以查看和切换；无效模型显示错误但当前选择不变；Session 切换后各自的模型设置独立。

### 2.1.5 — OpenAI Responses Provider

- 新增原生适配器，处理文本、工具调用、流式事件、取消、超时及统一错误。
- 遵守 Easy Agent 的上下文管理边界，不引入 Provider 会话状态。
- 有协议不兼容时优先调整 Provider；只有证明现有契约无法正确表达必需信息时，才提出**最小公共契约扩展**。

**验收**：使用离线协议 Fixture 验证非流式、流式、工具调用和工具结果回填；有可用密钥时可选进行真实 API 烟测。不得把真实 API Key 作为自动测试前置条件。

### 2.1.6 — 回归测试、文档与收尾

- 运行仓库实际存在的 lint / format / typecheck / build / unit / integration 命令。
- 确保 Phase 1 模型—工具—模型循环、Session FIFO、不同 Session 并发、取消、CLI 流式仍然可用。
- 更新 README、配置示例、相关模块 `README.md` 与局部 `changes.md`；对跨模块决定补充项目级 `docs/changes.md` 摘要。
- 删除已不再使用的旧配置解析/装配分支，防止维护两套模式；历史决策**保留在变更记录**中。

## 8. 必须覆盖的验收场景

| 场景                                                     | 预期结果                                              |
| -------------------------------------------------------- | ----------------------------------------------------- |
| 注册两个 Provider 和三个模型                             | 查询、列表与完整模型标识映射正确                      |
| 相同厂商、不同 Provider ID/协议                          | 可分别选择和调用，不冲突                              |
| 相同 Provider Type，不同 Provider ID / baseURL / API Key | 由同一工厂创建独立实例，按 Provider ID 路由到各自配置 |
| 配置引用未知 Provider Type                               | 启动失败并说明不支持的 `type`；不静默回退             |
| 自定义 Provider ID 与厂商名称不一致                      | 仍根据 `type` 正确创建 Provider，不按 ID 推断实现     |
| Model ID 自身包含 `/`                                    | 只用第一个 `/` 拆分，发送正确上游 ID                  |
| 默认模型未注册、模型引用未知 Provider                    | 启动配置校验失败                                      |
| 用户切换未注册模型                                       | 立即拒绝，原 Session 选择不变                         |
| Execution > Session > Application                        | 三层优先级正确，覆盖不反向修改默认值                  |
| E1 已排队，Session 切换后提交 E2                         | E1/E2 分别使用提交时的模型                            |
| 两个 Session 同时执行                                    | 模型选择互不干扰，不存在共享 currentModel 串用        |
| Router 的 generate / stream                              | 均路由正确，事件与结果仍符合已有契约                  |
| Responses 文本与 Tool Calling                            | 正确生成工具调用、`call_id` 关联与结果回填            |
| 模型请求报错、取消或超时                                 | 保持既有错误/取消语义，无伪造成功事件                 |
| 旧单模型配置已被替换                                     | 不存在并行配置体系；新配置与文档一致                  |

**Phase 2.1 完成定义**：上述场景的离线/模拟测试通过，仓库原有业务回归通过，CLI 可切换模型，至少一个 OpenAI-compatible Provider 与一个 Responses Provider 可通过统一 Router 接入；如未提供凭据，真实远程调用列为“待手动验证”，不得宣称已验证。

## 9. 不在本阶段实现的能力

- Phase 2.2 内置文件/终端工具、Workspace、Sandbox 与基础审批。
- Phase 2.3 HTTP API、SSE 服务端；Phase 2.4 Persistence / Session Event Log。
- Phase 2.5 MCP；Phase 2.6 Skills。
- **Phase 3 的 Follow-up、Inbox、排队查询增强、Steer、完整 Recovery、复杂调度与控制**；不因本次模型切换而提前开发。
- 自动 Fallback、智能路由、模型自动发现、热加载 Provider、Model Alias、复杂能力协商、多模态与服务端上下文管理。

如果当前任务中发现确实必须提前实现后续计划中的功能，**先明确原计划阶段并征求用户是否同意提前**，未经确认不得变更范围。

## 10. 文档及变更记录要求

遵循现有项目规则，不新建第二套文档体系：

- 模块 `README.md`：描述当前最终有效的实现方式，包含模块定位、真实文件入口、配置与测试方法；Model Runtime/Composition 文档应解释 `type → factory → instance → registry → router` 的关联关系。
- 模块 `changes.md`：对 Model Runtime、Composition、Agent、Execution、CLI 的**实际实质性修改**分别记录真实日期、变更前/后、为什么修改、影响范围和验证依据；如本次引入工厂映射，记录其设计原因及与 Provider ID 的职责区分。
- 项目级 `docs/changes.md`：记录“从 Phase 1 单模型配置/装配迁移到多模型 Registry/Router”这一**跨模块架构决策摘要**，并链接相关模块日志，避免重复复制。
- 原有设计的原因保留在历史日志中，**现行说明不得再将旧单模型方案列为仍支持的使用方式**。

## 11. 实际交付与验收记录

验收日期：2026-11-24。

### 已落地能力

- Composition：`providers` / `models` / `defaultModel` 统一配置；静态 `Provider Type → Factory`；`DefaultModelRegistry` + `ModelRouter` 注入。
- Runtime Model：保留 OpenAI-compatible；新增 `OpenAIResponsesModelClient`；Registry/Router 按第一个 `/` 解析并转发上游 Model ID。
- Agent / Application：Session `getModel`/`setModel`；提交时固化有效配置；`listModels` / `getSessionModel` / `setSessionModel`。
- CLI：`/model` 列表与切换；`--model` 映射 `defaultModel`；删除 `--base-url` 与旧环境变量入口。

### 验证命令与结果

| 命令                                                    | 结果                           |
| ------------------------------------------------------- | ------------------------------ |
| `npm run typecheck`                                     | 通过                           |
| `npm run lint`                                          | 通过，0 警告                   |
| `npm run format:check`                                  | 通过                           |
| `npm run build`                                         | 通过                           |
| `npm test`                                              | **266** 项通过、0 失败、0 跳过 |
| `node dist/application/cli/bin.js --help` / `--version` | 通过，版本仍为 `0.1.0`         |

定向覆盖：`tests/composition-config.test.ts`、`tests/model-routing.test.ts`、`tests/openai-responses.test.ts`、`tests/agent-application-service.test.ts`、`tests/cli.test.ts`、`tests/bootstrap.test.ts`、`tests/phase-1.6-integration.test.ts`。

真实远程 API 调用：**待手动验证**（自动测试全部离线，不要求 API Key）。

### 停止点

Phase 2.1 完成后停止；未实现 Phase 2.2 文件/终端工具、Workspace/Sandbox、审批，以及 HTTP/Persistence/MCP/Skills。
