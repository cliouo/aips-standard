# `@refract/core` — Refract 参考实现

TypeScript 实现的 Refract 标准核心库。STANDARD.md 把规范写成了文字契约，这里把它编译成了**可调用的 API**。

> 关系：上一级目录的 [`../STANDARD.md`](../STANDARD.md) 是规范；本目录是它的一个具体实现。读规范是了解"为什么"，读代码是了解"怎么做"。

## 这一层做了什么

把规范里的每一条 MUST/SHOULD 翻译成代码：

- 你**只写业务**（每个 Action 的 handler）
- 库**自动**接入 schema 校验、确认握手、幂等去重、审计日志、脱敏、注入隔离、never-list 拦截、计划状态机……
- 从同一份 Action 注册表**自动派生**：REST 端点、Claude tool_use schema、SKILL.md、CLI 命令规格、MCP server、OpenAPI 3.1、§21 透明度端点

加一个新 Action = 改一个文件，所有派生物自动跟上。

---

## 上手 60 秒

```bash
npm install
npm run dev
```

然后试每个端点：

```bash
# 列出所有 actions
curl http://localhost:3000/api/v1/actions

# 调用一个读操作（无需确认）
curl -X POST http://localhost:3000/api/v1/actions/list-customers \
     -H 'Content-Type: application/json' -H 'X-User-Id: u_demo' \
     -d '{"limit":2}'

# 调用写操作 — 第一步会得到 409 + confirmation_token
curl -X POST http://localhost:3000/api/v1/actions/invite-team-member \
     -H 'Content-Type: application/json' -H 'X-User-Id: u_demo' \
     -H 'Idempotency-Key: abc-123' \
     -d '{"email":"alice@example.com","role":"member"}'

# 第二步 — 带 token 重发，真正执行
curl -X POST http://localhost:3000/api/v1/actions/invite-team-member \
     -H 'Content-Type: application/json' -H 'X-User-Id: u_demo' \
     -H 'Idempotency-Key: abc-123' \
     -H 'X-Confirmation-Token: <token from step 1>' \
     -d '{"email":"alice@example.com","role":"member"}'

# 看派生物
curl http://localhost:3000/api/v1/openapi.json       # OpenAPI 3.1
curl http://localhost:3000/api/v1/tools.json         # Claude tool_use schema
curl http://localhost:3000/api/v1/skills/team.md     # SKILL.md
curl http://localhost:3000/api/v1/cli-spec.json      # CLI codegen 输入

# §21 透明度 UI（浏览器打开）
open http://localhost:3000/transparency
```

---

## 可用脚本

| 命令 | 干什么 |
|---|---|
| `npm test` | 跑 55 个单元测试（vitest） |
| `npm run typecheck` | 严格模式 tsc 检查 |
| `npm run dev` | Express 服务（HTTP / OpenAPI / SKILL / 透明度） |
| `npm run demo` | 模拟一轮 AI 对话，串通 confirmation flow |
| `npm run demo:plan` | 多步 plan + disambiguation 演示 |
| `npm run eval` | AI 触发命中率回归（mock LLM） |
| `npm run mcp` | MCP stdio 服务，喂给 Claude Desktop 等客户端 |

---

## 写一个新 Action

这是日常工作的样子：

```typescript
// actions/your-action.ts
import { z } from 'zod';
import { defineAction } from '@refract/core';
import type { PlatformAPI } from '../platform-api';

export const yourAction = defineAction({
  name: 'archive_project',                  // §4 snake_case verb_noun
  version: '1.0',
  description: '归档项目。用户说"归档 X"、"把 X 收起来"时使用。',
  domain: 'project',
  risk: 'write',                            // read | write | dangerous
  requiresConfirmation: true,
  rateLimit: { perUserPerHour: 30 },

  input: z.object({
    project_id: z.string(),
    reason: z.string().optional(),
  }),
  output: z.object({
    archived_at: z.string(),
  }),

  summary: (input) =>
    `将归档项目 ${input.project_id}。归档后可以恢复。`,

  examples: [
    { prompt: '归档 P-42', input: { project_id: 'P-42' } },
  ],

  async handler(ctx, input) {
    const api = ctx.api as PlatformAPI;
    if (!(await api.projects.exists(input.project_id))) {
      throw ctx.errors.notFound(`Project ${input.project_id}`);
    }
    await api.projects.archive(input.project_id, input.reason);
    return { archived_at: new Date().toISOString() };
  },

  async undo(ctx, { input }) {           // §21-B 可选撤销
    await (ctx.api as PlatformAPI).projects.unarchive(input.project_id);
  },
});
```

