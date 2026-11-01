import { describe, expect, it } from "vitest";
import { call, newTask } from "./helpers";

let n = 0;
const rpc = (actor: string, method: string, params?: unknown) =>
  call(actor, "POST", "/mcp", { jsonrpc: "2.0", id: ++n, method, params });
const tool = async (actor: string, name: string, args: unknown = {}) => {
  const r = (await rpc(actor, "tools/call", { name, arguments: args })).json.result;
  return { isError: !!r.isError, data: JSON.parse(r.content[0].text) };
};

describe("mcp", () => {
  it("initializes", async () => {
    const r = (await rpc("muse", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } })).json;
    expect(r.result.protocolVersion).toBe("2025-06-18");
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.instructions).toContain("claim_next_task");
    const notif = await call("muse", "POST", "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notif.status).toBe(202);
  });

  it("hides human-only tools from agents", async () => {
    const agent = (await rpc("muse", "tools/list")).json.result.tools.map((t: { name: string }) => t.name);
    const human = (await rpc("me", "tools/list")).json.result.tools.map((t: { name: string }) => t.name);
    expect(agent).toContain("claim_next_task");
    expect(agent).not.toContain("approve_task");
    expect(human).toContain("approve_task");
    expect((await rpc("muse", "tools/call", { name: "approve_task", arguments: { id: "x" } })).json.error.code).toBe(-32602);
  });

  it("runs the agent workflow end to end", async () => {
    const t = await newTask({ title: "write about page", project: "homepage" });
    const claimed = await tool("muse", "claim_next_task", {});
    expect(claimed.data.id).toBe(t.id);
    expect((await tool("muse", "heartbeat", { id: t.id })).isError).toBe(false);
    const sub = await tool("muse", "submit_for_review", { id: t.id, summary: "done", artifacts: [{ url: "https://example.com" }] });
    expect(sub.data.status).toBe("review");
    expect((await tool("me", "approve_task", { id: t.id })).data.status).toBe("done");
    expect((await tool("muse", "claim_next_task", {})).data).toBeNull();
  });

  it("returns business errors as tool errors", async () => {
    const t = await newTask({ assignee: "grok" });
    const r = await tool("muse", "claim_task", { id: t.id });
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe("not_assignee");
  });

  it("agent-created tasks become proposals", async () => {
    const r = await tool("muse", "create_task", { title: "fix RSS", project: "blog" });
    expect(r.data.status).toBe("proposed");
  });

  it("rejects unknown methods and GET", async () => {
    expect((await rpc("muse", "resources/list")).json.error.code).toBe(-32601);
    expect((await call("muse", "GET", "/mcp")).status).toBe(405);
  });
});
