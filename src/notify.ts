import { EmailMessage } from "cloudflare:email";
import type { Notice } from "./tasks";
import type { Env, Task } from "./types";

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function wrap76(s: string): string {
  return s.replace(/.{1,76}/g, "$&\r\n");
}

export function buildMime(o: { from: string; to: string; subject: string; text: string; msgDomain: string }): string {
  return [
    `From: Todo Hub <${o.from}>`,
    `To: <${o.to}>`,
    `Subject: =?UTF-8?B?${b64(o.subject)}?=`,
    `Message-ID: <${crypto.randomUUID()}@${o.msgDomain}>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(o.text)),
  ].join("\r\n");
}

async function humanEmails(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT email FROM actors WHERE kind = 'human' AND active = 1 AND email IS NOT NULL`,
  ).all<{ email: string }>();
  return results.map((r) => r.email);
}

async function send(env: Env, subject: string, text: string) {
  const to = await humanEmails(env);
  if (!env.MAILER || !to.length) {
    console.log(JSON.stringify({ msg: "mail skipped", subject, reason: env.MAILER ? "no recipients" : "no MAILER" }));
    return;
  }
  const domain = env.MAIL_FROM.split("@")[1] ?? "localhost";
  for (const addr of to) {
    try {
      const raw = buildMime({ from: env.MAIL_FROM, to: addr, subject, text, msgDomain: domain });
      await env.MAILER.send(new EmailMessage(env.MAIL_FROM, addr, raw));
    } catch (e) {
      console.error(JSON.stringify({ msg: "mail failed", to: addr, error: String(e) }));
    }
  }
}

const link = (env: Env, t: Task) => `${env.PUBLIC_URL}/v1/tasks/${t.id}`;
const line = (env: Env, t: Task) => `- [${t.project ?? "-"}] ${t.title}  (P${t.priority})\n  ${link(env, t)}`;

export function sendNotice(env: Env, n: Notice): Promise<void> {
  const tag = n.kind === "review" ? "待 review" : "Agent 提问";
  const subject = `[${tag}] ${n.task.title}`;
  const text = [
    `${n.actor.display_name} ${n.kind === "review" ? "提交了任务，等你验收" : "卡住了，需要你回答"}：`,
    "",
    `任务：${n.task.title}`,
    `项目：${n.task.project ?? "-"}`,
    `链接：${link(env, n.task)}`,
    "",
    n.kind === "review" ? "交付说明：" : "问题：",
    n.body,
  ].join("\n");
  return send(env, subject, text);
}

export async function sendDigest(env: Env, d: { proposed: Task[]; review: Task[]; blocked: Task[] }): Promise<boolean> {
  const total = d.proposed.length + d.review.length + d.blocked.length;
  if (!total) return false;
  const section = (title: string, list: Task[]) =>
    list.length ? [`## ${title}（${list.length}）`, ...list.map((t) => line(env, t)), ""] : [];
  const text = [
    ...section("待 review", d.review),
    ...section("Agent 在等你回答", d.blocked),
    ...section("Agent 提议的新任务（待批准）", d.proposed),
  ].join("\n");
  await send(env, `[Todo Hub 每日汇总] ${d.review.length} 待 review · ${d.blocked.length} 提问 · ${d.proposed.length} 提案`, text);
  return true;
}
