import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeEach } from "vitest";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM task_artifacts"),
    env.DB.prepare("DELETE FROM task_events"),
    env.DB.prepare("DELETE FROM task_deps"),
    env.DB.prepare("DELETE FROM tasks"),
    env.DB.prepare("DELETE FROM actors WHERE id <> 'system'"),
    env.DB.prepare(
      `INSERT INTO actors (id, kind, display_name, email, access_client_id, created_at) VALUES
        ('me', 'human', 'Me', 'me@example.com', NULL, 0),
        ('muse', 'agent', 'Muse', NULL, 'muse.access', 0),
        ('grok', 'agent', 'Grok bot', NULL, 'grok.access', 0),
        ('retired', 'agent', 'Old bot', NULL, NULL, 0)`,
    ),
    env.DB.prepare("UPDATE actors SET active = 0 WHERE id = 'retired'"),
  ]);
});
