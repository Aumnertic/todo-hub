import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runScheduled } from "../src/index";
import { call, grok, me, muse, newTask } from "./helpers";

const events = async (id: string) => (await me.get(`/v1/tasks/${id}`)).json.events.map((e: { type: string }) => e.type);

describe("auth", () => {
  it("rejects requests without identity", async () => {
    expect((await call(null, "GET", "/v1/me")).status).toBe(401);
  });
  it("rejects unknown and inactive actors", async () => {
    expect((await call("nobody", "GET", "/v1/me")).status).toBe(403);
    expect((await call("retired", "GET", "/v1/me")).status).toBe(403);
    expect((await call("system", "GET", "/v1/me")).status).toBe(403);
  });
  it("identifies the caller", async () => {
    expect((await muse.get("/v1/me")).json).toMatchObject({ id: "muse", kind: "agent" });
  });
});

describe("proposals", () => {
  it("human-created tasks are todo, agent-created are proposed", async () => {
    expect((await newTask()).status).toBe("todo");
    const p = await muse.post("/v1/tasks", { title: "RSS is broken", project: "blog" });
    expect(p.status).toBe(201);
    expect(p.json.status).toBe("proposed");
  });

  it("proposals cannot be claimed until a human accepts", async () => {
    const p = (await muse.post("/v1/tasks", { title: "x" })).json;
    expect((await grok.post(`/v1/tasks/${p.id}/claim`)).json.error.code).toBe("not_accepted");
    expect((await muse.post(`/v1/tasks/${p.id}/accept`)).status).toBe(403);
    expect((await me.post(`/v1/tasks/${p.id}/accept`)).json.status).toBe("todo");
    expect((await grok.post(`/v1/tasks/${p.id}/claim`)).json.status).toBe("claimed");
  });

  it("agents can edit and withdraw only their own proposals", async () => {
    const p = (await muse.post("/v1/tasks", { title: "x" })).json;
    expect((await grok.patch(`/v1/tasks/${p.id}`, { title: "y", version: p.version })).status).toBe(403);
    expect((await muse.patch(`/v1/tasks/${p.id}`, { title: "y", version: p.version })).json.title).toBe("y");
    expect((await grok.post(`/v1/tasks/${p.id}/cancel`)).status).toBe(403);
    expect((await muse.post(`/v1/tasks/${p.id}/cancel`)).json.status).toBe("cancelled");
    const t = await newTask();
    expect((await muse.post(`/v1/tasks/${t.id}/cancel`)).status).toBe(422);
  });
});

