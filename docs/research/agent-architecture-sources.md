# Agent Architecture: Primary-Source Findings

> 目的：为 travel-agent 的后续设计提供可核验的约束和事实，不在此文件中决定最终架构。
> 来源限定为官方文档、官方 GitHub 仓库/README。整理日期：2026-09-07。各 SDK/API 在落地前应按锁定版本重新核对。

## 1. OpenAI Agents SDK

### 1.1 运行模型、工具和会话

- SDK 将 agent 定义为带有 instructions、tools、handoffs 等配置的 LLM；Runner 负责执行模型调用、工具调用和后续循环，直到得到最终输出。这说明“模型调用”和“工作流执行”应是两个可观测的层次，而不是把所有业务流程塞进一个 prompt。来源：[Agents SDK - Agents](https://openai.github.io/openai-agents-python/agents/)、[Running agents](https://openai.github.io/openai-agents-python/running_agents/)。
- 工具可以是 function tool、agent-as-tool 或 hosted tool；工具的参数 schema 用于约束调用。来源：[Tools](https://openai.github.io/openai-agents-python/tools/)。对 MVP 的直接启示是：地图地点搜索、路线规划、天气/开放时间等外部能力应暴露为窄接口，并让 schema 承担输入校验；不要把原始地图 API 直接交给模型。
- SDK 的 Session 机制可以在多次 run 之间自动维护历史，内置 SQLiteSession 等实现；也允许自定义 session。来源：[Sessions](https://openai.github.io/openai-agents-python/sessions/)。这支持“同一会话继续修改行程”，但不等于跨用户共享记忆：session key 必须与用户/会话隔离，存储层还要处理并发、过期和删除。

### 1.2 Handoff 与编排

- handoff 是把当前控制权转给另一个 agent；被 handoff 的 agent 继续负责当前 run 的最终响应。SDK 也提供 agent-as-tool，调用方仍保留控制权。来源：[Handoffs](https://openai.github.io/openai-agents-python/handoffs/)。两者语义不同：旅游 MVP 若仅需要“规划行程”，可先由一个 planner 控制工具调用；只有当专业域有清晰边界（例如路线可行性检查）时，才考虑 handoff。需要保留总控摘要时，agent-as-tool 更符合“主 agent 汇总多个专家结果”的语义。
- handoff 可以附带 input/output 类型和输入过滤；输入过滤可以在交接前裁剪历史。来源：[Handoffs - Input filters](https://openai.github.io/openai-agents-python/handoffs/)。这提示实现必须显式定义跨 agent 的数据契约和最小上下文，而不是隐式转发全部对话。
- SDK 的 run loop、handoff 和工具调用都是可组合的，但官方并未要求每个功能都拆成 agent。来源：[Running agents](https://openai.github.io/openai-agents-python/running_agents/)、[Tools](https://openai.github.io/openai-agents-python/tools/)。对 MVP 的约束是优先使用普通代码步骤和工具，agent 数量由独立上下文/权限/验收标准驱动。

### 1.3 Guardrails 与 tracing

- guardrail 分为 input、output、tool guardrail；可以在输入或输出不满足条件时触发 tripwire，终止本次 run。来源：[Guardrails](https://openai.github.io/openai-agents-python/guardrails/)。适用于 travel-agent 的硬约束包括：目的地和日期完整性、输出是否符合行程 schema、工具参数是否安全；“景点偏好”这类软偏好仍应由模型排序，不应伪装成安全 guardrail。
- tracing 会记录 agent run、generation、tool、handoff 等 span，并支持自定义 span；官方说明 tracing 默认收集运行细节，敏感数据记录可配置。来源：[Tracing](https://openai.github.io/openai-agents-python/tracing/)。MVP 可用它记录 latency、工具错误、schema 重试和最终计划版本；用户消息、定位和个人信息需按隐私策略关闭或脱敏。

## 2. OpenAI Responses API

- Responses API 支持用 `previous_response_id` 串联响应，也支持 Conversations API 以持久化 conversation identifier 管理跨请求状态。来源：[Conversation state](https://platform.openai.com/docs/guides/conversation-state)。这提供了服务端会话链路，但应用仍需维护自己的 user/session/itinerary 记录，不能把 response chain 当作业务数据库。
- Responses API 的 tools 既包括模型可调用的 function，也包括平台托管工具；工具调用与工具结果是明确的输入/输出项。来源：[Using tools](https://platform.openai.com/docs/guides/tools)。因此地图服务应由后端 function tool 包装，后端验证 key、配额和坐标；前端不能暴露高权限地图凭据。
- `previous_response_id` 只解决模型上下文连接，不自动解决业务状态、版本并发、撤销或权限。来源：[Conversation state](https://platform.openai.com/docs/guides/conversation-state)。对“重新生成第 2 天”这类操作，业务层需要 itinerary version / day revision，而不是只追加一条消息。

## 3. LangGraph

### 3.1 Durable execution、状态和记忆

- LangGraph 的 persistence 通过 checkpointer 按 thread 保存 graph state 的 checkpoints；checkpoint 可用于恢复、审查和 time travel。来源：[Persistence](https://langchain-ai.github.io/langgraph/concepts/persistence/)。这适合长时间运行的旅行规划、用户离开后继续和可恢复的工具调用，但 MVP 不必为了短请求立即引入分布式 durable runtime。
- Durable execution 依赖持久化 checkpoint，并要求工作流节点尽量确定性、外部副作用幂等或包在 task 中，以便从中断点恢复。来源：[Durable execution](https://langchain-ai.github.io/langgraph/concepts/durable_execution/)。地图搜索、写入行程版本、发送通知等副作用必须有 request/idempotency key；否则恢复可能重复执行。
- LangGraph 区分 thread-scoped short-term memory 与跨 thread 的 long-term memory，后者按 namespace 存储。来源：[Memory](https://langchain-ai.github.io/langgraph/concepts/memory/)。旅行 MVP 的会话历史属于 short-term；用户长期偏好（预算、步行接受度）若要保存，应有明确 opt-in、可查看/删除，并且不能把一个用户的偏好混入另一用户的 thread。

### 3.2 Human-in-the-loop 和流式执行

- `interrupt()` 可以暂停 graph 并把控制权交给人；恢复时通过 `Command` 继续，且需要 checkpointer 与稳定 thread id。来源：[Human-in-the-loop](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/)。适用于“发现日期/预算冲突，要求用户确认”或“即将写入最终行程前确认”；不应为普通的模型输出增加无意义确认步骤。
- 官方文档强调 interrupt 恢复可能重新执行当前节点，因此副作用应放到可恢复的 task 中并保证幂等。来源：[Human-in-the-loop](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/)、[Durable execution](https://langchain-ai.github.io/langgraph/concepts/durable_execution/)。这是实现审批/确认时最重要的工程约束。
- LangGraph 支持以 stream/stream modes 输出节点更新、消息和自定义事件。来源：[Streaming](https://langchain-ai.github.io/langgraph/concepts/streaming/)。前端可消费“规划阶段、搜索阶段、校验阶段”等事件；但流式事件不是最终 itinerary 合同，最终结果仍应由结构化状态/版本接口返回。

## 4. Vercel AI SDK（前端流式交互参考）

- AI SDK 的官方仓库把 Core 定位为模型调用、结构化输出、tool calling 和 streaming 的统一接口，把 UI 定位为聊天 UI 的状态管理与框架适配。来源：[vercel/ai README](https://github.com/vercel/ai)、[AI SDK documentation](https://ai-sdk.dev/docs)。这是一种适合本项目 Web 前端的边界：后端负责 agent/tool，前端只消费安全的文本和结构化事件。
- `streamText` 可产生文本/工具调用流，AI SDK UI 的 `useChat` 负责客户端消息状态和流式更新。来源：[AI SDK - Generating text](https://ai-sdk.dev/docs/ai-sdk-core/generating-text)、[AI SDK UI - Chatbot](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot)。旅行 MVP 可将“正在搜索/正在排路线/正在校验”作为事件或消息 metadata 展示；地图、列表和详情页应订阅同一个 itinerary 状态，而不是从聊天文本反解析路线。
- AI SDK 的工具调用仍要求服务端实现工具和权限边界；UI hook 不是授权层。来源：[AI SDK - Tools and tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)、[AI SDK UI - Chatbot](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot)。不要把地图 API key、任意 URL 抓取或未过滤工具暴露给浏览器。
- 官方 GitHub 仓库同时包含 provider、core、UI、RSC 等包，说明其能力面很宽。来源：[vercel/ai repository](https://github.com/vercel/ai)。MVP 不应复制整套框架或同时引入多个 agent runtime；只采纳与现有前端技术栈匹配的流式协议和消息状态约定。

## 5. 对 travel-agent MVP 的证据约束

以下是从上述来源直接推导出的约束，不是最终设计：

1. “行程”必须是后端的结构化、可版本化对象（天、地点、顺序、时间段、坐标、来源/更新时间、警告），聊天文本只是解释层；Responses、Agents SDK 和 AI SDK 都把工具/结构化输出作为独立边界，而不是鼓励从自然语言解析业务状态。[来源：Responses tools](https://platform.openai.com/docs/guides/tools)、[AI SDK structured outputs](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)。
2. LLM 适合意图抽取、缺失信息澄清、偏好排序和自然语言解释；确定性代码适合 schema 校验、权限、距离/时间计算、去重、版本写入、地图 API 调用和硬约束检查。这与 Agents SDK 的 tool/guardrail 分层和 LangGraph 的可恢复副作用要求一致。[来源：Agents SDK tools](https://openai.github.io/openai-agents-python/tools/)、[Guardrails](https://openai.github.io/openai-agents-python/guardrails/)、[Durable execution](https://langchain-ai.github.io/langgraph/concepts/durable_execution/)。
3. 多轮会话需要至少三类 ID：用户身份、会话/thread、行程版本。SDK 的 session/conversation 能保存模型上下文，但不能替代业务隔离、并发控制和删除策略。[来源：Agents SDK sessions](https://openai.github.io/openai-agents-python/sessions/)、[Conversation state](https://platform.openai.com/docs/guides/conversation-state)、[LangGraph persistence](https://langchain-ai.github.io/langgraph/concepts/persistence/)。
4. 搜索结果和路线结果必须保存来源、时间和失败状态，并在模型上下文中区分“用户事实”“工具事实”“模型建议”。官方 tracing/checkpoint/streaming 文档支持可观测和恢复，但不会自动提供旅游事实的真实性保证。[来源：Agents SDK tracing](https://openai.github.io/openai-agents-python/tracing/)、[LangGraph streaming](https://langchain-ai.github.io/langgraph/concepts/streaming/)。
5. 前端主页面、路线总览、每日详情、地图页应共享 itinerary 的结构化读模型；流式聊天只用于增量反馈。Vercel AI SDK 的 UI 层负责消息状态，不应成为地图或列表数据源。[来源：AI SDK UI](https://ai-sdk.dev/docs/ai-sdk-ui)、[AI SDK UI chatbot](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot)。

## 6. 不应直接照搬的能力

- 不要因“agent”标签而拆出多个 agent：handoff、LangGraph graph、长期记忆都会增加状态、调试和成本；除非有独立权限、上下文或验收标准，否则普通函数/工具更可控。来源：[Handoffs](https://openai.github.io/openai-agents-python/handoffs/)、[LangGraph persistence](https://langchain-ai.github.io/langgraph/concepts/persistence/)。
- 不要把模型会话历史当作事实库、行程数据库或用户画像；要有自己的 schema、版本和删除/权限策略。来源：[Conversation state](https://platform.openai.com/docs/guides/conversation-state)、[Memory](https://langchain-ai.github.io/langgraph/concepts/memory/)。
- 不要在没有幂等设计前启用可恢复执行、自动重试或 human-in-loop；恢复可能再次运行节点，地图搜索/写入等副作用会重复。来源：[Durable execution](https://langchain-ai.github.io/langgraph/concepts/durable_execution/)、[Human-in-the-loop](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/)。
- 不要把流式 token 当作稳定 API，也不要让客户端执行高权限工具。流适合进度体验，最终业务状态应由服务端结构化接口确认。来源：[AI SDK UI](https://ai-sdk.dev/docs/ai-sdk-ui)、[AI SDK tools](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)。
- 不要把 guardrail 当作事实核验或行程优化器；它主要负责拒绝/终止不满足条件的输入、输出或工具调用，事实新鲜度仍需搜索、来源和确定性校验。来源：[Guardrails](https://openai.github.io/openai-agents-python/guardrails/)。

## 7. 版本核验清单

在编码前固定依赖版本，并重新核对：OpenAI Agents SDK 的 session 持久化接口、handoff 输入过滤和 tracing 的敏感数据设置；Responses API 的 conversation/response retention 语义；LangGraph checkpointer、interrupt 恢复和 stream event schema；AI SDK 的 UI transport 与 tool approval 行为。上述页面属于滚动文档，本文链接用于追溯事实，不应替代针对锁定版本的 API 测试。

## 8. 高德地图官方资料

### 8.1 Key、安全和调用边界

- 高德 JS API 2.0 的加载文档要求使用 Web 端 Key；开启安全密钥机制时，页面加载需要与 Key 配套的 `securityJsCode`，官方同时提供安全密钥的安全加载/代理方案。来源：[JS API 2.0 - 加载地图](https://lbs.amap.com/api/jsapi-v2/guide/abc/load)、[JS API 2.0 - 使用安全密钥](https://lbs.amap.com/api/jsapi-v2/guide/abc/prepare)。本文不记录用户提供的实际 Key 或 security code。
- 高德 Web 服务使用独立的 Key 创建/管理流程，且接口通过 HTTP 请求访问；Web 服务文档将服务端 Key、配额和接口权限作为项目配置的一部分。来源：[Web 服务 - 获取 Key](https://lbs.amap.com/api/webservice/guide/create-project/get-key)、[Web 服务 API 概览](https://lbs.amap.com/api/webservice/summary)。因此，行程 agent 的 POI 搜索、路线距离矩阵等服务端调用应使用服务端 Web Service Key，通过后端工具代理；浏览器只使用受限的 JS API Web Key。不要把 Web Service Key 或 security code 放进前端 bundle、聊天消息或 itinerary。
- 具体 Key 类型、域名白名单、IP 白名单和安全密钥行为受高德控制台及接口版本影响；上线前应以控制台和当前官方“安全密钥”页面为准，而不是把示例配置当作安全策略。来源：[JS API 2.0 安全指南](https://lbs.amap.com/api/jsapi-v2/guide/abc/prepare)、[Web 服务 Key 管理](https://lbs.amap.com/api/webservice/guide/create-project/get-key)。

### 8.2 地点搜索、路线规划和定位

- JS API 2.0 的地点搜索服务包括关键字搜索、周边搜索和多边形搜索等能力，并返回 POI 结果供地图展示。来源：[JS API 2.0 - 地点搜索](https://lbs.amap.com/api/jsapi-v2/guide/services/search)。对 travel-agent 的约束是：模型只生成受 schema 约束的查询条件（城市、关键字、类型、范围）；后端/地图 SDK 负责请求、分页、去重和结果字段归一化。
- Web 服务提供 POI 关键字搜索/周边搜索接口，适合服务端 agent tool；官方接口文档定义了关键字、城市、类型、分页等参数及返回结构。来源：[Web 服务 - POI 搜索](https://lbs.amap.com/api/webservice/guide/api-advanced/search)。如果官方路径发生版本调整，应在实现前按 Web 服务 API 导航重新确认 URL，不应由模型拼接任意 URL。
- JS API 2.0 的路线规划服务涵盖驾车、步行、骑行、公交等导航/路线能力；路线结果可以在地图上绘制。来源：[JS API 2.0 - 路径规划](https://lbs.amap.com/api/jsapi-v2/guide/map/navigation)、[JS API 2.0 - 驾车路线规划](https://lbs.amap.com/api/jsapi-v2/guide/route/route)。行程排序不能只依赖模型常识：应先取得高德路线/耗时事实，再由确定性规则检查单日步行/交通时间预算。
- JS API 2.0 提供浏览器定位插件，定位结果受浏览器权限、HTTPS、设备和实现方式影响。来源：[JS API 2.0 - 定位](https://lbs.amap.com/api/jsapi-v2/guide/services/geolocation)。MVP 应允许用户手动选择城市/起点，定位失败不能阻塞规划；定位坐标也不应被默认写入长期用户记忆。

### 8.3 坐标系和数据一致性

- 高德地图使用 GCJ-02 坐标系；官方坐标转换 Web 服务用于在不同坐标系之间转换，并要求明确输入坐标类型。来源：[Web 服务 - 坐标转换](https://lbs.amap.com/api/webservice/guide/api/convert)、[坐标体系说明](https://lbs.amap.com/api/webservice/guide/api/georegeo)。因此 itinerary 的地点实体应保存 `lng`、`lat` 以及 `coordinate_system`/来源，不要把经纬度当作无来源的普通数字。
- 地理编码/逆地理编码是地址和坐标之间的转换，不等于 POI 搜索或路线规划。来源：[Web 服务 - 地理编码/逆地理编码](https://lbs.amap.com/api/webservice/guide/api/geocode)、[Web 服务 - 逆地理编码](https://lbs.amap.com/api/webservice/guide/api/georegeo)。模型需要“一个景点”“一段地址”“一组坐标”时，应使用不同工具契约，避免把地址字符串直接当作路线起终点。

### 8.4 对本项目的直接限制

- 地图 UI 可以在前端调用 JS API 2.0，但 POI、路线、地理编码等 agent 工具应在后端封装并审计；前端传入的地点 ID、坐标和路线参数必须再次校验。依据：[JS API 加载/安全](https://lbs.amap.com/api/jsapi-v2/guide/abc/load)、[Web 服务 Key](https://lbs.amap.com/api/webservice/guide/create-project/get-key)。
- 地图绘制使用的是“已确认的路线事实”，不是模型输出的地点名称列表；地点匹配失败、路线不可达、开放时间不确定都应作为结构化 warning 返回给 planner/前端。依据：[POI 搜索](https://lbs.amap.com/api/jsapi-v2/guide/services/search)、[路径规划](https://lbs.amap.com/api/jsapi-v2/guide/map/navigation)。
- 不要在代码、日志、tracing、截图或研究文档中写入真实 Key/security code；凭据应由部署环境注入并按 Key 类型分别限制域名/IP/配额。依据：[JS API 安全密钥](https://lbs.amap.com/api/jsapi-v2/guide/abc/prepare)、[Web 服务 Key](https://lbs.amap.com/api/webservice/guide/create-project/get-key)。