然后在 `server.ts` 里 `registry.register(yourAction)` 一行注册——REST、CLI 规格、Claude tool_use schema、OpenAPI、活动日志全部自动跟上。

---

## 目录结构

```
lib/
├── src/                          库的核心（消费者会 import 的代码）
│   ├── index.ts                  公共 API 出口
│   ├── errors.ts                 §8  错误码族（RefractError）
│   ├── types.ts                  §4  Action / Context / Delegation 类型
│   ├── define-action.ts          §4  defineAction() 入口 + spec 校验
│   ├── dispatcher.ts             §3  中间件链（顺序固定）
│   ├── registry.ts               §3  Action 注册表 + never-list lint
│   ├── stores.ts                 §6/7/14  内存版 confirmation/idempotency/rate-limit/loop
│   ├── redaction.ts              §11 用户视角的字段级脱敏
│   ├── never-list.ts             §12 AI 永不可触达的操作清单
│   ├── tool-output.ts            §10 Tool 返回的 prompt-injection 隔离
│   ├── plan.ts                   §17 多步 plan 状态机
│   ├── disambiguation.ts         §18 标准 disambiguate() 工具
│   ├── pre-llm.ts                §22 送 LLM 前的 PII 占位 + 区域路由
│   ├── aat.ts                    §13 IETF Agent Audit Trail (AAT) 原语：JCS+SHA-256 hash chain + 字段对齐
│   ├── audit-query.ts            §13/§21 AAT-backed 可查询审计
│   ├── context-decider.ts        §21-A 路由/角色 → 当前激活的 cards
│   ├── api-keys.ts               §21-B 用户 API key 全生命周期
│   ├── anomaly.ts                §21-C 滑动窗口异常检测
│   ├── evals.ts                  §19 评测套件（LLM 无关）
│   └── adapters/                 把核心暴露为不同前端的适配器
│       ├── rest.ts               REST: POST /api/v1/actions/<name>
│       ├── transparency.ts       §21 /me/* 和 /admin/* 端点
│       ├── claude-tools.ts       Claude tool_use schema + SKILL.md (v1) + CLI spec
│       ├── anthropic.ts          真 Claude LLMInvoker（mock 的 drop-in 替换）
│       ├── mcp.ts                MCP stdio server（跨客户端可移植）
│       ├── a2a.ts                §20.2 A2A protocol server（AgentCard + SendMessage/GetTask/ListTasks）
│       └── openapi.ts            OpenAPI 3.1 spec 生成器
│
├── example/                      可运行示例（模拟 Acme 平台）
│   ├── platform-api.ts           假的"现有服务层"
│   ├── actions/                  示例 Action（读、写、带 undo）
│   │   ├── list-customers.ts
│   │   └── invite-team-member.ts
│   ├── mock-llm.ts               确定性的 mock LLM
│   ├── server.ts                 Express server                  → `npm run dev`
│   ├── chat-loop.ts              AI tool_use 单轮 demo            → `npm run demo`
│   ├── plan-demo.ts              多步 plan + disambig demo        → `npm run demo:plan`
│   ├── eval.ts                   eval 套件入口                    → `npm run eval`
│   ├── mcp-server.ts             MCP server 入口                  → `npm run mcp`
│   └── transparency.html         零框架的 §21 UI 演示             → /transparency
│
└── test/                         vitest 单元测试（55 个 case）
    ├── helpers.ts                共享 fixture
    ├── define-action.test.ts     §4 spec 校验
    ├── dispatcher.test.ts        §6/§7/§13/§14 流程
    ├── never-list.test.ts        §12 注册时 + 派发时双层
    ├── plan.test.ts              §17 状态机
    ├── pre-llm.test.ts           §22 占位 / 反向恢复
    ├── transparency.test.ts      §21 audit/keys/decider/anomaly
    ├── aat.test.ts               §13 AAT hash chain + tampering detection
    ├── spotlight.test.ts         §10 delimit/datamark/encode 模式
    ├── skill-md.test.ts          Agent Skills v1 name validator
    └── openapi.test.ts           OpenAPI 发射
```

