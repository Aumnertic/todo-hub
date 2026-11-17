import { ApiError, STATUSES, type Actor, type Artifact, type Status, type Task, type TaskEvent } from "./types";
import { ulid } from "./ulid";

export const DEFAULT_LEASE_MS = 30 * 60_000;
const MIN_LEASE_MS = 60_000;
const MAX_LEASE_MS = 4 * 3600_000;

const OPEN: Status[] = ["todo", "claimed", "blocked", "review"];

/** 依赖全部 done / cancelled 才可领 */
const DEPS_SATISFIED = `NOT EXISTS (
  SELECT 1 FROM task_deps d JOIN tasks dt ON dt.id = d.depends_on
  WHERE d.task_id = tasks.id AND dt.status NOT IN ('done', 'cancelled'))`;

/** 对 me 来说可认领：指派给我或没指派；todo，或租约过期，或本来就是我持有 */
function claimableSql(me: string, now: string): string {
  return `(tasks.assignee IS NULL OR tasks.assignee = ${me})
    AND (tasks.status = 'todo'
         OR (tasks.status = 'claimed' AND (tasks.lease_until < ${now} OR tasks.claimed_by = ${me})))
    AND ${DEPS_SATISFIED}`;
}

export interface Notice {
  kind: "review" | "blocked";
  task: Task;
  actor: Actor;
  body: string;
}

export interface TaskInput {
  title?: unknown;
  description?: unknown;
  acceptance?: unknown;
  project?: unknown;
  priority?: unknown;
  assignee?: unknown;
  due_at?: unknown;
  depends_on?: unknown;
}

export interface ArtifactInput {
  kind?: unknown;
  url?: unknown;
  note?: unknown;
}

export interface ListFilter {
  status?: Status[];
  assignee?: string | null; // null = 未指派
  project?: string;
  created_by?: string;
  claimable?: boolean;
  limit?: number;
}

export interface TaskDetail extends Task {
  depends_on: string[];
  events: TaskEvent[];
  artifacts: Artifact[];
}

// ---------- 校验 ----------

function bad(message: string): never {
  throw new ApiError(400, "bad_request", message);
}

function optStr(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") bad(`${field} must be a string`);
  if (v.length > max) bad(`${field} is longer than ${max}`);
  return v;
}

function reqStr(v: unknown, field: string, max: number): string {
  const s = optStr(v, field, max);
  if (!s || !s.trim()) bad(`${field} is required`);
  return s.trim();
}

function optNullableStr(v: unknown, field: string, max: number): string | null | undefined {
  if (v === null) return null;
  const s = optStr(v, field, max);
  return s === undefined ? undefined : s.trim() || null;
}

function optPriority(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 3) bad("priority must be an integer 0-3");
  return v as number;
}

function optTimestamp(v: unknown, field: string): number | null | undefined {
  if (v === undefined || v === null) return v as null | undefined;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  bad(`${field} must be unix ms or an ISO date`);
}

function optIdList(v: unknown, field: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) bad(`${field} must be an array of task ids`);
  return [...new Set(v as string[])];
}

export function leaseMs(v: unknown): number {
  if (v === undefined || v === null) return DEFAULT_LEASE_MS;
  if (typeof v !== "number" || !Number.isFinite(v)) bad("lease_seconds must be a number");
  return Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, Math.trunc(v * 1000)));
}

export function parseStatuses(v: string | undefined): Status[] | undefined {
  if (!v) return undefined;
  const list = v.split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of list) if (!STATUSES.includes(s as Status)) bad(`unknown status: ${s}`);
  return list as Status[];
}

function parseArtifacts(v: unknown): { kind: string; url: string; note: string | null }[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) bad("artifacts must be an array");
  return v.map((a: ArtifactInput, i) => {
    if (typeof a !== "object" || a === null) bad(`artifacts[${i}] must be an object`);
    const url = reqStr(a.url, `artifacts[${i}].url`, 2000);
    try {
      new URL(url);
    } catch {
      bad(`artifacts[${i}].url is not a valid URL`);
    }
    return {
      kind: optStr(a.kind, `artifacts[${i}].kind`, 32)?.trim() || "url",
      url,
      note: optNullableStr(a.note, `artifacts[${i}].note`, 2000) ?? null,
    };
  });
}

