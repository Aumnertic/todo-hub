import { Hono, type Context } from "hono";
import { authenticate } from "./auth";
import { handleMcp } from "./mcp";
import { sendDigest, sendNotice } from "./notify";
import { leaseMs, parseStatuses, Tasks, type Notice } from "./tasks";
import { ApiError, type Actor, type Env } from "./types";

type AppEnv = { Bindings: Env; Variables: { actor: Actor; tasks: Tasks } };

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message }, ...(err.task ? { task: err.task } : {}) }, err.status as 400);
  }
  console.error(err);
  return c.json({ error: { code: "internal", message: "internal error" } }, 500);
});

app.get("/healthz", (c) => c.text("ok"));

app.use("*", async (c, next) => {
  const actor = await authenticate(c.req.raw, c.env);
  const notify = (n: Notice) => c.executionCtx.waitUntil(sendNotice(c.env, n));
  c.set("actor", actor);
  c.set("tasks", new Tasks(c.env.DB, actor, notify));
  await next();
});

async function body(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw new ApiError(400, "bad_request", "body must be a JSON object");
  }
}

// ---- MCP ----
app.all("/mcp", (c) => handleMcp(c.req.raw, c.var.tasks, c.var.actor));

// ---- REST ----
const v1 = new Hono<AppEnv>();

v1.get("/me", (c) => {
  const { id, kind, display_name, email } = c.var.actor;
  return c.json({ id, kind, display_name, email });
});

v1.get("/actors", async (c) => c.json({ actors: await c.var.tasks.actors() }));

v1.get("/tasks", async (c) => {
  const q = c.req.query();
  const filter = {
    status: parseStatuses(q.status),
    assignee: q.assignee === "none" ? null : q.assignee,
    project: q.project,
    created_by: q.created_by,
    claimable: q.claimable === "1" || q.claimable === "true",
    limit: q.limit ? Number(q.limit) : undefined,
  };
  const expand = q.expand === "1" || q.expand === "true";
  const tasks = expand ? await c.var.tasks.listExpanded(filter) : await c.var.tasks.list(filter);
  return c.json({ tasks });
});

v1.post("/tasks", async (c) => c.json(await c.var.tasks.create(await body(c)), 201));

v1.get("/tasks/:id", async (c) => c.json(await c.var.tasks.detail(c.req.param("id"))));

v1.patch("/tasks/:id", async (c) => {
  const b = await body(c);
  const ifMatch = c.req.header("If-Match");
  const version = ifMatch ? Number(ifMatch.replace(/"/g, "")) : b.version;
  delete b.version;
  return c.json(await c.var.tasks.update(c.req.param("id"), b, version));
});

v1.post("/claim-next", async (c) => {
  const b = await body(c);
  const task = await c.var.tasks.claimNext(c.req.query("project") ?? (b.project as string | undefined), leaseMs(b.lease_seconds));
  return task ? c.json(task) : c.body(null, 204);
});

v1.post("/tasks/:id/claim", async (c) => {
  const b = await body(c);
  return c.json(await c.var.tasks.claim(c.req.param("id"), leaseMs(b.lease_seconds)));
});

v1.post("/tasks/:id/heartbeat", async (c) => {
  const b = await body(c);
  return c.json(await c.var.tasks.heartbeat(c.req.param("id"), leaseMs(b.lease_seconds)));
});

v1.post("/tasks/:id/release", async (c) => c.json(await c.var.tasks.release(c.req.param("id"), (await body(c)).note)));
v1.post("/tasks/:id/block", async (c) => c.json(await c.var.tasks.block(c.req.param("id"), (await body(c)).question)));
v1.post("/tasks/:id/submit", async (c) => {
  const b = await body(c);
  return c.json(await c.var.tasks.submit(c.req.param("id"), b.summary, b.artifacts));
});
v1.post("/tasks/:id/artifacts", async (c) =>
  c.json({ artifacts: await c.var.tasks.addArtifacts(c.req.param("id"), (await body(c)).artifacts) }, 201),
);
v1.post("/tasks/:id/comments", async (c) => c.json(await c.var.tasks.comment(c.req.param("id"), (await body(c)).body)));

v1.post("/tasks/:id/accept", async (c) => c.json(await c.var.tasks.accept(c.req.param("id"), (await body(c)).note)));
v1.post("/tasks/:id/approve", async (c) => c.json(await c.var.tasks.approve(c.req.param("id"), (await body(c)).note)));
v1.post("/tasks/:id/reject", async (c) => c.json(await c.var.tasks.reject(c.req.param("id"), (await body(c)).feedback)));
v1.post("/tasks/:id/complete", async (c) => c.json(await c.var.tasks.complete(c.req.param("id"), (await body(c)).note)));
v1.post("/tasks/:id/cancel", async (c) => c.json(await c.var.tasks.cancel(c.req.param("id"), (await body(c)).reason)));
v1.post("/tasks/:id/reopen", async (c) => c.json(await c.var.tasks.reopen(c.req.param("id"), (await body(c)).reason)));

app.route("/v1", v1);
app.notFound((c) => c.json({ error: { code: "not_found", message: "no such route" } }, 404));

// ---- 定时任务 ----
const SYSTEM: Actor = { id: "system", kind: "system", display_name: "System", email: null, access_client_id: null, active: 1 };

export async function runScheduled(cron: string, env: Env) {
  const svc = new Tasks(env.DB, SYSTEM);
  if (cron === "0 1 * * *") {
    await sendDigest(env, await svc.digest());
  } else {
    const expired = await svc.expireLeases();
    if (expired.length) console.log(JSON.stringify({ msg: "leases expired", ids: expired.map((t) => t.id) }));
  }
}

export default {
  fetch: app.fetch,
  scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(event.cron, env));
  },
} satisfies ExportedHandler<Env>;
