import { SELF } from "cloudflare:test";

export async function call(actor: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(`https://todo.test${path}`, {
    method,
    headers: {
      ...(actor ? { "X-Dev-Actor": actor } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

export const as = (actor: string) => ({
  get: (p: string) => call(actor, "GET", p),
  post: (p: string, b: unknown = {}) => call(actor, "POST", p, b),
  patch: (p: string, b: unknown, h: Record<string, string> = {}) => call(actor, "PATCH", p, b, h),
});

export const me = as("me");
export const muse = as("muse");
export const grok = as("grok");

export async function newTask(fields: Record<string, unknown> = {}) {
  const r = await me.post("/v1/tasks", { title: "t", ...fields });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  return r.json;
}