---

## STANDARD.md 实现覆盖率

| 节 | 状态 | 实现位置 |
|---|---|---|
| §3 中间件链固定顺序 | ✅ | `dispatcher.ts` |
| §4 Action Spec 校验 | ✅ | `define-action.ts` |
| §5 Delegation 身份 | ✅ | `rest.ts` `parseDelegation()` |
| §6 Confirmation 契约 | ✅ | `dispatcher.ts` + `stores.ts` |
| §7 Idempotency | ✅ | `MemoryIdempotencyStore` |
| §8 Error 分类 | ✅ | `errors.ts` |
| §9 Output 协议 | ⚠️ | 依赖 per-action output schema 自觉 |
| §10 Spotlighting (Hines 2024) | ✅ | `tool-output.ts`（delimit/datamark/encode） |
| §11 用户脱敏 | ✅ | `redaction.ts` + dispatcher hook |
| §12 Never-List | ✅ | `never-list.ts` |
| §13 审计日志（**AAT 对齐**） | ✅ | `aat.ts` (JCS+SHA-256 hash chain) + `audit-query.ts` |
| §14 失控保护 | ✅ | rate-limiter + loop detector |
| §15 版本 / 弃用 | ✅ | `rest.ts` X-Deprecated 头 |
| §16 CLI/Skill 生命周期（**Agent Skills v1**） | ✅ | `toCLISpec` + `toSkillMarkdown` + `validateSkillName` |
| §17 Plans & checkpoints | ✅ | `plan.ts` + dispatcher 跳过逻辑 |
| §18 Disambiguation | ✅ | `disambiguation.ts` + 标准 action |
| §19 Eval 套件 | ✅ | `evals.ts` |
| §20 跨客户端可移植 | ✅ | REST + Claude tools + SKILL.md v1 + **MCP** + **A2A** + OpenAPI |
| §21 透明度（数据层） | ✅ | `audit-query` + `context-decider` + `api-keys` + `anomaly` + `transparency.ts` |
| §22 数据出境 / PII shield | ✅ | `pre-llm.ts` (PIIVault + RegionRouter) |
| §23 跨入口连续性 | ⚠️ | 同一审计流；UI 联动留给消费者 |

---

## 上生产前要替换的内容

参考实现里的所有 `Memory*` 都是**内存版**，重启就丢，绝对不要直接上生产。要替换：

| 组件 | 推荐生产实现 |
|---|---|
| `MemoryIdempotencyStore` | Redis（24h TTL）或 PG 表 |
| `MemoryConfirmationStore` | Redis（≤ 5min TTL） |
| `MemoryRateLimiter` | Redis 令牌桶 / 滑动窗口 |
| `MemoryLoopDetector` | 进程内 LRU per session（其实可以直接用） |
| `MemoryAuditStore` | append-only DB / Kafka / S3 |
| `MemoryAPIKeyStore` | DB 表 + secret 哈希列 + 索引 |
| `ConsoleAuditLogger` | 别用，换 audit store |

`ContextFactory` 也要从 demo 里硬编码的 `'u_demo'` 换成你真实的 session / API-key 解析。

---

## 设计选择的 FAQ

**为什么用 Zod 而不是手写 JSON Schema？**
TypeScript 的类型推导 + 运行时校验同源，写一份就有两个用途。需要 JSON Schema 时通过 `zod-to-json-schema` 派生。

**为什么 dispatcher 把所有中间件强制成固定顺序？**
§3 规范要求。让中间件可插拔的代价是顺序漂移，导致比如审计在确认之前被绕过——这种 bug 极难发现。

**Action 的 generic 为什么是 `<TI, TO>`（schema 类型）而不是 `<I, O>`（数据类型）？**
Zod 的 `.default()`、`.optional()` 等让 input/output 数据类型不一致；schema-as-generic + `z.infer<>` 是社区惯用法。

**为什么不直接用 MCP，要自己定一套 Action 层？**
MCP 只解决"工具发现 + 调用"，不解决确认契约、幂等、审计、never-list、计划状态机等。Refract 在 MCP 之上，且 MCP 是 Refract 的一个**可选**输出格式。
