/**
 * 无状态 MCP（Streamable HTTP，只回 application/json，不开 SSE）。
 * 每个 POST /mcp 是一条 JSON-RPC 消息；身份同样来自 CF Access。
 */
import { leaseMs, parseStatuses, type ListFilter, type Tasks } from "./tasks";
import { ApiError, type Actor } from "./types";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Todo Hub：人和多个 Agent 共用的任务队列。
工作流（Agent）：
1. claim_next_task 领一个任务（没有任务就结束本轮）。
2. 认真读 description 和 acceptance；用 get_task 看事件流里的历史评论 / 上次 review 的驳回意见。
3. 干活期间，每 10~15 分钟调用一次 heartbeat，否则 30 分钟后租约过期，任务会被别人领走。
4. 缺信息时不要瞎猜：ask_human 提问后结束本轮，人回答后任务会回到队列，下次你还会领到它。
5. 做完后 submit_for_review，附交付说明和 PR / commit / 预览链接。不能自己把任务标成完成。
6. 干活时发现的新问题用 create_task 记下来，它会成为提案，等人批准。
7. 做不了就 release_task 并说明原因。`;

type Json = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  humanOnly?: boolean;
  run: (svc: Tasks, a: Json, actor: Actor) => Promise<unknown>;
}

const id = { type: "string", description: "任务 ID" };
const lease = { type: "number", description: "租约秒数，默认 1800，范围 60~14400" };
const artifacts = {
  type: "array",
  items: {
    type: "object",
    properties: {
      kind: { type: "string", description: "pr / commit / preview / url" },
      url: { type: "string" },
      note: { type: "string" },
    },
    required: ["url"],
  },
};
const taskFields = {
  title: { type: "string" },
  description: { type: "string", description: "Markdown，写清背景" },
  acceptance: { type: "string", description: "验收标准" },
  project: { type: "string", description: "如 homepage / blog / infra" },
  priority: { type: "integer", minimum: 0, maximum: 3, description: "0 紧急 … 3 有空再说，默认 2" },
  assignee: { type: ["string", "null"], description: "指派给哪个 actor；null = 谁都能领" },
  due_at: { type: ["string", "null"], description: "ISO 日期" },
  depends_on: { type: "array", items: { type: "string" }, description: "依赖的任务 ID" },
};
const obj = (properties: Json, required: string[] = []) => ({ type: "object", properties, required });

const TOOLS: Tool[] = [
  {
    name: "whoami",
    description: "返回当前调用者的 actor 信息",
    inputSchema: obj({}),
    run: async (_s, _a, actor) => ({ id: actor.id, kind: actor.kind, display_name: actor.display_name }),
  },
  {
    name: "list_tasks",
    description: "列出任务。claimable=true 只返回你现在能领的",
    inputSchema: obj({
      status: { type: "array", items: { type: "string", enum: ["proposed", "todo", "claimed", "blocked", "review", "done", "cancelled"] } },
      assignee: { type: "string", description: "actor ID；'none' 表示未指派" },
      project: { type: "string" },
      claimable: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    }),
    run: (s, a) => {
      const f: ListFilter = {
        status: Array.isArray(a.status) ? parseStatuses(a.status.join(",")) : undefined,
        assignee: a.assignee === "none" ? null : (a.assignee as string | undefined),
        project: a.project as string | undefined,
        claimable: a.claimable === true,
        limit: a.limit as number | undefined,
      };
      return s.list(f);
    },
  },
  {
    name: "get_task",
    description: "任务详情，含依赖、事件流（评论、提问、驳回意见）和交付物",
    inputSchema: obj({ id }, ["id"]),
    run: (s, a) => s.detail(a.id as string),
  },
  {
    name: "claim_next_task",
    description: "原子地领取下一个最合适的任务（你已持有的 > 指派给你的 > 高优先级 > 早创建）。没有可领任务时返回 null",
    inputSchema: obj({ project: { type: "string", description: "只从这个项目领" }, lease_seconds: lease }),
    run: (s, a) => s.claimNext(a.project as string | undefined, leaseMs(a.lease_seconds)),
  },
  {
    name: "claim_task",
    description: "领取指定任务",
    inputSchema: obj({ id, lease_seconds: lease }, ["id"]),
    run: (s, a) => s.claim(a.id as string, leaseMs(a.lease_seconds)),
  },
  {
    name: "heartbeat",
    description: "续租。干活期间每 10~15 分钟调用一次",
    inputSchema: obj({ id, lease_seconds: lease }, ["id"]),
    run: (s, a) => s.heartbeat(a.id as string, leaseMs(a.lease_seconds)),
  },
  {
    name: "release_task",
    description: "放弃已领的任务，退回队列。请说明原因",
    inputSchema: obj({ id, note: { type: "string" } }, ["id"]),
    run: (s, a) => s.release(a.id as string, a.note),
  },
  {
    name: "ask_human",
    description: "缺信息、需要人决定时提问。任务转为 blocked 并通知人；人回答后回到队列，仍指派给你",
    inputSchema: obj({ id, question: { type: "string" } }, ["id", "question"]),
    run: (s, a) => s.block(a.id as string, a.question),
  },
  {
    name: "submit_for_review",
    description: "完成后提交验收。summary 写清做了什么、怎么验证；artifacts 附 PR / commit / 预览链接",
    inputSchema: obj({ id, summary: { type: "string" }, artifacts }, ["id", "summary"]),
    run: (s, a) => s.submit(a.id as string, a.summary, a.artifacts),
  },
  {
    name: "add_artifacts",
    description: "给你持有的任务追加交付物链接",
    inputSchema: obj({ id, artifacts }, ["id", "artifacts"]),
    run: (s, a) => s.addArtifacts(a.id as string, a.artifacts),
  },
  {
    name: "comment",
    description: "在任务上留言。人回复 blocked 任务时，任务会自动回到 todo",
    inputSchema: obj({ id, body: { type: "string" } }, ["id", "body"]),
    run: (s, a) => s.comment(a.id as string, a.body),
  },
  {
    name: "create_task",
    description: "新建任务。Agent 建的任务是提案（proposed），人批准后才进入队列",
    inputSchema: obj(taskFields, ["title"]),
    run: (s, a) => s.create(a),
  },
  {
    name: "update_task",
    description: "修改任务字段，需要传当前 version（乐观锁）。Agent 只能改自己的提案",
    inputSchema: obj({ id, version: { type: "integer" }, ...taskFields }, ["id", "version"]),
    run: (s, a) => {
      const { id: tid, version, ...rest } = a;
      return s.update(tid as string, rest, version);
    },
  },
  {
    name: "cancel_task",
    description: "取消任务。Agent 只能撤回自己的提案",
    inputSchema: obj({ id, reason: { type: "string" } }, ["id"]),
    run: (s, a) => s.cancel(a.id as string, a.reason),
  },
  // ---- 只有人能用 ----
  {
    name: "accept_proposal",
    description: "批准 Agent 提议的任务，放入队列",
    inputSchema: obj({ id, note: { type: "string" } }, ["id"]),
    humanOnly: true,
    run: (s, a) => s.accept(a.id as string, a.note),
  },
  {
    name: "approve_task",
    description: "验收通过",
    inputSchema: obj({ id, note: { type: "string" } }, ["id"]),
    humanOnly: true,
    run: (s, a) => s.approve(a.id as string, a.note),
  },
  {
    name: "reject_task",
    description: "验收不通过，附意见，退回给原 Agent",
    inputSchema: obj({ id, feedback: { type: "string" } }, ["id", "feedback"]),
    humanOnly: true,
    run: (s, a) => s.reject(a.id as string, a.feedback),
  },
  {
    name: "complete_task",
    description: "直接标记完成（人自己的任务，不走 review）",
    inputSchema: obj({ id, note: { type: "string" } }, ["id"]),
    humanOnly: true,
    run: (s, a) => s.complete(a.id as string, a.note),
  },
  {
    name: "reopen_task",
    description: "重新打开已完成 / 已取消的任务",
    inputSchema: obj({ id, reason: { type: "string" } }, ["id"]),
    humanOnly: true,
    run: (s, a) => s.reopen(a.id as string, a.reason),
  },
];

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Json;
}

const rpcResult = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function handleMcp(req: Request, svc: Tasks, actor: Actor): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  let msg: RpcRequest;
  try {
    msg = await req.json();
  } catch {
    return Response.json(rpcError(null, -32700, "parse error"), { status: 400 });
  }
  if (Array.isArray(msg)) return Response.json(rpcError(null, -32600, "batching not supported"), { status: 400 });
  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return Response.json(rpcError(null, -32600, "invalid request"), { status: 400 });
  }
  // 通知 / 响应：无需回复
  if (msg.id === undefined) return new Response(null, { status: 202 });

  const visible = TOOLS.filter((t) => !t.humanOnly || actor.kind === "human");

  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion as string | undefined;
      return Response.json(
        rpcResult(msg.id, {
          protocolVersion: asked && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "todo-hub", version: "0.1.0" },
          instructions: INSTRUCTIONS,
        }),
      );
    }
    case "ping":
      return Response.json(rpcResult(msg.id, {}));
    case "tools/list":
      return Response.json(
        rpcResult(msg.id, {
          tools: visible.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        }),
      );
    case "tools/call": {
      const name = msg.params?.name as string;
      const tool = visible.find((t) => t.name === name);
      if (!tool) return Response.json(rpcError(msg.id, -32602, `unknown tool: ${name}`));
      const args = (msg.params?.arguments ?? {}) as Json;
      try {
        const out = await tool.run(svc, args, actor);
        return Response.json(rpcResult(msg.id, { content: [{ type: "text", text: JSON.stringify(out ?? null, null, 2) }] }));
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        // 业务错误作为工具结果返回，让模型能看到并自行处理
        const text = JSON.stringify({ error: e.code, message: e.message, task: e.task }, null, 2);
        return Response.json(rpcResult(msg.id, { content: [{ type: "text", text }], isError: true }));
      }
    }
    default:
      return Response.json(rpcError(msg.id, -32601, `method not found: ${msg.method}`));
  }
}
