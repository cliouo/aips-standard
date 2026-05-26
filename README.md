# Refract

> 一份 Action 定义，折射成 N 种 AI 入口

Web 平台集成 AI 助理的契约 + 可运行 TypeScript 参考实现。

如果你正在给一个已有的 Web 平台加 AI 集成，并且要同时支持多种 AI 消费者：

- **Embedded** — 平台内置助理（右下角聊天框，平台自有 LLM）
- **Terminal** — 用户的 Claude Code / Cursor / Codex / Claude Desktop（SKILL.md + CLI 或 MCP，用户端 LLM）
- **Server-to-Server** — Salesforce Agentforce / IBM watsonx Orchestrate / Sierra / Google ADK 等（A2A，调用方公司的 agent）
- **未来未知** — 语音 agent、浏览器扩展、OS 级 agent、IoT 设备…

Refract 让你把 100+ REST 接口收敛成 20-40 个稳定的 Action，一份定义自动折射出 REST / MCP / A2A / SKILL.md / Claude tool_use schema / CLI / OpenAPI 等所有消费 surface。新增入口类型 = 加一个 ~300 行 adapter，业务逻辑不动。

---

## 仓库内容

```
refract/
├── STANDARD.md       规范文档（27 节 + 4 附录，遵循 RFC 2119 MUST/SHOULD/MAY）
└── lib/              TypeScript 参考实现（可运行、有测试）
```

两份产物相互独立：

| | 用途 | 谁会读 |
|---|---|---|
| **STANDARD.md** | 不依赖具体技术栈的规范文字 | 架构师、安全 / 合规、其他语言的实现者 |
| **lib/** | TypeScript 的具体落地，证明 STANDARD 可实现 | 想直接拿去改的工程团队 |

可以单独读 STANDARD.md 在 Go/Python/Rust 里自己实现；也可以直接 fork `lib/` 改成你的业务。

---

## 30 秒快速预览

```bash
cd lib
npm install
npm test           # 85 个单元测试
npm run demo       # 端到端 AI 对话（含 confirmation flow）
npm run demo:plan  # 多步 plan + disambiguation
npm run eval       # AI 触发命中率回归测试
npm run dev        # HTTP 服务（含 OpenAPI、SKILL.md、tool_use schema 端点）
npm run mcp        # MCP stdio 服务（外部 AI 客户端接入）
```

`npm run dev` 启动后访问 <http://localhost:3000/transparency> 看 §21 透明度 UI demo。

---

## 标准的 5 个核心机制

读 STANDARD.md 之前的导览：

1. **Action 层**（§4）—— 业务逻辑的最小单元。100+ REST API 收敛成 20-40 个面向意图的 Action。所有入口（平台内 / 外部 CLI / 跨公司 agent / 未来类型）都走同一层。

2. **Confirmation 契约**（§6）—— 写操作的两步握手。AI 第一次调用返回 `409 PENDING_CONFIRMATION` + 自然语言 summary；用户在 UI 同意后，重发请求带 token 才真正执行。**服务端强制**，不靠前端自觉。

3. **Never-List**（§12）—— 一组操作永远不让 AI 调用，无论用户怎么同意。代码层硬拦截（注册时 + 派发时双层）。

4. **审计 + 透明度**（§13 / §21）—— 每次 AI 触发的动作必留可查日志；用户随时能看自己的 AI 活动、撤销、吊销 API key；管理员能看全组织流 + 异常告警。

5. **跨客户端可移植**（§20）—— 同一份 Action 注册表能产出：REST 端点、Claude tool_use schema、MCP server、SKILL.md、CLI 命令、OpenAPI 3.1。任何 AI 客户端都能接入。

---

## 交互模型四正交轴（§24-§27）

入口（谁调用）之外，Refract 还把"Action 层如何被消费"形式化成四根正交的轴：

| 轴 | 取值 | 决定什么 |
|---|---|---|
| **执行形状**（§24） | Deterministic / Generative Action · Bounded Agent · Open Assistant | AI 和 Action 层的关系（一步 / 司机）、套哪些护栏 |
| **操作权姿态**（§25） | 自动驾驶 ↔ 副驾 | 谁是操作者；驱动渲染面 + 确认护栏强度 |
| **结果呈现**（§26） | 结构化数据 → 可信组件（卡片 / 驱动页 / 深链） | 结果怎么渲染；**禁渲染模型产的 HTML/MD** |
| **执行时序**（§27） | 同步内联 ↔ 异步后台 | 由耗时决定；慢任务必异步 + pending 落库 + 通知 |

`kind` / `provenance`（§24）已落进参考实现的 `defineAction`，示例见 [`lib/example/actions/generate-report.ts`](./lib/example/actions/generate-report.ts)。

---

## 这是个 spec 而不是产品

- **它给的是**：经过设计推理的接口契约 + 可借鉴的实现骨架
- **它不给的**：你的具体业务逻辑、UI 组件、生产级 store 实现、运维方案
- **状态**：v0.1 草案，欢迎在生产中试用后回报问题

详细规范请读 [`STANDARD.md`](./STANDARD.md)；上手实现请进 [`lib/`](./lib/)。

---

## 与已有 spec 的关系（不重新发明轮子）

Refract 是 **integration profile**，不是孤立标准。它在以下成熟工作之上做 MUST 级集成约束：

| Refract 节 | 上游 spec | 关系 |
|---|---|---|
| §13 审计 | IETF [`draft-sharif-agent-audit-trail`](https://datatracker.ietf.org/doc/draft-sharif-agent-audit-trail/) | **直接采纳**字段集 + JCS+SHA-256 hash chain |
| §10 注入隔离 | [Hines et al. "Spotlighting"](https://arxiv.org/abs/2403.14720) (Microsoft, 2024) | **直接采纳** delimit/datamark/encode 三模式 |
| §16 SKILL.md | [Anthropic Agent Skills v1](https://agentskills.io/specification) | 派生物完全 v1 compliant |
| §20.1 MCP | [Model Context Protocol](https://modelcontextprotocol.io) | 最小合规 server + 写操作的 confirmation_token 约定 |
| §20.2 A2A | [A2A Protocol](https://a2a-protocol.org) | AgentCard + SendMessage/GetTask/ListTasks |
| §6 confirmation | IETF [`draft-rosenberg-cheq`](https://datatracker.ietf.org/doc/html/draft-rosenberg-cheq-00) | 草案仍 skeleton 阶段；Refract 自主 wire format 并预留 CHEQ URI Pack 占位 |

**Refract 自身的增量**：双入口共享 Action 层 / 单一定义派生 6 surface / 把上述 spec 用 MUST 级规则绑成集成包 / §21 透明度三 surface / §18 disambiguation 协议。详见 [STANDARD.md §0.1](./STANDARD.md#01-与上游-spec-的关系prior-art--upstream-alignment)。

---

## 设计来源

借鉴了：
- Anthropic Claude Code 的 Skill / Permission 模型
- Model Context Protocol (MCP) 的 tool discovery 模式
- Stripe API 的 idempotency-key 设计
- OpenAPI 3.1 的描述格式
- RFC 2119 的规范措辞