// ---------- 服务 ----------

export class Tasks {
  constructor(
    private db: D1Database,
    private actor: Actor,
    private onNotice: (n: Notice) => void = () => {},
    private clock: () => number = Date.now,
  ) {}

  private get isHuman() {
    return this.actor.kind === "human";
  }

  private requireHuman(action: string) {
    if (!this.isHuman) throw new ApiError(403, "human_only", `only a human can ${action}`);
  }

  private event(taskId: string, type: string, from: Status | null, to: Status | null, body: string | null, now: number) {
    return this.db
      .prepare(
        `INSERT INTO task_events (id, task_id, actor, type, from_status, to_status, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(ulid(now), taskId, this.actor.id, type, from, to, body, now);
  }

  private artifactStmt(taskId: string, a: { kind: string; url: string; note: string | null }, now: number) {
    return this.db
      .prepare(
        `INSERT INTO task_artifacts (id, task_id, kind, url, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(ulid(now), taskId, a.kind, a.url, a.note, this.actor.id, now);
  }

  private async requireAssignable(id: string) {
    const row = await this.db
      .prepare(`SELECT id FROM actors WHERE id = ? AND active = 1 AND kind IN ('human', 'agent')`)
      .bind(id)
      .first();
    if (!row) bad(`unknown or inactive assignee: ${id}`);
  }

  private async requireDeps(taskId: string | null, deps: string[]) {
    for (const dep of deps) {
      if (dep === taskId) bad("a task cannot depend on itself");
      const row = await this.db.prepare(`SELECT id FROM tasks WHERE id = ?`).bind(dep).first();
      if (!row) bad(`unknown dependency: ${dep}`);
      if (taskId) {
        // dep 能否沿依赖链走回 taskId？能就成环
        const cycle = await this.db
          .prepare(
            `WITH RECURSIVE r(id) AS (
               SELECT ?1 UNION SELECT d.depends_on FROM task_deps d JOIN r ON d.task_id = r.id)
             SELECT 1 FROM r WHERE id = ?2 LIMIT 1`,
          )
          .bind(dep, taskId)
          .first();
        if (cycle) bad(`dependency on ${dep} would create a cycle`);
      }
    }
  }

  async get(id: string): Promise<Task> {
    const task = await this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).bind(id).first<Task>();
    if (!task) throw new ApiError(404, "not_found", `task ${id} not found`);
    return task;
  }

  async detail(id: string): Promise<TaskDetail> {
    const task = await this.get(id);
    const [deps, events, artifacts] = await this.db.batch([
      this.db.prepare(`SELECT depends_on FROM task_deps WHERE task_id = ? ORDER BY depends_on`).bind(id),
      this.db.prepare(`SELECT * FROM task_events WHERE task_id = ? ORDER BY id`).bind(id),
      this.db.prepare(`SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY id`).bind(id),
    ]);
    return {
      ...task,
      depends_on: (deps.results as { depends_on: string }[]).map((r) => r.depends_on),
      events: events.results as unknown as TaskEvent[],
      artifacts: artifacts.results as unknown as Artifact[],
    };
  }

  async actors(): Promise<Pick<Actor, "id" | "kind" | "display_name">[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, kind, display_name FROM actors
         WHERE active = 1 AND kind IN ('human', 'agent')
         ORDER BY CASE kind WHEN 'human' THEN 0 ELSE 1 END, id`,
      )
      .all<Pick<Actor, "id" | "kind" | "display_name">>();
    return results;
  }

  async list(f: ListFilter = {}): Promise<Task[]> {
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `?${params.length}`;
    };
    const where: string[] = [];
    if (f.status?.length) where.push(`tasks.status IN (${f.status.map(p).join(", ")})`);
    if (f.assignee === null) where.push(`tasks.assignee IS NULL`);
    else if (f.assignee !== undefined) where.push(`tasks.assignee = ${p(f.assignee)}`);
    if (f.project) where.push(`tasks.project = ${p(f.project)}`);
    if (f.created_by) where.push(`tasks.created_by = ${p(f.created_by)}`);
    let order = "tasks.priority, tasks.created_at";
    if (f.claimable) {
      const me = p(this.actor.id);
      where.push(claimableSql(me, p(this.clock())));
      order = `(tasks.claimed_by = ${me}) DESC, (tasks.assignee = ${me}) DESC, ${order}`;
    }
    const limit = Math.min(200, Math.max(1, Math.trunc(f.limit ?? 50)));
    const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY ${order} LIMIT ${limit}`;
    const { results } = await this.db.prepare(sql).bind(...params).all<Task>();
    return results;
  }

  async listExpanded(f: ListFilter = {}): Promise<TaskDetail[]> {
    const tasks = await this.list(f);
    if (!tasks.length) return [];

    const ids = tasks.map((t) => t.id);
    const chunkSize = 80;
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(", ");
      stmts.push(
        this.db
          .prepare(`SELECT task_id, depends_on FROM task_deps WHERE task_id IN (${placeholders}) ORDER BY depends_on`)
          .bind(...chunk),
        this.db
          .prepare(`SELECT * FROM task_events WHERE task_id IN (${placeholders}) ORDER BY id`)
          .bind(...chunk),
        this.db
          .prepare(`SELECT * FROM task_artifacts WHERE task_id IN (${placeholders}) ORDER BY id`)
          .bind(...chunk),
      );
    }

    const batchRes = await this.db.batch(stmts);
    const depsMap = new Map<string, string[]>();
    const eventsMap = new Map<string, TaskEvent[]>();
    const artifactsMap = new Map<string, Artifact[]>();

    for (let i = 0; i < batchRes.length; i += 3) {
      for (const row of batchRes[i].results as { task_id: string; depends_on: string }[]) {
        const arr = depsMap.get(row.task_id) ?? [];
        arr.push(row.depends_on);
        depsMap.set(row.task_id, arr);
      }
      for (const row of batchRes[i + 1].results as unknown as TaskEvent[]) {
        const arr = eventsMap.get(row.task_id) ?? [];
        arr.push(row);
        eventsMap.set(row.task_id, arr);
      }
      for (const row of batchRes[i + 2].results as unknown as Artifact[]) {
        const arr = artifactsMap.get(row.task_id) ?? [];
        arr.push(row);
        artifactsMap.set(row.task_id, arr);
      }
    }

    return tasks.map((t) => ({
      ...t,
      depends_on: depsMap.get(t.id) ?? [],
      events: eventsMap.get(t.id) ?? [],
      artifacts: artifactsMap.get(t.id) ?? [],
    }));
  }

