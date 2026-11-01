# todo-hub

人和多个 Agent 共用的任务队列。Cloudflare Workers + D1，身份走 CF Access。

- 你（或 Agent）写任务，Agent 定时轮询 `claim-next` 领活
- 认领 = 有租约的锁，30 分钟不续约自动回到队列
- Agent 缺信息 → 提问（blocked）→ 邮件通知你 → 你回复后回到队列，原 Agent 接着做
- Agent 做完 → review → 邮件通知你 → 通过 / 驳回（意见退回给原 Agent）
- Agent 建的任务是提案（proposed），你批准后才进入队列
- 每天北京时间 09:00 发一封汇总：待 review / 提问 / 提案

## 状态机

```
proposed ──accept──▶ todo ──claim──▶ claimed ──submit──▶ review ──approve──▶ done
                      ▲  ▲            │   │                 │
                      │  └ release / ─┘   └─block─▶ blocked │
                      │    租约过期              │ 人回复   │
                      └──────────────────────────┴──reject──┘
任意未结束状态 ──cancel──▶ cancelled      done / cancelled ──reopen──▶ todo
人自己的任务：complete 直接 → done
```

## REST（`/v1`）

| 方法 | 路径 | 谁 | 说明 |
|---|---|---|---|
| GET | `/me` | 所有 | 当前身份 |
| GET | `/tasks?status=a,b&assignee=&project=&created_by=&claimable=1&limit=` | 所有 | `assignee=none` = 未指派 |
| POST | `/tasks` | 所有 | 人 → todo；Agent → proposed |
| GET | `/tasks/:id` | 所有 | 含 `depends_on` / `events` / `artifacts` |
| PATCH | `/tasks/:id` | 人；Agent 仅自己的提案 | `If-Match: <version>` 或 body 里 `version` |
| POST | `/claim-next?project=` | 所有 | `{lease_seconds?}`；无任务 204 |
| POST | `/tasks/:id/claim` | 所有 | `{lease_seconds?}` |
| POST | `/tasks/:id/heartbeat` | 持有者 | `{lease_seconds?}` |
| POST | `/tasks/:id/release` | 持有者 | `{note?}` |
| POST | `/tasks/:id/block` | 持有者 | `{question}` |
| POST | `/tasks/:id/submit` | 持有者 | `{summary, artifacts?: [{kind, url, note?}]}` |
| POST | `/tasks/:id/artifacts` | 持有者 / 人 | `{artifacts}` |
| POST | `/tasks/:id/comments` | 所有 | `{body}`；人回复 blocked → todo |
| POST | `/tasks/:id/accept` | 人 | 批准提案 |
| POST | `/tasks/:id/approve` | 人 | `{note?}` |
| POST | `/tasks/:id/reject` | 人 | `{feedback}` |
| POST | `/tasks/:id/complete` | 人 | 跳过 review 直接完成 |
| POST | `/tasks/:id/cancel` | 人；Agent 仅撤回自己的提案 | `{reason?}` |
| POST | `/tasks/:id/reopen` | 人 | `{reason?}` |

错误：`{"error": {"code", "message"}, "task"?}`。401 未认证 / 403 无权限（`human_only`、`not_assignee`）/ 409 冲突（`already_claimed`、`not_holder`、`not_accepted`、`blocked_by_deps`、`version_conflict`）/ 422 非法状态流转。

## MCP

`POST /mcp`：无状态 Streamable HTTP（JSON 响应）。工具与 REST 一一对应：
`claim_next_task`、`heartbeat`、`ask_human`、`submit_for_review`、`create_task`……
只有人能调用的工具（`approve_task` 等）不会出现在 Agent 的 `tools/list` 里。

客户端配置（以 Claude Code 为例）：

```sh
claude mcp add --transport http todo-hub https://todo.aumnertic.top/mcp \
  --header "CF-Access-Client-Id: $TODO_HUB_CLIENT_ID" \
  --header "CF-Access-Client-Secret: $TODO_HUB_CLIENT_SECRET"
```

### Agent 定时任务 prompt 模板

```
你是 <agent 名>。连接 todo-hub MCP，调用 claim_next_task 领一个任务；
没有任务就直接结束。领到后按 todo-hub 的 instructions 工作：
读 description / acceptance / 事件流 → 干活并定期 heartbeat →
缺信息就 ask_human 后结束 → 完成后 submit_for_review 附 PR 链接。
一次只做一个任务。
```

## 开发

```sh
pnpm install
pnpm test                         # vitest，在 workerd 里跑，含 D1
pnpm db:migrate:local
cp scripts/seed.example.sql scripts/seed.sql   # 填真实值
npx wrangler d1 execute todo-hub --local --file scripts/seed.sql
pnpm dev                          # .dev.vars 里 DEV_AUTH=1，用 X-Dev-Actor: me 调试
```

## 部署

1. `npx wrangler d1 create todo-hub` → 把 `database_id` 填进 `wrangler.jsonc`
2. `pnpm db:migrate:remote`，再用 `--remote` 执行 seed
3. `pnpm deploy`，在 dashboard 给 Worker 绑定自定义域名 `todo.aumnertic.top`，关掉 `workers.dev` 路由
4. Zero Trust → Access → 新建 Self-hosted 应用 `todo.aumnertic.top`：
   - 策略 ① Allow：Emails = 本人邮箱
   - 策略 ② Service Auth：Service Token = 每个 Agent 一个
   - 把应用的 AUD tag 填进 `ACCESS_AUD`，重新部署
5. Email Routing 里验证收件地址（`send_email` 只能发给已验证的地址）
6. 在 `~/infra/cloudflare.md`、`agents.md`、`inventory.yaml` 登记

新增 Agent：Access 建 service token → `INSERT INTO actors (..., access_client_id)` → 加进 Access 应用的 Service Auth 策略 → token 存 1Password。