describe("claiming", () => {
  it("only one of two concurrent claims wins", async () => {
    const t = await newTask();
    const [a, b] = await Promise.all([muse.post(`/v1/tasks/${t.id}/claim`), grok.post(`/v1/tasks/${t.id}/claim`)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((a.status === 409 ? a : b).json.error.code).toBe("already_claimed");
  });

  it("re-claiming your own task is idempotent", async () => {
    const t = await newTask();
    await muse.post(`/v1/tasks/${t.id}/claim`);
    expect((await muse.post(`/v1/tasks/${t.id}/claim`)).status).toBe(200);
    expect((await events(t.id)).filter((e: string) => e === "claimed")).toHaveLength(1);
  });

  it("respects the assignee", async () => {
    const t = await newTask({ assignee: "muse" });
    expect((await grok.post(`/v1/tasks/${t.id}/claim`)).json.error.code).toBe("not_assignee");
    expect((await muse.post(`/v1/tasks/${t.id}/claim`)).status).toBe(200);
  });

  it("rejects unknown assignees", async () => {
    expect((await me.post("/v1/tasks", { title: "x", assignee: "retired" })).status).toBe(400);
  });

  it("claim-next prefers held, then assigned, then priority, then age; 204 when empty", async () => {
    const low = await newTask({ title: "low", priority: 3 });
    const high = await newTask({ title: "high", priority: 0 });
    const old = await newTask({ title: "old high", priority: 0 });
    const mine = await newTask({ title: "mine", priority: 3, assignee: "muse" });
    await newTask({ title: "grok's", priority: 0, assignee: "grok" });

    expect((await muse.post("/v1/claim-next")).json.id).toBe(mine.id);
    // 再次轮询：先拿回自己已持有的
    expect((await muse.post("/v1/claim-next")).json.id).toBe(mine.id);
    await me.post(`/v1/tasks/${mine.id}/complete`);

    // 未指派的按优先级、再按创建时间
    const order: string[] = [];
    for (;;) {
      const r = await muse.post("/v1/claim-next");
      if (r.status === 204) break;
      order.push(r.json.id);
      await me.post(`/v1/tasks/${r.json.id}/complete`);
    }
    expect(order).toEqual([high.id, old.id, low.id]); // grok's 不会给 muse
  });

  it("claim-next can filter by project", async () => {
    await newTask({ project: "blog" });
    const h = await newTask({ project: "homepage" });
    expect((await muse.post("/v1/claim-next?project=homepage")).json.id).toBe(h.id);
    expect((await muse.post("/v1/claim-next?project=nope")).status).toBe(204);
  });
});

describe("leases", () => {
  it("an expired lease can be taken over", async () => {
    const t = await newTask();
    await muse.post(`/v1/tasks/${t.id}/claim`);
    await env.DB.prepare("UPDATE tasks SET lease_until = 1 WHERE id = ?").bind(t.id).run();
    const r = await grok.post(`/v1/tasks/${t.id}/claim`);
    expect(r.json.claimed_by).toBe("grok");
    expect((await muse.post(`/v1/tasks/${t.id}/heartbeat`)).json.error.code).toBe("not_holder");
  });

  it("heartbeat extends the lease and only works for the holder", async () => {
    const t = await newTask();
    const c = (await muse.post(`/v1/tasks/${t.id}/claim`, { lease_seconds: 60 })).json;
    const h = (await muse.post(`/v1/tasks/${t.id}/heartbeat`, { lease_seconds: 3600 })).json;
    expect(h.lease_until).toBeGreaterThan(c.lease_until);
    expect((await grok.post(`/v1/tasks/${t.id}/heartbeat`)).status).toBe(409);
  });

  it("the cron returns expired tasks to the queue", async () => {
    const t = await newTask();
    await muse.post(`/v1/tasks/${t.id}/claim`);
    await env.DB.prepare("UPDATE tasks SET lease_until = 1 WHERE id = ?").bind(t.id).run();
    await runScheduled("*/5 * * * *", env as never);
    const d = (await me.get(`/v1/tasks/${t.id}`)).json;
    expect(d.status).toBe("todo");
    expect(d.claimed_by).toBeNull();
    expect(d.events.at(-1)).toMatchObject({ type: "lease_expired", actor: "system", body: "lease of muse expired" });
  });
});

describe("blocked / review loop", () => {
  it("ask -> answer -> same agent resumes", async () => {
    const t = await newTask();
    await muse.post(`/v1/tasks/${t.id}/claim`);
    expect((await muse.post(`/v1/tasks/${t.id}/block`, {})).status).toBe(400);
    const b = (await muse.post(`/v1/tasks/${t.id}/block`, { question: "Which color?" })).json;
    expect(b).toMatchObject({ status: "blocked", assignee: "muse", claimed_by: null });
    // agent 评论不会解除 blocked
    expect((await muse.post(`/v1/tasks/${t.id}/comments`, { body: "still waiting" })).json.status).toBe("blocked");
    expect((await me.post(`/v1/tasks/${t.id}/comments`, { body: "Blue" })).json.status).toBe("todo");
    expect((await grok.post("/v1/claim-next")).status).toBe(204);
    expect((await muse.post("/v1/claim-next")).json.id).toBe(t.id);
    expect(await events(t.id)).toEqual(["created", "claimed", "blocked", "commented", "answered", "claimed"]);
  });

  it("submit -> reject -> resubmit -> approve", async () => {
    const t = await newTask();
    expect((await muse.post(`/v1/tasks/${t.id}/submit`, { summary: "done" })).status).toBe(422);
    await muse.post(`/v1/tasks/${t.id}/claim`);
    expect((await grok.post(`/v1/tasks/${t.id}/submit`, { summary: "mine!" })).json.error.code).toBe("not_holder");
    const s = await muse.post(`/v1/tasks/${t.id}/submit`, {
      summary: "done",
      artifacts: [{ kind: "pr", url: "https://github.com/x/y/pull/1" }],
    });
    expect(s.json).toMatchObject({ status: "review", claimed_by: "muse", lease_until: null });
    expect((await muse.post(`/v1/tasks/${t.id}/approve`)).status).toBe(403);
    expect((await me.post(`/v1/tasks/${t.id}/reject`, {})).status).toBe(400);
    const r = (await me.post(`/v1/tasks/${t.id}/reject`, { feedback: "fix the footer" })).json;
    expect(r).toMatchObject({ status: "todo", assignee: "muse", claimed_by: null });
    await muse.post(`/v1/tasks/${t.id}/claim`);
    await muse.post(`/v1/tasks/${t.id}/submit`, { summary: "fixed" });
    const a = (await me.post(`/v1/tasks/${t.id}/approve`)).json;
    expect(a.status).toBe("done");
    expect(a.closed_at).toBeTypeOf("number");
    const d = (await me.get(`/v1/tasks/${t.id}`)).json;
    expect(d.artifacts).toHaveLength(1);
    expect(d.events.find((e: { type: string }) => e.type === "rejected").body).toBe("fix the footer");
  });

  it("rejects bad artifact URLs", async () => {
    const t = await newTask();
    await muse.post(`/v1/tasks/${t.id}/claim`);
    const r = await muse.post(`/v1/tasks/${t.id}/submit`, { summary: "x", artifacts: [{ url: "not a url" }] });
    expect(r.status).toBe(400);
    expect((await me.get(`/v1/tasks/${t.id}`)).json.status).toBe("claimed");
  });

  it("reopen and cancel are human-only", async () => {
    const t = await newTask();
    await me.post(`/v1/tasks/${t.id}/complete`);
    expect((await muse.post(`/v1/tasks/${t.id}/reopen`)).status).toBe(403);
    expect((await me.post(`/v1/tasks/${t.id}/reopen`)).json.status).toBe("todo");
    expect((await me.post(`/v1/tasks/${t.id}/cancel`, { reason: "nah" })).json.status).toBe("cancelled");
  });
});

describe("dependencies & edits", () => {
  it("tasks wait for their dependencies", async () => {
    const a = await newTask({ title: "a" });
    const b = await newTask({ title: "b", depends_on: [a.id] });
    expect((await muse.post(`/v1/tasks/${b.id}/claim`)).json.error.code).toBe("blocked_by_deps");
    expect((await muse.post("/v1/claim-next")).json.id).toBe(a.id);
    await muse.post(`/v1/tasks/${a.id}/submit`, { summary: "ok" });
    await me.post(`/v1/tasks/${a.id}/approve`);
    expect((await muse.post("/v1/claim-next")).json.id).toBe(b.id);
  });

  it("rejects dependency cycles", async () => {
    const a = await newTask();
    const b = await newTask({ depends_on: [a.id] });
    const r = await me.patch(`/v1/tasks/${a.id}`, { depends_on: [b.id] }, { "If-Match": String(a.version) });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/cycle/);
  });

  it("uses optimistic locking", async () => {
    const t = await newTask();
    const ok = await me.patch(`/v1/tasks/${t.id}`, { priority: 0 }, { "If-Match": String(t.version) });
    expect(ok.json.version).toBe(t.version + 1);
    const stale = await me.patch(`/v1/tasks/${t.id}`, { priority: 1 }, { "If-Match": String(t.version) });
    expect(stale.status).toBe(409);
    expect(stale.json.task.priority).toBe(0);
    expect((await me.patch(`/v1/tasks/${t.id}`, { priority: 1 })).status).toBe(400);
  });

  it("reassigning a claimed task revokes the claim", async () => {
    const t = await newTask();
    const c = (await muse.post(`/v1/tasks/${t.id}/claim`)).json;
    const r = (await me.patch(`/v1/tasks/${t.id}`, { assignee: "grok", version: c.version })).json;
    expect(r).toMatchObject({ status: "todo", assignee: "grok", claimed_by: null });
  });

  it("lists with filters", async () => {
    await newTask({ project: "blog" });
    await newTask({ project: "homepage", assignee: "muse" });
    await muse.post("/v1/tasks", { title: "p" });
    expect((await me.get("/v1/tasks?project=blog")).json.tasks).toHaveLength(1);
    expect((await me.get("/v1/tasks?status=proposed")).json.tasks).toHaveLength(1);
    expect((await me.get("/v1/tasks?assignee=none&status=todo")).json.tasks).toHaveLength(1);
    expect((await grok.get("/v1/tasks?claimable=1")).json.tasks).toHaveLength(1);
    expect((await me.get("/v1/tasks?status=bogus")).status).toBe(400);
  });
});