  async create(input: TaskInput): Promise<Task> {
    const now = this.clock();
    const title = reqStr(input.title, "title", 200);
    const description = optStr(input.description, "description", 20_000) ?? "";
    const acceptance = optStr(input.acceptance, "acceptance", 5_000) ?? "";
    const project = optNullableStr(input.project, "project", 64) ?? null;
    const priority = optPriority(input.priority) ?? 2;
    const assignee = optNullableStr(input.assignee, "assignee", 64) ?? null;
    const dueAt = optTimestamp(input.due_at, "due_at") ?? null;
    const deps = optIdList(input.depends_on, "depends_on") ?? [];
    if (assignee) await this.requireAssignable(assignee);
    await this.requireDeps(null, deps);

    // 人建的直接可领；Agent 建的要人 accept
    const status: Status = this.isHuman ? "todo" : "proposed";
    const id = ulid(now);
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO tasks (id, title, description, acceptance, project, priority, status,
                              assignee, created_by, due_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, title, description, acceptance, project, priority, status, assignee, this.actor.id, dueAt, now, now),
      ...deps.map((d) => this.db.prepare(`INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)`).bind(id, d)),
      this.event(id, "created", null, status, null, now),
    ]);
    return this.get(id);
  }

  async update(id: string, input: TaskInput, version: unknown): Promise<Task> {
    if (!Number.isInteger(version)) bad("version is required (If-Match header or version field)");
    const before = await this.get(id);
    const ownProposal = before.status === "proposed" && before.created_by === this.actor.id;
    if (!this.isHuman && !ownProposal) {
      throw new ApiError(403, "forbidden", "agents can only edit their own proposed tasks");
    }

    const now = this.clock();
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => {
      if (v !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(v);
      }
    };
    const title = input.title === undefined ? undefined : reqStr(input.title, "title", 200);
    set("title", title);
    set("description", optStr(input.description, "description", 20_000));
    set("acceptance", optStr(input.acceptance, "acceptance", 5_000));
    set("project", optNullableStr(input.project, "project", 64));
    set("priority", optPriority(input.priority));
    set("due_at", optTimestamp(input.due_at, "due_at"));

    const assignee = optNullableStr(input.assignee, "assignee", 64);
    if (assignee !== undefined) {
      if (assignee) await this.requireAssignable(assignee);
      set("assignee", assignee);
      // 改派给别人：收回当前认领
      if (before.status === "claimed" && assignee && before.claimed_by !== assignee) {
        sets.push(`status = 'todo'`, `claimed_by = NULL`, `lease_until = NULL`);
      }
    }

    const deps = optIdList(input.depends_on, "depends_on");
    if (deps) await this.requireDeps(id, deps);

    const changed = [...sets.filter((s) => s.endsWith("= ?")).map((s) => s.split(" ")[0]), ...(deps ? ["depends_on"] : [])];
    if (!changed.length) bad("nothing to update");

    const updated = await this.db
      .prepare(
        `UPDATE tasks SET ${[...sets, "version = version + 1", "updated_at = ?"].join(", ")}
         WHERE id = ? AND version = ? RETURNING *`,
      )
      .bind(...vals, now, id, version)
      .first<Task>();
    if (!updated) {
      const current = await this.get(id);
      throw new ApiError(409, "version_conflict", `task was modified (version is ${current.version})`, current);
    }
    await this.db.batch([
      ...(deps
        ? [
            this.db.prepare(`DELETE FROM task_deps WHERE task_id = ?`).bind(id),
            ...deps.map((d) => this.db.prepare(`INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)`).bind(id, d)),
          ]
        : []),
      this.event(id, "edited", before.status, updated.status, changed.join(", "), now),
    ]);
    return updated;
  }

  // ---------- 认领 ----------

  async claim(id: string, lease: number = DEFAULT_LEASE_MS): Promise<Task> {
    const before = await this.get(id);
    const now = this.clock();
    const task = await this.db
      .prepare(
        `UPDATE tasks SET status = 'claimed', claimed_by = ?1, lease_until = ?3,
                          version = version + 1, updated_at = ?2
         WHERE id = ?4 AND ${claimableSql("?1", "?2")} RETURNING *`,
      )
      .bind(this.actor.id, now, now + lease, id)
      .first<Task>();
    if (!task) throw this.whyNotClaimable(before, now);

    const reclaim = before.status === "claimed" && before.claimed_by === this.actor.id;
    if (!reclaim) {
      const body = before.status === "claimed" ? `lease of ${before.claimed_by} had expired` : null;
      await this.event(id, "claimed", before.status, "claimed", body, now).run();
    }
    return task;
  }

  private whyNotClaimable(t: Task, now: number): ApiError {
    if (t.assignee && t.assignee !== this.actor.id) {
      return new ApiError(403, "not_assignee", `task is assigned to ${t.assignee}`, t);
    }
    if (t.status === "claimed" && (t.lease_until ?? 0) >= now) {
      return new ApiError(409, "already_claimed", `task is claimed by ${t.claimed_by}`, t);
    }
    if (t.status === "proposed") {
      return new ApiError(409, "not_accepted", "task is still a proposal awaiting human approval", t);
    }
    if (t.status === "todo") {
      return new ApiError(409, "blocked_by_deps", "task has unfinished dependencies", t);
    }
    return new ApiError(409, "invalid_state", `cannot claim a task in status ${t.status}`, t);
  }

  /** 轮询主入口：按（我持有 > 指派给我 > 优先级 > 时间）领一个；没有返回 null */
  async claimNext(project: string | undefined, lease: number = DEFAULT_LEASE_MS): Promise<Task | null> {
    for (let round = 0; round < 3; round++) {
      const candidates = await this.list({ claimable: true, project, limit: 10 });
      if (!candidates.length) return null;
      for (const c of candidates) {
        try {
          return await this.claim(c.id, lease);
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 409) throw e; // 被别人抢了，试下一个
        }
      }
    }
    return null;
  }

  async heartbeat(id: string, lease: number = DEFAULT_LEASE_MS): Promise<Task> {
    const now = this.clock();
    const task = await this.db
      .prepare(
        `UPDATE tasks SET lease_until = ?, updated_at = ?
         WHERE id = ? AND status = 'claimed' AND claimed_by = ? RETURNING *`,
      )
      .bind(now + lease, now, id, this.actor.id)
      .first<Task>();
    if (!task) {
      const t = await this.get(id);
      throw new ApiError(409, "not_holder", `you do not hold this task (status ${t.status}, claimed by ${t.claimed_by})`, t);
    }
    return task;
  }

  // ---------- 状态流转 ----------

  private async transition(o: {
    id: string;
    from: Status[];
    to: Status;
    type: string;
    body?: string | null;
    set?: string;
    setParams?: unknown[];
    where?: string;
    whereParams?: unknown[];
    holderOnly?: boolean;
    extra?: (now: number) => D1PreparedStatement[];
  }): Promise<Task> {
    const now = this.clock();
    const holder = o.holderOnly ? ` AND claimed_by = ?` : "";
    const task = await this.db
      .prepare(
        `UPDATE tasks SET status = ?, version = version + 1, updated_at = ?${o.set ?? ""}
         WHERE id = ? AND status IN (${o.from.map(() => "?").join(", ")})${o.where ?? ""}${holder}
         RETURNING *`,
      )
      .bind(o.to, now, ...(o.setParams ?? []), o.id, ...o.from, ...(o.whereParams ?? []), ...(o.holderOnly ? [this.actor.id] : []))
      .first<Task>();
    if (!task) {
      const t = await this.get(o.id);
      if (o.holderOnly && t.status === "claimed" && t.claimed_by !== this.actor.id) {
        throw new ApiError(409, "not_holder", `task is held by ${t.claimed_by}`, t);
      }
      if (o.from.includes(t.status)) throw new ApiError(403, "forbidden", `you cannot ${o.type} this task`, t);
      throw new ApiError(422, "invalid_transition", `cannot ${o.type} a task in status ${t.status}`, t);
    }
    const prev = o.from.length === 1 ? o.from[0] : null;
    await this.db.batch([...(o.extra?.(now) ?? []), this.event(o.id, o.type, prev, o.to, o.body ?? null, now)]);
    return task;
  }

  release(id: string, note?: unknown) {
    return this.transition({
      id, from: ["claimed"], to: "todo", type: "released", holderOnly: true,
      body: optNullableStr(note, "note", 5_000) ?? null,
      set: `, claimed_by = NULL, lease_until = NULL`,
    });
  }

  /** Agent 缺信息：提问并放手；你回复后回到 todo，仍指派给它 */
  async block(id: string, question: unknown) {
    const body = reqStr(question, "question", 5_000);
    const task = await this.transition({
      id, from: ["claimed"], to: "blocked", type: "blocked", body, holderOnly: true,
      set: `, claimed_by = NULL, lease_until = NULL, assignee = COALESCE(assignee, ?)`,
      setParams: [this.actor.id],
    });
    this.onNotice({ kind: "blocked", task, actor: this.actor, body });
    return task;
  }

  async submit(id: string, summary: unknown, artifacts: unknown) {
    const body = reqStr(summary, "summary", 10_000);
    const arts = parseArtifacts(artifacts);
    const task = await this.transition({
      id, from: ["claimed"], to: "review", type: "submitted", body, holderOnly: true,
      set: `, lease_until = NULL`,
      extra: (now) => arts.map((a) => this.artifactStmt(id, a, now)),
    });
    this.onNotice({ kind: "review", task, actor: this.actor, body });
    return task;
  }

  approve(id: string, note?: unknown) {
    this.requireHuman("approve");
    return this.transition({
      id, from: ["review"], to: "done", type: "approved",
      body: optNullableStr(note, "note", 5_000) ?? null,
      set: `, closed_at = ?`, setParams: [this.clock()],
    });
  }

  reject(id: string, feedback: unknown) {
    this.requireHuman("reject");
    return this.transition({
      id, from: ["review"], to: "todo", type: "rejected",
      body: reqStr(feedback, "feedback", 10_000),
      // 退回给原来干活的 Agent
      set: `, assignee = COALESCE(assignee, claimed_by), claimed_by = NULL, lease_until = NULL`,
    });
  }

  accept(id: string, note?: unknown) {
    this.requireHuman("accept proposals");
    return this.transition({
      id, from: ["proposed"], to: "todo", type: "accepted",
      body: optNullableStr(note, "note", 5_000) ?? null,
    });
  }

  /** 人自己的任务不走 review，直接完成 */
  complete(id: string, note?: unknown) {
    this.requireHuman("complete tasks directly");
    return this.transition({
      id, from: OPEN, to: "done", type: "completed",
      body: optNullableStr(note, "note", 5_000) ?? null,
      set: `, lease_until = NULL, closed_at = ?`, setParams: [this.clock()],
    });
  }

  /** 人能取消任何未结束的任务；Agent 只能撤回自己的提案 */
  cancel(id: string, reason?: unknown) {
    const body = optNullableStr(reason, "reason", 5_000) ?? null;
    const common = { id, to: "cancelled" as const, type: "cancelled", body,
      set: `, claimed_by = NULL, lease_until = NULL, closed_at = ?`, setParams: [this.clock()] };
    if (this.isHuman) return this.transition({ ...common, from: ["proposed", ...OPEN] });
    return this.transition({ ...common, from: ["proposed"], where: ` AND created_by = ?`, whereParams: [this.actor.id] });
  }

  reopen(id: string, reason?: unknown) {
    this.requireHuman("reopen");
    return this.transition({
      id, from: ["done", "cancelled"], to: "todo", type: "reopened",
      body: optNullableStr(reason, "reason", 5_000) ?? null,
      set: `, claimed_by = NULL, closed_at = NULL`,
    });
  }

  /** 评论；人回复 blocked 任务时自动转回 todo */
  async comment(id: string, text: unknown): Promise<Task> {
    const body = reqStr(text, "body", 10_000);
    const task = await this.get(id);
    if (task.status === "blocked" && this.isHuman) {
      return this.transition({ id, from: ["blocked"], to: "todo", type: "answered", body });
    }
    await this.event(id, "commented", null, null, body, this.clock()).run();
    return task;
  }

  async addArtifacts(id: string, artifacts: unknown): Promise<Artifact[]> {
    const arts = parseArtifacts(artifacts);
    if (!arts.length) bad("artifacts is empty");
    const task = await this.get(id);
    if (!this.isHuman && !(task.status === "claimed" && task.claimed_by === this.actor.id)) {
      throw new ApiError(409, "not_holder", "only the holder can attach artifacts", task);
    }
    const now = this.clock();
    await this.db.batch(arts.map((a) => this.artifactStmt(id, a, now)));
    const { results } = await this.db
      .prepare(`SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY id`)
      .bind(id)
      .all<Artifact>();
    return results;
  }

  // ---------- 定时任务 ----------

  /** 回收过期租约，记录事件。actor 应为 system */
  async expireLeases(): Promise<Task[]> {
    const now = this.clock();
    const { results: stale } = await this.db
      .prepare(`SELECT id, claimed_by FROM tasks WHERE status = 'claimed' AND lease_until < ?`)
      .bind(now)
      .all<{ id: string; claimed_by: string | null }>();
    const expired: Task[] = [];
    for (const s of stale) {
      // 条件里再判一次：查询之后对方可能刚续了租
      const t = await this.db
        .prepare(
          `UPDATE tasks SET status = 'todo', claimed_by = NULL, lease_until = NULL,
                            version = version + 1, updated_at = ?1
           WHERE id = ?2 AND status = 'claimed' AND lease_until < ?1 RETURNING *`,
        )
        .bind(now, s.id)
        .first<Task>();
      if (!t) continue;
      expired.push(t);
      await this.event(t.id, "lease_expired", "claimed", "todo", `lease of ${s.claimed_by ?? "?"} expired`, now).run();
    }
    return expired;
  }

  async digest() {
    const [proposed, review, blocked] = await Promise.all([
      this.list({ status: ["proposed"], limit: 100 }),
      this.list({ status: ["review"], limit: 100 }),
      this.list({ status: ["blocked"], limit: 100 }),
    ]);
    return { proposed, review, blocked };
  }
}
