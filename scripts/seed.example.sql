-- 复制为 scripts/seed.sql（已 gitignore）后填真实值：
--   本地：npx wrangler d1 execute todo-hub --local  --file scripts/seed.sql
--   线上：npx wrangler d1 execute todo-hub --remote --file scripts/seed.sql
-- access_client_id = CF Access service token 的 Client ID（不是 secret）
INSERT INTO actors (id, kind, display_name, email, access_client_id, created_at) VALUES
  ('me',       'human', 'Me',       'you@example.com', NULL,                        unixepoch() * 1000),
  ('muse',     'agent', 'Muse',     NULL,              '<muse-client-id>.access',   unixepoch() * 1000),
  ('grok-bot', 'agent', 'Grok bot', NULL,              '<grok-client-id>.access',   unixepoch() * 1000);
