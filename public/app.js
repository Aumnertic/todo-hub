const STATUS_META = {
  review: { label: "待验收", cls: "tag-status-review", go: "验收 ↗" },
  blocked: { label: "提问中", cls: "tag-status-blocked", go: "回答 ↗" },
  proposed: { label: "待批准", cls: "tag-status-proposed", go: "批准 ↗" },
  claimed: { label: "执行中", cls: "tag-status-claimed", go: "详情 ↗" },
  todo: { label: "待认领", cls: "tag-status-todo", go: "详情 ↗" },
  done: { label: "已完成", cls: "tag-status-done", go: "详情 ↗" },
  cancelled: { label: "已取消", cls: "tag-status-cancelled", go: "详情 ↗" },
};

const EVENT_LABELS = {
  created: "创建任务",
  edited: "修改属性",
  claimed: "认领任务",
  released: "释放回队列",
  blocked: "提出疑问",
  answered: "回复并放回队列",
  submitted: "提交验收",
  approved: "验收通过",
  rejected: "驳回重做",
  accepted: "批准提案",
  completed: "直接完成",
  cancelled: "取消任务",
  reopened: "重新打开",
  commented: "留言",
  lease_expired: "租约过期回收",
};

const AGENT_ACCENTS = ["#5b8ec9", "#4f9a6e", "#7689c7", "#c4843d"];
const STAMP_CIRCUMFERENCE = 2 * Math.PI * 42;
const IS_DEMO_MODE =
  location.hostname.endsWith(".github.io") ||
  new URLSearchParams(location.search).get("demo") === "1";
const IS_LOCAL_DEV =
  !IS_DEMO_MODE &&
  (location.hostname === "localhost" || location.hostname === "127.0.0.1");
const CAN_SWITCH_ACTOR = IS_LOCAL_DEV || IS_DEMO_MODE;
const DEMO_STORAGE_KEY = "todo-hub-demo-v1";

function getStoredActor() {
  try {
    if (IS_DEMO_MODE) return sessionStorage.getItem("todo-demo-actor") || "me";
    if (IS_LOCAL_DEV) return localStorage.getItem("todo-dev-actor") || "me";
  } catch {
    return "me";
  }
  return null;
}

function setStoredActor(id) {
  try {
    if (IS_DEMO_MODE) sessionStorage.setItem("todo-demo-actor", id);
    else if (IS_LOCAL_DEV) localStorage.setItem("todo-dev-actor", id);
  } catch {
    // ignore storage restrictions
  }
}

const state = {
  me: null,
  actors: [],
  actorMap: new Map(),
  tasks: [],
  taskMap: new Map(),
  lastSyncAt: null,
  loading: false,
  activeSheet: "all", // 'all' | actorId | 'unassigned'
  sheetViews: new Map(), // sheetId -> { activeProject, searchQuery, currentPage, archiveExpanded }
  totalPages: 1,
  highlightTaskId: null,
  focusHighlightPage: false,
  activeDetailId: null,
  detailTask: null,
  inlinePanels: new Map(),
  switchTimer: null,
  devActor: getStoredActor(),
};

const $ = (id) => document.getElementById(id);

function getSheetView(sheetId = state.activeSheet) {
  let view = state.sheetViews.get(sheetId);
  if (!view) {
    view = {
      activeProject: "",
      searchQuery: "",
      currentPage: 1,
      archiveExpanded: false,
    };
    state.sheetViews.set(sheetId, view);
  }
  return view;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function createSvgCheck(stroke = "#b93829", size = 12, strokeWidth = 2.6) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M4.5 12.5 L9.8 17.8 L19.5 6.2");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", stroke);
  path.setAttribute("stroke-width", String(strokeWidth));
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

function isSafeHttpUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function appendLinkedText(parent, text) {
  if (!text) return;
  const parts = String(text).split(/(https?:\/\/[^\s<>"'`]+)/g);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (i % 2 === 1 && isSafeHttpUrl(part)) {
      parent.append(el("a", { href: part, target: "_blank", rel: "noopener noreferrer", text: part }));
    } else {
      parent.append(document.createTextNode(part));
    }
  }
}

function toChineseNumeral(n) {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (n <= 9) return digits[n];
  if (n === 10) return "十";
  if (n < 20) return `十${digits[n % 10]}`;
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const rem = n % 10;
    return `${digits[tens]}十${rem ? digits[rem] : ""}`;
  }
  return String(n);
}

function toast(message, isError = false) {
  const host = $("toast-host");
  const node = el("div", { class: `toast${isError ? " is-error" : ""}`, text: message });
  host.append(node);
  setTimeout(() => node.remove(), isError ? 4200 : 2400);
}

function showBanner(message, actionLabel, onAction) {
  const banner = $("banner");
  banner.innerHTML = "";
  banner.append(el("span", { text: message }));
  if (actionLabel && onAction) {
    banner.append(el("button", { type: "button", class: "paper-btn", text: actionLabel, onClick: onAction }));
  }
  banner.classList.remove("hidden");
}

function hideBanner() {
  $("banner").classList.add("hidden");
}

function actorLabel(id) {
  if (!id) return "未指派";
  return state.actorMap.get(id)?.display_name || id;
}

function formatClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatRelative(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatDateTimeShort(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function toDatetimeLocalValue(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatLeaseRemaining(leaseUntil) {
  if (!leaseUntil) return "";
  const diff = leaseUntil - Date.now();
  if (diff <= 0) return "租约已过期";
  const mins = Math.ceil(diff / 60_000);
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `剩 ${h}h${m}m` : `剩 ${h}h`;
  }
  return `剩 ${mins}m`;
}

let demoMemoryStore = null;

function demoId(prefix = "01DEMO") {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function createDemoSeed() {
  const now = Date.now();
  const min = 60_000;
  const hr = 3600_000;
  const day = 86400_000;

  const actors = [
    { id: "me", kind: "human", display_name: "Me" },
    { id: "grok-bot", kind: "agent", display_name: "Grok bot" },
    { id: "memoh", kind: "agent", display_name: "Memoh" },
    { id: "muse", kind: "agent", display_name: "Muse" },
  ];

  const tasks = [
    {
      id: "01DEMO_REVIEW_BLOG_CODE",
      title: "修复代码块行号对齐与深色配色对比度",
      description: "文章页长代码块在移动端横向滚动时行号与代码行轻微错位，且注释文本对比度偏低。",
      acceptance: "桌面与移动端行号完全对齐，Shiki 注释文字在代码底色上对比度 >= 4.5:1。",
      project: "blog",
      priority: 1,
      status: "review",
      assignee: "muse",
      created_by: "me",
      claimed_by: "muse",
      lease_until: null,
      due_at: null,
      version: 3,
      created_at: now - 5 * hr,
      updated_at: now - 14 * min,
      closed_at: null,
      depends_on: [],
      artifacts: [
        {
          id: "art-1",
          task_id: "01DEMO_REVIEW_BLOG_CODE",
          kind: "pr",
          url: "https://github.com/Aumnertic/todo-hub",
          note: "fix/code-block-contrast (#42)",
          created_by: "muse",
          created_at: now - 14 * min,
        },
      ],
      events: [
        { id: "ev-1", task_id: "01DEMO_REVIEW_BLOG_CODE", actor: "me", type: "created", from_status: null, to_status: "todo", body: null, created_at: now - 5 * hr },
        { id: "ev-2", task_id: "01DEMO_REVIEW_BLOG_CODE", actor: "muse", type: "claimed", from_status: "todo", to_status: "claimed", body: null, created_at: now - 48 * min },
        { id: "ev-3", task_id: "01DEMO_REVIEW_BLOG_CODE", actor: "muse", type: "submitted", from_status: "claimed", to_status: "review", body: "已改为 CSS Grid 双列行号布局并调亮注释 token，已通过本地截图回归。", created_at: now - 14 * min },
      ],
    },
    {
      id: "01DEMO_BLOCKED_HOMEPAGE",
      title: "主页 now.txt 数据同步的触发防抖策略确认",
      description: "需要将 now.txt 状态写入 D1 后自动触发静态站 Deploy Hook。",
      acceptance: "避免连续编辑 3 个字段时短时间内触发多次重构建。",
      project: "homepage",
      priority: 1,
      status: "blocked",
      assignee: "grok-bot",
      created_by: "me",
      claimed_by: null,
      lease_until: null,
      due_at: null,
      version: 2,
      created_at: now - 6 * hr,
      updated_at: now - 28 * min,
      closed_at: null,
      depends_on: [],
      artifacts: [],
      events: [
        { id: "ev-4", task_id: "01DEMO_BLOCKED_HOMEPAGE", actor: "me", type: "created", from_status: null, to_status: "todo", body: null, created_at: now - 6 * hr },
        { id: "ev-5", task_id: "01DEMO_BLOCKED_HOMEPAGE", actor: "grok-bot", type: "claimed", from_status: "todo", to_status: "claimed", body: null, created_at: now - 40 * min },
        { id: "ev-6", task_id: "01DEMO_BLOCKED_HOMEPAGE", actor: "grok-bot", type: "blocked", from_status: "claimed", to_status: "blocked", body: "你更倾向在 Worker 里做 60 秒合并防抖后自动发布，还是保留一个手动点发布的按钮？", created_at: now - 28 * min },
      ],
    },
    {
      id: "01DEMO_PROPOSED_SEARCH",
      title: "为 /v1/tasks 接口补充全文关键字检索参数",
      description: "轮询扫描时发现任务增多后，客户端全量拉取再过滤会增大带宽开销，建议服务端支持 ?q= 模糊匹配标题与描述。",
      acceptance: "GET /v1/tasks?q=关键词 可配合 status / project 组合过滤并附单元测试。",
      project: "todo-hub",
      priority: 2,
      status: "proposed",
      assignee: null,
      created_by: "memoh",
      claimed_by: null,
      lease_until: null,
      due_at: null,
      version: 1,
      created_at: now - 3 * hr,
      updated_at: now - 3 * hr,
      closed_at: null,
      depends_on: [],
      artifacts: [],
      events: [
        { id: "ev-7", task_id: "01DEMO_PROPOSED_SEARCH", actor: "memoh", type: "created", from_status: null, to_status: "proposed", body: null, created_at: now - 3 * hr },
      ],
    },
    {
      id: "01DEMO_CLAIMED_MCP",
      title: "为 MCP 工具补充结构化错误码与重试提示",
      description: "当 Agent 遇到 version_conflict 或 blocked_by_deps 时，返回更明确的可恢复指引。",
      acceptance: "mcp.test.ts 覆盖冲突与前置依赖拦截的返回值断言。",
      project: "todo-hub",
      priority: 1,
      status: "claimed",
      assignee: "muse",
      created_by: "me",
      claimed_by: "muse",
      lease_until: now + 22 * min,
      due_at: null,
      version: 2,
      created_at: now - 8 * hr,
      updated_at: now - 8 * min,
      closed_at: null,
      depends_on: [],
      artifacts: [],
      events: [
        { id: "ev-8", task_id: "01DEMO_CLAIMED_MCP", actor: "me", type: "created", from_status: null, to_status: "todo", body: null, created_at: now - 8 * hr },
        { id: "ev-9", task_id: "01DEMO_CLAIMED_MCP", actor: "muse", type: "claimed", from_status: "todo", to_status: "claimed", body: null, created_at: now - 8 * min },
      ],
    },
    {
      id: "01DEMO_HP_STEP1",
      title: "主页静态重构 ①：抽离本地 JSON 数据模板",
      description: "将 now.txt 与 stack.toml 区块拆为模板占位符，支持 build.mjs 静态生成。",
      acceptance: "运行 node build.mjs 可生成完整 dist/index.html。",
      project: "homepage",
      priority: 1,
      status: "todo",
      assignee: "me",
      created_by: "me",
      claimed_by: null,
      lease_until: null,
      due_at: now + 2 * day,
      version: 1,
      created_at: now - 1 * day,
      updated_at: now - 1 * day,
      closed_at: null,
      depends_on: [],
      artifacts: [],
      events: [
        { id: "ev-10", task_id: "01DEMO_HP_STEP1", actor: "me", type: "created", from_status: null, to_status: "todo", body: null, created_at: now - 1 * day },
      ],
    },
    {
      id: "01DEMO_HP_STEP2",
      title: "主页静态重构 ②：接入 D1 只读构建数据源",
      description: "构建脚本改为通过 Cloudflare D1 REST API 拉取最新数据并注入静态页。",
      acceptance: "Pages 构建环境注入只读 Token 后可零停机更新主页内容。",
      project: "homepage",
      priority: 2,
      status: "todo",
      assignee: "grok-bot",
      created_by: "me",
      claimed_by: null,
      lease_until: null,
      due_at: null,
      version: 1,
      created_at: now - 23 * hr,
      updated_at: now - 23 * hr,
      closed_at: null,
      depends_on: ["01DEMO_HP_STEP1"],
      artifacts: [],
      events: [
        { id: "ev-11", task_id: "01DEMO_HP_STEP2", actor: "me", type: "created", from_status: null, to_status: "todo", body: null, created_at: now - 23 * hr },
      ],
    },
    {
      id: "01DEMO_HP_STEP3",
      title: "主页静态重构 ③：配置 Deploy Hook 自动发布",
      description: "数据变更后自动 POST Deploy Hook 触发重新部署。",
      acceptance: "更新一条 now 状态后 30 秒内线上主页刷新生效。",
      project: "homepage",
      priority: 2,
      status: "todo",
      assignee: "memoh",
      created_by: "me",
      claimed_by: null,
      lease_until: null,
      due_at: null,
      version: 1,
      created_at: now - 22 * hr,
      updated_at: now - 22 * hr,
      closed_at: null,
      depends_on: ["01DEMO_HP_STEP2"],
      artifacts: [],
      events: [
        { id: "ev-12", task_id: "01DEMO_HP_STEP3", actor: "me", type: "created", from_status: null, to_status: "todo", body: null, created_at: now - 22 * hr },
      ],
    },
    {
      id: "01DEMO_TODO_INLINE",
      title: "探索纸面原位即点即改（去表单化编辑）",
      description: "双击任务标题直接进入行内改字，点击标签弹出小印章面板秒改优先级与指派人。",
      acceptance: "常用改标题、调优先级操作不需要再打开弹窗。",
      project: "todo-hub",
      priority: 2,
      status: "todo",
      assignee: "me",
      created_by: "me",
      claimed_by: null,
      lease_until: null,
      due_at: null,
      version: 1,
      created_at: now - 16 * hr,
      updated_at: now - 16 * hr,
      closed_at: null,
      depends_on: [],
      artifacts: [],
      events: [
        { id: "ev-13", task_id: "01DEMO_TODO_INLINE", actor: "me", type: "created", from_status: null, to_status: "todo", body: null, created_at: now - 16 * hr },
      ],
    },
    {
      id: "01DEMO_BLOG_AI",
      title: "文章发布后用 Workers AI 自动生成双语摘要",
      description: "在文章构建或评论 Worker 中调用摘要模型生成 120 字导语。",
      acceptance: "新发布文章自动生成摘要并回填 frontmatter。",
      project: "blog",
      priority: 2,
      status: "todo",
      assignee: null,
      created_by: "me",
      claimed_by: null,
      lease_until: null,
      due_at: null,
      version: 1,
      created_at: now - 12 * hr,
      updated_at: now - 12 * hr,
      closed_at: null,
      depends_on: [],
      artifacts: [],
      events: [
        { id: "ev-14", task_id: "01DEMO_BLOG_AI", actor: "me", type: "created", from_status: null, to_status: "todo", body: null, created_at: now - 12 * hr },
      ],
    },
    {
      id: "01DEMO_HD2D_SHADER",
      title: "HD-2D 像素场景渲染引擎：搭建 wgpu 景深后处理管线",
      description: "在 Rust + wgpu 渲染管线中加入 tilt-shift 倾斜移轴景深与像素对齐采样。",
      acceptance: "60fps 下渲染像素网格无亚像素闪烁。",
      project: "hd2d-engine",
      priority: 3,
      status: "todo",
      assignee: "me",
      created_by: "me",
      claimed_by: null,
      lease_until: null,
      due_at: null,
      version: 1,
      created_at: now - 2 * day,
      updated_at: now - 2 * day,
      closed_at: null,
      depends_on: [],
      artifacts: [],
      events: [
        { id: "ev-15", task_id: "01DEMO_HD2D_SHADER", actor: "me", type: "created", from_status: null, to_status: "todo", body: null, created_at: now - 2 * day },
      ],
    },
    {
      id: "01DEMO_DONE_UI",
      title: "Todo Hub 手帐活页打卡纸前端界面与 GitHub Pages 展示分流",
      description: "Studio & Paper 分离工作台、右侧扇形旋转纸张叠放、页内自动分页与演示沙盒。",
      acceptance: "生产版走 D1 + Access，GitHub Pages 展示版自动切换本地交互沙盒。",
      project: "todo-hub",
      priority: 1,
      status: "done",
      assignee: "me",
      created_by: "me",
      claimed_by: null,
      lease_until: null,
      due_at: null,
      version: 4,
      created_at: now - 3 * day,
      updated_at: now - 1 * hr,
      closed_at: now - 1 * hr,
      depends_on: [],
      artifacts: [
        {
          id: "art-2",
          task_id: "01DEMO_DONE_UI",
          kind: "preview",
          url: "https://github.com/Aumnertic/todo-hub",
          note: "Aumnertic/todo-hub",
          created_by: "me",
          created_at: now - 1 * hr,
        },
      ],
      events: [
        { id: "ev-16", task_id: "01DEMO_DONE_UI", actor: "me", type: "completed", from_status: "todo", to_status: "done", body: "已完成上线并接入 Cloudflare Workers Builds。", created_at: now - 1 * hr },
      ],
    },
    {
      id: "01DEMO_DONE_MCP",
      title: "接入 Cloudflare Access Service Token 与 Streamable HTTP MCP",
      description: "让 Muse、Grok bot 与 Memoh 定时轮询 claim-next 自动领取并汇报任务。",
      acceptance: "humanOnly 工具对 Agent 不可见，租约超时自动回队。",
      project: "todo-hub",
      priority: 1,
      status: "done",
      assignee: "me",
      created_by: "me",
      claimed_by: null,
      lease_until: null,
      due_at: null,
      version: 2,
      created_at: now - 5 * day,
      updated_at: now - 4 * day,
      closed_at: now - 4 * day,
      depends_on: [],
      artifacts: [],
      events: [
        { id: "ev-17", task_id: "01DEMO_DONE_MCP", actor: "me", type: "completed", from_status: "todo", to_status: "done", body: null, created_at: now - 4 * day },
      ],
    },
    {
      id: "01DEMO_DONE_BLOG",
      title: "博客上线 Cloudflare Workers + D1 评论区与邮件提醒",
      description: "零第三方脚本的轻量评论系统。",
      acceptance: "评论提交后自动发送审核与回复通知。",
      project: "blog",
      priority: 2,
      status: "done",
      assignee: "muse",
      created_by: "me",
      claimed_by: "muse",
      lease_until: null,
      due_at: null,
      version: 3,
      created_at: now - 6 * day,
      updated_at: now - 5 * day,
      closed_at: now - 5 * day,
      depends_on: [],
      artifacts: [],
      events: [
        { id: "ev-18", task_id: "01DEMO_DONE_BLOG", actor: "muse", type: "submitted", from_status: "claimed", to_status: "review", body: "部署完成并验证邮件投递。", created_at: now - 5 * day - hr },
        { id: "ev-19", task_id: "01DEMO_DONE_BLOG", actor: "me", type: "approved", from_status: "review", to_status: "done", body: null, created_at: now - 5 * day },
      ],
    },
  ];

  return { actors, tasks };
}

function loadDemoStore() {
  if (demoMemoryStore) return demoMemoryStore;
  try {
    const raw = sessionStorage.getItem(DEMO_STORAGE_KEY);
    if (raw) {
      demoMemoryStore = JSON.parse(raw);
      return demoMemoryStore;
    }
  } catch {
    // ignore storage errors
  }
  demoMemoryStore = createDemoSeed();
  saveDemoStore(demoMemoryStore);
  return demoMemoryStore;
}

function saveDemoStore(store) {
  demoMemoryStore = store;
  try {
    sessionStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore storage errors
  }
}

function resetDemoStore() {
  demoMemoryStore = createDemoSeed();
  saveDemoStore(demoMemoryStore);
  return demoMemoryStore;
}

function demoError(status, code, message, task) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (task) err.task = task;
  throw err;
}

async function demoApi(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const url = new URL(path, "https://demo.local");
  const pathname = url.pathname;
  const body = options.body || {};
  const headers = options.headers || {};

  const store = loadDemoStore();
  const actorId = state.devActor || "me";
  const actor = store.actors.find((a) => a.id === actorId) || store.actors[0];
  const isHuman = actor.kind === "human";
  const now = Date.now();
  const clone = (v) => structuredClone(v);

  const findTask = (id) => {
    const t = store.tasks.find((x) => x.id === id);
    if (!t) demoError(404, "not_found", `task ${id} not found`);
    return t;
  };

  const pushEvent = (t, type, fromStatus, toStatus, evBody = null) => {
    t.events.push({
      id: demoId("EV"),
      task_id: t.id,
      actor: actor.id,
      type,
      from_status: fromStatus,
      to_status: toStatus,
      body: evBody,
      created_at: now,
    });
  };

  if (method === "GET" && pathname === "/v1/me") {
    return clone({ id: actor.id, kind: actor.kind, display_name: actor.display_name, email: null });
  }

  if (method === "GET" && pathname === "/v1/actors") {
    return clone({ actors: store.actors });
  }

  if (method === "GET" && pathname === "/v1/tasks") {
    return clone({ tasks: store.tasks });
  }

  if (method === "POST" && pathname === "/v1/tasks") {
    const title = String(body.title || "").trim();
    if (!title) demoError(400, "bad_request", "title is required");
    const status = isHuman ? "todo" : "proposed";
    const created = {
      id: demoId("01DEMO"),
      title,
      description: String(body.description || ""),
      acceptance: String(body.acceptance || ""),
      project: body.project ? String(body.project).trim() : null,
      priority: Number.isInteger(body.priority) ? body.priority : 2,
      status,
      assignee: body.assignee || null,
      created_by: actor.id,
      claimed_by: null,
      lease_until: null,
      due_at: body.due_at ? Date.parse(body.due_at) || null : null,
      version: 1,
      created_at: now,
      updated_at: now,
      closed_at: null,
      depends_on: Array.isArray(body.depends_on) ? [...new Set(body.depends_on)] : [],
      artifacts: [],
      events: [],
    };
    pushEvent(created, "created", null, status, null);
    store.tasks.unshift(created);
    saveDemoStore(store);
    return clone(created);
  }

  const singleMatch = pathname.match(/^\/v1\/tasks\/([^/]+)$/);
  if (singleMatch) {
    const t = findTask(singleMatch[1]);
    if (method === "GET") return clone(t);
    if (method === "PATCH") {
      const ownProposal = t.status === "proposed" && t.created_by === actor.id;
      if (!isHuman && !ownProposal) demoError(403, "forbidden", "agents can only edit their own proposed tasks", t);
      const ifMatch = headers instanceof Headers ? headers.get("If-Match") : headers["If-Match"];
      const reqVer = ifMatch ? Number(String(ifMatch).replace(/"/g, "")) : body.version;
      if (reqVer !== t.version) demoError(409, "version_conflict", `task was modified (version is ${t.version})`, clone(t));

      const beforeStatus = t.status;
      if (body.title !== undefined) t.title = String(body.title).trim();
      if (body.description !== undefined) t.description = String(body.description);
      if (body.acceptance !== undefined) t.acceptance = String(body.acceptance);
      if (body.project !== undefined) t.project = body.project ? String(body.project).trim() : null;
      if (body.priority !== undefined) t.priority = Number(body.priority);
      if (body.due_at !== undefined) t.due_at = body.due_at ? Date.parse(body.due_at) || null : null;
      if (body.depends_on !== undefined) t.depends_on = [...new Set(body.depends_on)];
      if (body.assignee !== undefined) {
        t.assignee = body.assignee || null;
        if (t.status === "claimed" && t.assignee && t.claimed_by !== t.assignee) {
          t.status = "todo";
          t.claimed_by = null;
          t.lease_until = null;
        }
      }
      t.version += 1;
      t.updated_at = now;
      pushEvent(t, "edited", beforeStatus, t.status, Object.keys(body).join(", "));
      saveDemoStore(store);
      return clone(t);
    }
  }

  const actionMatch = pathname.match(/^\/v1\/tasks\/([^/]+)\/([a-z-]+)$/);
  if (actionMatch && method === "POST") {
    const t = findTask(actionMatch[1]);
    const action = actionMatch[2];
    const prev = t.status;

    const hasOpenDeps = () =>
      (t.depends_on || []).some((depId) => {
        const dep = store.tasks.find((x) => x.id === depId);
        return dep && dep.status !== "done" && dep.status !== "cancelled";
      });

    switch (action) {
      case "claim": {
        if (t.assignee && t.assignee !== actor.id) demoError(403, "not_assignee", `task is assigned to ${t.assignee}`, t);
        if (t.status === "proposed") demoError(409, "not_accepted", "task is still a proposal awaiting human approval", t);
        if (t.status === "claimed" && (t.lease_until || 0) >= now && t.claimed_by !== actor.id) {
          demoError(409, "already_claimed", `task is claimed by ${t.claimed_by}`, t);
        }
        if (t.status === "todo" && hasOpenDeps()) demoError(409, "blocked_by_deps", "task has unfinished dependencies", t);
        if (!["todo", "claimed"].includes(t.status)) demoError(409, "invalid_state", `cannot claim a task in status ${t.status}`, t);

        const reclaim = t.status === "claimed" && t.claimed_by === actor.id;
        t.status = "claimed";
        t.claimed_by = actor.id;
        t.lease_until = now + 30 * min;
        t.version += 1;
        t.updated_at = now;
        if (!reclaim) pushEvent(t, "claimed", prev, "claimed", null);
        break;
      }
      case "heartbeat": {
        if (t.status !== "claimed" || t.claimed_by !== actor.id) demoError(409, "not_holder", "you do not hold this task", t);
        t.lease_until = now + 30 * min;
        t.updated_at = now;
        break;
      }
      case "release": {
        if (t.status !== "claimed" || t.claimed_by !== actor.id) demoError(409, "not_holder", "you do not hold this task", t);
        t.status = "todo";
        t.claimed_by = null;
        t.lease_until = null;
        t.version += 1;
        t.updated_at = now;
        pushEvent(t, "released", prev, "todo", body.note || null);
        break;
      }
      case "block": {
        if (t.status !== "claimed" || t.claimed_by !== actor.id) demoError(409, "not_holder", "you do not hold this task", t);
        const q = String(body.question || "").trim();
        if (!q) demoError(400, "bad_request", "question is required");
        t.status = "blocked";
        t.assignee = t.assignee || actor.id;
        t.claimed_by = null;
        t.lease_until = null;
        t.version += 1;
        t.updated_at = now;
        pushEvent(t, "blocked", prev, "blocked", q);
        break;
      }
      case "submit": {
        if (t.status !== "claimed" || t.claimed_by !== actor.id) demoError(409, "not_holder", "you do not hold this task", t);
        const summary = String(body.summary || "").trim();
        if (!summary) demoError(400, "bad_request", "summary is required");
        if (Array.isArray(body.artifacts)) {
          for (const a of body.artifacts) {
            if (a?.url) {
              t.artifacts.push({
                id: demoId("ART"),
                task_id: t.id,
                kind: a.kind || "url",
                url: a.url,
                note: a.note || null,
                created_by: actor.id,
                created_at: now,
              });
            }
          }
        }
        t.status = "review";
        t.lease_until = null;
        t.version += 1;
        t.updated_at = now;
        pushEvent(t, "submitted", prev, "review", summary);
        break;
      }
      case "artifacts": {
        if (!isHuman && !(t.status === "claimed" && t.claimed_by === actor.id)) {
          demoError(409, "not_holder", "only the holder can attach artifacts", t);
        }
        for (const a of body.artifacts || []) {
          t.artifacts.push({
            id: demoId("ART"),
            task_id: t.id,
            kind: a.kind || "url",
            url: a.url,
            note: a.note || null,
            created_by: actor.id,
            created_at: now,
          });
        }
        saveDemoStore(store);
        return clone({ artifacts: t.artifacts });
      }
      case "comments": {
        const text = String(body.body || "").trim();
        if (!text) demoError(400, "bad_request", "body is required");
        if (t.status === "blocked" && isHuman) {
          t.status = "todo";
          t.version += 1;
          t.updated_at = now;
          pushEvent(t, "answered", prev, "todo", text);
        } else {
          pushEvent(t, "commented", null, null, text);
        }
        break;
      }
      case "accept": {
        if (!isHuman) demoError(403, "human_only", "only a human can accept proposals");
        if (t.status !== "proposed") demoError(422, "invalid_transition", "not in proposed status", t);
        t.status = "todo";
        t.version += 1;
        t.updated_at = now;
        pushEvent(t, "accepted", prev, "todo", body.note || null);
        break;
      }
      case "approve": {
        if (!isHuman) demoError(403, "human_only", "only a human can approve");
        if (t.status !== "review") demoError(422, "invalid_transition", "not in review status", t);
        t.status = "done";
        t.closed_at = now;
        t.version += 1;
        t.updated_at = now;
        pushEvent(t, "approved", prev, "done", body.note || null);
        break;
      }
      case "reject": {
        if (!isHuman) demoError(403, "human_only", "only a human can reject");
        if (t.status !== "review") demoError(422, "invalid_transition", "not in review status", t);
        const fb = String(body.feedback || "").trim();
        if (!fb) demoError(400, "bad_request", "feedback is required");
        t.status = "todo";
        t.assignee = t.assignee || t.claimed_by;
        t.claimed_by = null;
        t.lease_until = null;
        t.version += 1;
        t.updated_at = now;
        pushEvent(t, "rejected", prev, "todo", fb);
        break;
      }
      case "complete": {
        if (!isHuman) demoError(403, "human_only", "only a human can complete tasks directly");
        if (!["todo", "claimed", "blocked", "review"].includes(t.status)) {
          demoError(422, "invalid_transition", `cannot complete a task in status ${t.status}`, t);
        }
        t.status = "done";
        t.lease_until = null;
        t.closed_at = now;
        t.version += 1;
        t.updated_at = now;
        pushEvent(t, "completed", prev, "done", body.note || null);
        break;
      }
      case "cancel": {
        const ownProp = t.status === "proposed" && t.created_by === actor.id;
        if (!isHuman && !ownProp) demoError(403, "forbidden", "agents can only cancel their own proposals", t);
        if (["done", "cancelled"].includes(t.status)) demoError(422, "invalid_transition", "already closed", t);
        t.status = "cancelled";
        t.claimed_by = null;
        t.lease_until = null;
        t.closed_at = now;
        t.version += 1;
        t.updated_at = now;
        pushEvent(t, "cancelled", prev, "cancelled", body.reason || null);
        break;
      }
      case "reopen": {
        if (!isHuman) demoError(403, "human_only", "only a human can reopen");
        if (!["done", "cancelled"].includes(t.status)) demoError(422, "invalid_transition", "not closed", t);
        t.status = "todo";
        t.claimed_by = null;
        t.closed_at = null;
        t.version += 1;
        t.updated_at = now;
        pushEvent(t, "reopened", prev, "todo", body.reason || null);
        break;
      }
      default:
        demoError(404, "not_found", `unknown action: ${action}`);
    }

    saveDemoStore(store);
    return clone(t);
  }

  demoError(404, "not_found", `no such demo route: ${method} ${pathname}`);
}

async function api(path, options = {}) {
  if (IS_DEMO_MODE) {
    return demoApi(path, options);
  }
  const headers = new Headers(options.headers || {});
  if (IS_LOCAL_DEV && state.devActor) {
    headers.set("X-Dev-Actor", state.devActor);
  }
  if (options.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: { code: "bad_response", message: text || `HTTP ${res.status}` } };
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `请求失败 (${res.status})`);
    err.status = res.status;
    err.code = data?.error?.code;
    err.task = data?.task;
    throw err;
  }
  return data;
}

/* ---- Studio 左侧控制坞 & 旋转底层可点击纸张 ---- */
function buildTabsList() {
  const tabs = [{ id: "all", label: "全部成员", accent: "#e8dfd0" }];
  let agentIdx = 0;
  for (const a of state.actors) {
    const accent = a.kind === "human" ? "#d95040" : AGENT_ACCENTS[agentIdx++ % AGENT_ACCENTS.length];
    tabs.push({ id: a.id, label: a.display_name, accent });
  }
  tabs.push({ id: "unassigned", label: "公共池", accent: "#9b9487" });
  return tabs;
}

function tasksForSheet(sheetId) {
  if (sheetId === "all") return state.tasks;
  if (sheetId === "unassigned") return state.tasks.filter((t) => t.assignee === null && !t.claimed_by);
  return state.tasks.filter((t) => t.assignee === sheetId || t.claimed_by === sheetId);
}

function renderStudioTabs() {
  const nav = $("index-tabs");
  nav.innerHTML = "";
  const tabs = buildTabsList();

  const totalOpen = state.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled").length;
  $("studio-sub").textContent = `共 ${tabs.length} 张纸 · ${totalOpen} 项待办`;

  for (const tab of tabs) {
    const list = tasksForSheet(tab.id);
    const openCount = list.filter((t) => t.status !== "done" && t.status !== "cancelled").length;
    const attentionCount = list.filter((t) => ["review", "blocked", "proposed"].includes(t.status)).length;
    const claimedCount = list.filter((t) => t.status === "claimed").length;

    const labelChildren = [el("span", { class: "tab-name", text: tab.label })];
    if (attentionCount > 0) {
      labelChildren.push(el("span", { class: "tab-dot", title: `${attentionCount} 项待拍板` }));
    } else if (claimedCount > 0) {
      labelChildren.push(el("span", { class: "tab-dot is-working", title: `${claimedCount} 项执行中` }));
    }

    nav.append(
      el("button", {
        type: "button",
        class: `studio-tab${state.activeSheet === tab.id ? " is-active" : ""}`,
        style: `--tab-accent: ${tab.accent}`,
        "aria-pressed": state.activeSheet === tab.id ? "true" : "false",
        onClick: () => switchSheet(tab.id),
      }, [
        el("span", { class: "tab-label-wrap" }, labelChildren),
        el("span", { class: "tab-count", text: String(openCount) }),
      ]),
    );
  }

  const activeTab = tabs.find((t) => t.id === state.activeSheet);
  $("sheet-badge").textContent = activeTab ? activeTab.label : "全部成员";
}

function renderUnderSheets() {
  const host = $("under-sheets");
  host.innerHTML = "";
  const tabs = buildTabsList();
  const curIdx = Math.max(0, tabs.findIndex((t) => t.id === state.activeSheet));

  const nextSheets = [];
  for (let offset = 1; offset <= Math.min(3, tabs.length - 1); offset++) {
    nextSheets.push(tabs[(curIdx + offset) % tabs.length]);
  }

  nextSheets.forEach((tab, idx) => {
    const openCount = tasksForSheet(tab.id).filter((t) => t.status !== "done" && t.status !== "cancelled").length;
    host.append(
      el("button", {
        type: "button",
        class: `under-sheet layer-${idx + 1}`,
        dataset: { sheetId: tab.id },
        title: `点击切换到「${tab.label}」纸张（${openCount} 项待办）`,
        "aria-label": `切换到 ${tab.label} 纸张`,
        onClick: () => switchSheet(tab.id),
      }, [
        el("span", { class: "under-sheet-tag" }, [
          el("span", { text: tab.label }),
          el("span", { class: "under-sheet-count", text: String(openCount) }),
        ]),
      ]),
    );
  });
}

function switchSheet(nextSheetId) {
  if (nextSheetId === state.activeSheet) return;
  const tabs = buildTabsList();
  const prevIdx = tabs.findIndex((t) => t.id === state.activeSheet);
  const nextIdx = tabs.findIndex((t) => t.id === nextSheetId);
  const dir = nextIdx >= prevIdx ? "down" : "up";

  const sheet = $("sheet");
  const ghost = $("sheet-ghost");
  const stack = $("sheet-stack");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!reduceMotion && sheet && ghost && stack) {
    if (state.switchTimer) clearTimeout(state.switchTimer);

    ghost.innerHTML = sheet.innerHTML;
    for (const node of ghost.querySelectorAll("[id]")) {
      node.removeAttribute("id");
    }
    ghost.className = "sheet-ghost";
    void ghost.offsetWidth;
    ghost.classList.add(dir === "down" ? "fly-down" : "fly-up");

    sheet.classList.remove("is-entering");
    void sheet.offsetWidth;
    sheet.classList.add("is-entering");

    stack.classList.add("is-switching");
    state.switchTimer = setTimeout(() => {
      ghost.className = "sheet-ghost hidden";
      ghost.innerHTML = "";
      sheet.classList.remove("is-entering");
      stack.classList.remove("is-switching");
      state.switchTimer = null;
    }, 380);
  }

  state.activeSheet = nextSheetId;
  const view = getSheetView(nextSheetId);
  $("filter-search").value = view.searchQuery;

  renderStudioTabs();
  renderUnderSheets();
  updateStampAndCounts();
  renderProjectPills();
  renderSections();
}

/* ---- 页头时间、进度环与同步状态 ---- */
function updateCalendarMeta() {
  const now = new Date();
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  $("meta-date").textContent = `${now.getMonth() + 1}/${String(now.getDate()).padStart(2, "0")}`;
  $("meta-weekday").textContent = weekdays[now.getDay()];
}

function updateStampAndCounts() {
  const sheetTasks = tasksForSheet(state.activeSheet);
  const active = sheetTasks.filter((t) => t.status !== "cancelled");
  const doneCount = active.filter((t) => t.status === "done").length;
  const totalCount = active.length;
  const openCount = active.filter((t) => t.status !== "done").length;

  $("stamp-ratio").textContent = `${doneCount}/${totalCount}`;
  const ratio = totalCount ? doneCount / totalCount : 0;
  $("stamp-arc").style.strokeDashoffset = String(STAMP_CIRCUMFERENCE * (1 - ratio));
  $("meta-pending").textContent = `${openCount} 项`;
}

function updateSyncStatus() {
  const syncEl = $("sync-meta");
  if (!state.me) {
    syncEl.textContent = "(未认证)";
    return;
  }
  const who = `${state.me.display_name}${state.me.kind === "agent" ? " [Agent]" : ""}`;
  if (IS_DEMO_MODE) {
    syncEl.textContent = `(展示沙盒 · 身份: ${who})`;
    return;
  }
  const when = state.lastSyncAt ? ` · 上次同步: ${formatClock(state.lastSyncAt)}` : "";
  syncEl.textContent = `(身份: ${who}${when})`;
}

/* ---- 自定义本地开发 / 展示视角切换菜单 ---- */
function renderDevActorSwitcher() {
  const wrap = $("dev-actor-wrap");
  const menu = $("dev-actor-menu");
  if (!CAN_SWITCH_ACTOR) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  $("dev-actor-label").textContent = state.devActor || "me";
  menu.innerHTML = "";

  const candidates = state.actors.length
    ? state.actors
    : [
        { id: "me", display_name: "Me", kind: "human" },
        { id: "muse", display_name: "Muse", kind: "agent" },
        { id: "grok-bot", display_name: "Grok bot", kind: "agent" },
      ];

  for (const a of candidates) {
    menu.append(
      el("button", {
        type: "button",
        role: "option",
        class: `dev-actor-opt${state.devActor === a.id ? " is-selected" : ""}`,
        text: `${a.display_name} (${a.id})`,
        onClick: async () => {
          menu.classList.add("hidden");
          $("dev-actor-btn").setAttribute("aria-expanded", "false");
          if (state.devActor === a.id) return;
          state.devActor = a.id;
          setStoredActor(a.id);
          await loadAll();
        },
      }),
    );
  }
}

/* ---- 页内项目标签栏（仅作用于当前纸张） ---- */
function renderProjectPills() {
  const host = $("project-pills");
  host.innerHTML = "";
  const view = getSheetView(state.activeSheet);

  const sheetTasks = tasksForSheet(state.activeSheet);
  const openTasks = sheetTasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const counts = new Map();
  for (const t of openTasks) {
    const key = t.project || "__none__";
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  if (view.activeProject && !counts.has(view.activeProject)) {
    const hasArchived = sheetTasks.some((t) => (t.project || "__none__") === view.activeProject);
    if (!hasArchived) view.activeProject = "";
  }

  host.append(
    el("button", {
      type: "button",
      role: "tab",
      class: `project-pill${view.activeProject === "" ? " is-active" : ""}`,
      "aria-selected": view.activeProject === "" ? "true" : "false",
      onClick: () => {
        view.activeProject = "";
        view.currentPage = 1;
        renderProjectPills();
        renderSections();
      },
    }, [
      document.createTextNode("全部项目"),
      el("span", { class: "pill-count", text: String(openTasks.length) }),
    ]),
  );

  const keys = [...counts.keys()].sort((a, b) => {
    if (a === "__none__") return 1;
    if (b === "__none__") return -1;
    return a.localeCompare(b);
  });

  for (const key of keys) {
    const label = key === "__none__" ? "未分类" : `#${key}`;
    const active = view.activeProject === key;
    host.append(
      el("button", {
        type: "button",
        role: "tab",
        class: `project-pill${active ? " is-active" : ""}`,
        "aria-selected": active ? "true" : "false",
        onClick: () => {
          view.activeProject = active ? "" : key;
          view.currentPage = 1;
          renderProjectPills();
          renderSections();
        },
      }, [
        document.createTextNode(label),
        el("span", { class: "pill-count", text: String(counts.get(key)) }),
      ]),
    );
  }
}

/* ---- 拓扑排序与分节分页 ---- */
function topoSortTasks(tasks) {
  if (tasks.length <= 1) return [...tasks];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const inDegree = new Map(tasks.map((t) => [t.id, 0]));
  const dependents = new Map(tasks.map((t) => [t.id, []]));

  for (const t of tasks) {
    for (const depId of t.depends_on || []) {
      if (byId.has(depId)) {
        inDegree.set(t.id, (inDegree.get(t.id) || 0) + 1);
        dependents.get(depId).push(t.id);
      }
    }
  }

  const cmp = (a, b) =>
    (a.status === "claimed" ? 0 : 1) - (b.status === "claimed" ? 0 : 1) ||
    a.priority - b.priority ||
    a.created_at - b.created_at;

  const ready = tasks.filter((t) => inDegree.get(t.id) === 0).sort(cmp);
  const out = [];
  const visited = new Set();

  while (ready.length) {
    const cur = ready.shift();
    if (visited.has(cur.id)) continue;
    visited.add(cur.id);
    out.push(cur);

    let added = false;
    for (const nextId of dependents.get(cur.id) || []) {
      const deg = (inDegree.get(nextId) || 0) - 1;
      inDegree.set(nextId, deg);
      if (deg === 0) {
        ready.push(byId.get(nextId));
        added = true;
      }
    }
    if (added) ready.sort(cmp);
  }

  if (out.length < tasks.length) {
    out.push(...tasks.filter((t) => !visited.has(t.id)).sort(cmp));
  }
  return out;
}

function getRelevantEvents(task) {
  const events = task.events || [];
  return events
    .filter((e) => ["blocked", "submitted", "rejected", "answered", "commented", "lease_expired"].includes(e.type))
    .slice(-3);
}

function hasUnfinishedDeps(task) {
  return (task.depends_on || []).some((depId) => {
    const dep = state.taskMap.get(depId);
    return dep && dep.status !== "done" && dep.status !== "cancelled";
  });
}

function visualLineCount(text, charsPerLine = 48) {
  if (!text) return 0;
  let total = 0;
  for (const line of String(text).split("\n")) {
    let w = 0;
    for (const ch of line) {
      w += ch.charCodeAt(0) <= 255 ? 0.56 : 1;
    }
    total += Math.max(1, Math.ceil(w / charsPerLine));
  }
  return total;
}

function estimateTaskPx(task, isHuman) {
  let h = 50; // 标题行 + 上下 padding
  const titleLines = visualLineCount(task.title, 34);
  if (titleLines > 1) h += (titleLines - 1) * 23;
  if (task.description) h += visualLineCount(task.description, 48) * 21 + 3;
  if (task.acceptance) h += visualLineCount(`【验收】${task.acceptance}`, 50) * 19 + 3;

  const subRows =
    (task.depends_on?.length || 0) +
    (task.artifacts?.length || 0) +
    getRelevantEvents(task).filter((ev) => {
      if (task.status === "blocked" && ev.type === "blocked") return false;
      if (task.status === "review" && ev.type === "submitted" && isHuman) return false;
      return true;
    }).length;
  if (subRows > 0) h += subRows * 22 + 8;

  if (task.status === "blocked") h += isHuman ? 86 : 44;
  else if (task.status === "review" && isHuman) h += 72;
  else if (task.status === "proposed" && isHuman) h += 46;

  return h + 10; // 包含列表间距
}

function paginateSections(descriptors, budgetPx) {
  const pages = [];
  let curPage = [];
  let usedPx = 0;

  const flushPage = () => {
    if (curPage.length) {
      pages.push(curPage);
      curPage = [];
      usedPx = 0;
    }
  };

  for (const desc of descriptors) {
    const headerH = 38 + (desc.isAttention ? 18 : 0);

    if (desc.collapsed || !desc.tasks.length) {
      const needed = headerH + (desc.collapsed ? 4 : 46);
      if (curPage.length && usedPx + needed > budgetPx) flushPage();
      curPage.push({ ...desc, tasks: desc.tasks, continued: false });
      usedPx += needed + 18;
      continue;
    }

    const firstTaskH = estimateTaskPx(desc.tasks[0], state.me?.kind === "human");
    if (curPage.length && usedPx + headerH + firstTaskH > budgetPx) {
      flushPage();
    }

    let chunk = [];
    let isContinuation = false;

    for (const task of desc.tasks) {
      const taskH = estimateTaskPx(task, state.me?.kind === "human");
      const neededHeader = chunk.length === 0 ? headerH : 0;

      if ((curPage.length > 0 || chunk.length > 0) && usedPx + neededHeader + taskH > budgetPx) {
        if (chunk.length > 0) {
          curPage.push({ ...desc, tasks: chunk, continued: isContinuation });
          chunk = [];
          isContinuation = true;
        }
        flushPage();
      }

      if (chunk.length === 0) usedPx += headerH;
      chunk.push(task);
      usedPx += taskH;
    }

    if (chunk.length) {
      curPage.push({ ...desc, tasks: chunk, continued: isContinuation });
      usedPx += 18;
    }
  }

  flushPage();
  return pages.length ? pages : [[]];
}

function buildCheckSvg(status) {
  if (status === "done") {
    return el("svg", { class: "hand-check-mark", viewBox: "0 0 24 24", "aria-hidden": "true" }, [
      (() => {
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", "M5 12.5 L10 17.5 L19.5 6.5");
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", "#b93829");
        p.setAttribute("stroke-width", "2.6");
        p.setAttribute("stroke-linecap", "round");
        p.setAttribute("stroke-linejoin", "round");
        return p;
      })(),
    ]);
  }
  if (status === "cancelled") {
    return el("svg", { class: "hand-check-mark", viewBox: "0 0 24 24", "aria-hidden": "true" }, [
      (() => {
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", "M6 18 L18 6");
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", "#847e73");
        p.setAttribute("stroke-width", "2");
        p.setAttribute("stroke-linecap", "round");
        return p;
      })(),
    ]);
  }
  return null;
}

async function handleCheckClick(task) {
  if (!state.me || state.me.kind !== "human") {
    toast("仅人类身份可直接打卡流转此状态", true);
    return;
  }
  try {
    if (task.status === "review") {
      await api(`/v1/tasks/${task.id}/approve`, { method: "POST", body: {} });
      toast(`已验收通过：${task.title}`);
    } else if (task.status === "proposed") {
      await api(`/v1/tasks/${task.id}/accept`, { method: "POST", body: {} });
      toast(`已批准入队：${task.title}`);
    } else if (task.status === "done" || task.status === "cancelled") {
      await api(`/v1/tasks/${task.id}/reopen`, { method: "POST", body: {} });
      toast(`已重新打开：${task.title}`);
    } else {
      await api(`/v1/tasks/${task.id}/complete`, { method: "POST", body: {} });
      toast(`已打卡完成：${task.title}`);
    }
    await loadAll({ silent: true });
  } catch (err) {
    toast(err.message, true);
  }
}

function buildInlineBox(task) {
  const isHuman = state.me?.kind === "human";
  const panelMode = state.inlinePanels.get(task.id);

  if (task.status === "blocked") {
    const lastQuestion = [...(task.events || [])].reverse().find((e) => e.type === "blocked");
    const box = el("div", { class: "inline-action-box is-blocked" });
    box.append(
      el("div", { class: "inline-prompt" }, [
        el("strong", { text: `${actorLabel(lastQuestion?.actor || task.assignee)} 提问：` }),
        el("span", { text: lastQuestion?.body || "（等待补充信息）" }),
      ]),
    );
    if (isHuman) {
      const input = el("input", {
        type: "text",
        class: "inline-input",
        placeholder: "写下回答，回复后自动回到队列交给原 Agent…",
      });
      box.append(
        el("form", {
          class: "inline-row",
          onSubmit: async (e) => {
            e.preventDefault();
            const answer = input.value.trim();
            if (!answer) return;
            try {
              await api(`/v1/tasks/${task.id}/comments`, { method: "POST", body: { body: answer } });
              toast("已回复并放回队列");
              await loadAll({ silent: true });
            } catch (err) {
              toast(err.message, true);
            }
          },
        }, [
          input,
          el("button", { type: "submit", class: "stamp-btn", text: "回答并放回队列 ↗" }),
        ]),
      );
    }
    return box;
  }

  if (task.status === "review" && isHuman) {
    const lastSub = [...(task.events || [])].reverse().find((e) => e.type === "submitted");
    const box = el("div", { class: "inline-action-box is-review" });
    if (lastSub?.body) {
      box.append(
        el("div", { class: "inline-prompt" }, [
          el("strong", { text: `${actorLabel(lastSub.actor)} 交付说明：` }),
          el("span", { text: lastSub.body }),
        ]),
      );
    }
    box.append(
      el("div", { class: "inline-row" }, [
        el("button", {
          type: "button",
          class: "paper-btn paper-btn-sage",
          text: "通过验收 ✓",
          onClick: async () => {
            try {
              await api(`/v1/tasks/${task.id}/approve`, { method: "POST", body: {} });
              toast("已验收通过");
              await loadAll({ silent: true });
            } catch (err) {
              toast(err.message, true);
            }
          },
        }),
        el("button", {
          type: "button",
          class: "paper-btn paper-btn-danger",
          text: panelMode === "reject" ? "收起驳回框" : "驳回重做",
          onClick: () => {
            state.inlinePanels.set(task.id, panelMode === "reject" ? null : "reject");
            renderSections();
          },
        }),
      ]),
    );

    if (panelMode === "reject") {
      const fbInput = el("input", {
        type: "text",
        class: "inline-input",
        placeholder: "写明修改意见，将退回给原 Agent…",
      });
      box.append(
        el("form", {
          class: "inline-row",
          onSubmit: async (e) => {
            e.preventDefault();
            const feedback = fbInput.value.trim();
            if (!feedback) return;
            try {
              await api(`/v1/tasks/${task.id}/reject`, { method: "POST", body: { feedback } });
              state.inlinePanels.delete(task.id);
              toast("已驳回给原 Agent");
              await loadAll({ silent: true });
            } catch (err) {
              toast(err.message, true);
            }
          },
        }, [
          fbInput,
          el("button", { type: "submit", class: "paper-btn paper-btn-ink", text: "确认驳回" }),
        ]),
      );
    }
    return box;
  }

  if (task.status === "proposed" && isHuman) {
    return el("div", { class: "inline-action-box is-proposed" }, [
      el("div", { class: "inline-row" }, [
        el("span", { class: "hint-text", text: `由 ${actorLabel(task.created_by)} 提议的新任务` }),
        el("button", {
          type: "button",
          class: "paper-btn paper-btn-sage",
          text: "批准入队 ✓",
          onClick: async () => {
            try {
              await api(`/v1/tasks/${task.id}/accept`, { method: "POST", body: {} });
              toast("提案已进入待认领队列");
              await loadAll({ silent: true });
            } catch (err) {
              toast(err.message, true);
            }
          },
        }),
        el("button", {
          type: "button",
          class: "paper-btn paper-btn-danger",
          text: "拒绝取消",
          onClick: async () => {
            try {
              await api(`/v1/tasks/${task.id}/cancel`, { method: "POST", body: { reason: "提案未采纳" } });
              toast("已取消提案");
              await loadAll({ silent: true });
            } catch (err) {
              toast(err.message, true);
            }
          },
        }),
      ]),
    ]);
  }

  return null;
}

function defaultSheetAssignee() {
  if (state.activeSheet === "all" || state.activeSheet === "unassigned") return "";
  return state.activeSheet;
}

function buildTaskItem(task, { showProjectTag = false } = {}) {
  const meta = STATUS_META[task.status] || { label: task.status, cls: "", go: "详情 ↗" };
  const isArchived = task.status === "done" || task.status === "cancelled";
  const isHuman = state.me?.kind === "human";

  const checkTitle = !isHuman
    ? "仅人类可直接打卡流转"
    : task.status === "review"
      ? "点击直接验收通过"
      : task.status === "proposed"
        ? "点击批准入队"
        : isArchived
          ? "点击重新打开"
          : "点击打卡完成";

  const checkBtn = el("button", {
    type: "button",
    class: `hand-check${task.status === "done" ? " is-done" : ""}${task.status === "cancelled" ? " is-cancelled" : ""}`,
    title: checkTitle,
    "aria-label": `${task.title}：${checkTitle}`,
    disabled: !isHuman,
    onClick: () => handleCheckClick(task),
  }, [
    el("span", { class: "hand-check-box" }),
    buildCheckSvg(task.status),
  ]);

  const titleRow = el("div", { class: "task-title-row" }, [
    el("h3", { class: "task-title" }, [
      el("button", {
        type: "button",
        class: "task-title-btn",
        text: task.title,
        onClick: () => openDetailModal(task.id),
      }),
    ]),
    el("span", { class: `tag ${meta.cls}`, text: meta.label }),
    el("span", { class: `tag tag-p${task.priority}`, text: `P${task.priority}` }),
    showProjectTag && task.project ? el("span", { class: "tag tag-project", text: `#${task.project}` }) : null,
  ]);

  if (task.status === "claimed" && task.claimed_by) {
    const lease = task.lease_until ? ` · ${formatLeaseRemaining(task.lease_until)}` : "";
    const expired = task.lease_until && task.lease_until < Date.now();
    titleRow.append(
      el("span", {
        class: `tag ${expired ? "tag-overdue" : "tag-actor"}`,
        text: `持有: ${actorLabel(task.claimed_by)}${lease}`,
      }),
    );
  } else if (task.assignee && state.activeSheet === "all") {
    titleRow.append(el("span", { class: "tag tag-actor", text: `@${actorLabel(task.assignee)}` }));
  }

  if (task.due_at && !isArchived) {
    const overdue = task.due_at < Date.now();
    titleRow.append(
      el("span", {
        class: `tag${overdue ? " tag-overdue" : ""}`,
        text: `${overdue ? "已逾期 " : "截止 "}${formatDateTimeShort(task.due_at)}`,
      }),
    );
  }

  if (task.status === "todo" && hasUnfinishedDeps(task)) {
    titleRow.append(el("span", { class: "tag tag-status-blocked", text: "等待前置依赖" }));
  }

  const main = el("div", { class: "task-main" }, [titleRow]);

  if (task.description) {
    const descEl = el("p", { class: "task-desc" });
    appendLinkedText(descEl, task.description);
    main.append(descEl);
  }

  if (task.acceptance) {
    const accEl = el("p", { class: "task-accept" }, [el("strong", { text: "【验收】" })]);
    appendLinkedText(accEl, task.acceptance);
    main.append(accEl);
  }

  const subRows = [];
  for (const depId of task.depends_on || []) {
    const dep = state.taskMap.get(depId);
    const depTitle = dep ? dep.title : depId;
    const depLabel = dep ? STATUS_META[dep.status]?.label || dep.status : "未知";
    subRows.push(
      el("div", { class: "sub-row" }, [
        el("span", { class: "sub-text" }, [
          el("span", { class: "sub-kind", text: "[依赖]" }),
          document.createTextNode(`${depTitle}（${depLabel}）`),
        ]),
        el("button", {
          type: "button",
          class: "sub-link",
          text: "定位 ↗",
          onClick: () => openDetailModal(depId),
        }),
      ]),
    );
  }

  for (const art of task.artifacts || []) {
    const textNode = el("span", { class: "sub-text" }, [
      el("span", { class: "sub-kind", text: `[${String(art.kind || "url").toUpperCase()}]` }),
      document.createTextNode(art.note || art.url),
    ]);
    const rightNode = isSafeHttpUrl(art.url)
      ? el("a", {
          class: "sub-link",
          href: art.url,
          target: "_blank",
          rel: "noopener noreferrer",
          text: "查看 ↗",
        })
      : el("span", { class: "sub-time", text: formatRelative(art.created_at) });
    subRows.push(el("div", { class: "sub-row" }, [textNode, rightNode]));
  }

  const recentEvents = getRelevantEvents(task);
  for (const ev of recentEvents) {
    if (task.status === "blocked" && ev.type === "blocked") continue;
    if (task.status === "review" && ev.type === "submitted" && isHuman) continue;
    const label = EVENT_LABELS[ev.type] || ev.type;
    const content = ev.body ? `${actorLabel(ev.actor)}（${label}）：${ev.body}` : `${actorLabel(ev.actor)} ${label}`;
    const textEl = el("span", { class: "sub-text" });
    appendLinkedText(textEl, content);
    subRows.push(
      el("div", { class: "sub-row" }, [
        textEl,
        el("span", { class: "sub-time", text: formatRelative(ev.created_at) }),
      ]),
    );
  }

  if (subRows.length) {
    main.append(el("div", { class: "sub-rail" }, subRows));
  }

  const inlineBox = buildInlineBox(task);
  if (inlineBox) main.append(inlineBox);

  const side = el("div", { class: "task-side" }, [
    el("button", {
      type: "button",
      class: "hand-go",
      text: meta.go,
      onClick: () => openDetailModal(task.id),
    }),
  ]);

  if (!isArchived) {
    side.append(
      el("button", {
        type: "button",
        class: "hand-go-sub",
        title: "以此任务为前置依赖创建后续任务",
        text: "↳ 顺延",
        onClick: () =>
          openCreateModal({
            project: task.project || "",
            assignee: task.assignee || defaultSheetAssignee(),
            dependsOn: [task.id],
          }),
      }),
    );
  } else if (isHuman) {
    side.append(
      el("button", {
        type: "button",
        class: "hand-go-sub",
        text: "重开 ↺",
        onClick: async () => {
          try {
            await api(`/v1/tasks/${task.id}/reopen`, { method: "POST", body: {} });
            toast(`已重新打开：${task.title}`);
            await loadAll({ silent: true });
          } catch (err) {
            toast(err.message, true);
          }
        },
      }),
    );
  }

  const itemCls = [
    "task-item",
    isArchived ? "is-archived" : "",
    state.highlightTaskId === task.id ? "is-highlight" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return el("article", { id: `task-${task.id}`, class: itemCls }, [checkBtn, main, side]);
}

function renderSection(desc) {
  const section = el("section", {
    class: `task-section${desc.isAttention ? " is-attention" : ""}`,
  });

  const metaChildren = [el("span", { text: desc.countLabel })];
  if (desc.onAdd && !desc.continued) {
    metaChildren.push(
      el("button", {
        type: "button",
        class: "section-add-btn",
        text: "+ 记入此项目",
        onClick: desc.onAdd,
      }),
    );
  }
  if (desc.collapsible && !desc.continued) {
    metaChildren.push(
      el("button", {
        type: "button",
        class: "collapse-btn",
        text: desc.collapsed ? "展开 ▾" : "收起 ▴",
        onClick: desc.onToggle,
      }),
    );
  }

  const titleText = desc.continued ? `${desc.title}（续）` : desc.title;
  section.append(
    el("header", { class: "section-head" }, [
      el("span", { class: "section-num", text: desc.numLabel }),
      el("h2", { class: "section-title", text: titleText }),
      el("span", { class: "section-line", "aria-hidden": "true" }),
      el("span", { class: "section-meta" }, metaChildren),
    ]),
  );

  if (desc.collapsed) return section;

  if (!desc.tasks.length) {
    section.append(el("p", { class: "empty-section", text: desc.emptyText }));
    return section;
  }

  section.append(
    el(
      "div",
      { class: "task-list" },
      desc.tasks.map((t) => buildTaskItem(t, { showProjectTag: !!desc.showProjectTag })),
    ),
  );
  return section;
}

function renderPager(view, totalPages, totalFilteredCount) {
  const activeTab = buildTabsList().find((t) => t.id === state.activeSheet);
  const sheetName = activeTab ? activeTab.label : "当前纸张";
  $("sheet-foot-meta").textContent = `${sheetName} · 当前筛选 ${totalFilteredCount} 项`;

  const host = $("sheet-pager");
  host.innerHTML = "";
  if (totalPages <= 1) {
    host.append(el("span", { class: "pager-label", text: "第 1 / 1 页" }));
    return;
  }

  const goTo = (p) => {
    const target = Math.min(totalPages, Math.max(1, p));
    if (target === view.currentPage) return;
    view.currentPage = target;
    renderSections();
    $("sections").scrollTop = 0;
  };

  host.append(
    el("button", {
      type: "button",
      class: "pager-btn",
      disabled: view.currentPage <= 1,
      text: "‹ 上页",
      onClick: () => goTo(view.currentPage - 1),
    }),
  );

  for (let p = 1; p <= totalPages; p++) {
    if (totalPages > 6 && p > 2 && p < totalPages - 1 && Math.abs(p - view.currentPage) > 1) {
      if (p === 3 || p === totalPages - 2) {
        host.append(el("span", { class: "hint-text", text: "…" }));
      }
      continue;
    }
    host.append(
      el("button", {
        type: "button",
        class: `pager-btn${p === view.currentPage ? " is-active" : ""}`,
        text: String(p),
        "aria-current": p === view.currentPage ? "page" : undefined,
        onClick: () => goTo(p),
      }),
    );
  }

  host.append(
    el("button", {
      type: "button",
      class: "pager-btn",
      disabled: view.currentPage >= totalPages,
      text: "下页 ›",
      onClick: () => goTo(view.currentPage + 1),
    }),
  );
}

function renderSections() {
  const container = $("sections");
  const view = getSheetView(state.activeSheet);

  if (state.loading && !state.tasks.length) {
    container.innerHTML = "";
    container.append(el("div", { class: "loading-sheet", text: "正在翻开今日打卡纸…" }));
    renderPager(view, 1, 0);
    return;
  }

  const measuredHeight = container.clientHeight;
  const fallbackBudget = window.innerWidth <= 959 ? 350 : window.innerWidth <= 1240 ? 430 : 470;
  const budgetPx = measuredHeight > 220 ? measuredHeight - 8 : fallbackBudget;

  const sheetTasks = tasksForSheet(state.activeSheet);
  const q = view.searchQuery.trim().toLowerCase();
  const filtered = sheetTasks.filter((t) => {
    if (view.activeProject) {
      const key = t.project || "__none__";
      if (key !== view.activeProject) return false;
    }
    if (q) {
      const hay = `${t.id} ${t.title} ${t.description} ${t.project || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const descriptors = [];

  // 1. 待我拍板（动态显隐）
  const attentionOrder = { review: 0, blocked: 1, proposed: 2 };
  const attention = filtered
    .filter((t) => t.status === "review" || t.status === "blocked" || t.status === "proposed")
    .sort((a, b) => attentionOrder[a.status] - attentionOrder[b.status] || a.priority - b.priority || a.created_at - b.created_at);

  if (attention.length) {
    descriptors.push({
      numLabel: "✦",
      title: "待我拍板",
      countLabel: `待批复 ${attention.length} 项`,
      tasks: attention,
      isAttention: true,
      showProjectTag: true,
    });
  }

  // 2. 页内按项目分节
  const active = filtered.filter((t) => t.status === "claimed" || t.status === "todo");
  const groups = new Map();
  for (const t of active) {
    const key = t.project || "__none__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const doneCountsByProj = new Map();
  for (const t of sheetTasks) {
    if (t.status === "done") {
      const key = t.project || "__none__";
      doneCountsByProj.set(key, (doneCountsByProj.get(key) || 0) + 1);
    }
  }

  const projKeys = [...groups.keys()].sort((a, b) => {
    if (a === "__none__") return 1;
    if (b === "__none__") return -1;
    return a.localeCompare(b);
  });

  projKeys.forEach((key, idx) => {
    const numLabel = `${toChineseNumeral(idx + 1)}、`;
    const title = key === "__none__" ? "未分类" : key.toUpperCase();
    const sortedTasks = topoSortTasks(groups.get(key));
    const doneInProj = doneCountsByProj.get(key) || 0;
    const countLabel = doneInProj ? `待办 ${sortedTasks.length} · 已完 ${doneInProj}` : `待办 ${sortedTasks.length} 项`;

    descriptors.push({
      numLabel,
      title,
      countLabel,
      tasks: sortedTasks,
      onAdd: () =>
        openCreateModal({
          project: key === "__none__" ? "" : key,
          assignee: defaultSheetAssignee(),
        }),
    });
  });

  // 3. 底部已结项归档
  const archived = filtered
    .filter((t) => t.status === "done" || t.status === "cancelled")
    .sort((a, b) => (b.closed_at || b.updated_at) - (a.closed_at || a.updated_at));
  const doneInArchived = archived.filter((t) => t.status === "done").length;

  descriptors.push({
    numLabel: "✓",
    title: "已结项归档",
    countLabel: `已完 ${doneInArchived} · 共 ${archived.length} 项`,
    tasks: archived,
    collapsible: true,
    showProjectTag: true,
    collapsed: !view.archiveExpanded && !view.searchQuery && !view.activeProject,
    onToggle: () => {
      view.archiveExpanded = !view.archiveExpanded;
      renderSections();
    },
    emptyText: "这张纸还没有已结项的任务。",
  });

  const pages = paginateSections(descriptors, budgetPx);
  state.totalPages = pages.length;

  if (state.focusHighlightPage && state.highlightTaskId) {
    const foundPageIdx = pages.findIndex((pageDescs) =>
      pageDescs.some((d) => !d.collapsed && d.tasks.some((t) => t.id === state.highlightTaskId)),
    );
    if (foundPageIdx >= 0) view.currentPage = foundPageIdx + 1;
    state.focusHighlightPage = false;
  }

  view.currentPage = Math.min(pages.length, Math.max(1, view.currentPage));
  const currentDescs = pages[view.currentPage - 1] || [];

  container.innerHTML = "";
  if (!projKeys.length && !attention.length && !archived.length) {
    container.append(
      el("p", {
        class: "empty-section",
        text: q || view.activeProject ? "当前纸张下没有符合筛选条件的任务。" : "这张纸上当前没有任务，点右上角「+ 记一笔新任务」写一条吧。",
      }),
    );
  } else {
    for (const desc of currentDescs) {
      container.append(renderSection(desc));
    }
  }

  renderPager(view, pages.length, filtered.length);
}

/* ---- 数据加载 ---- */
async function loadAll({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  const refreshBtn = $("refresh-btn");
  refreshBtn.disabled = true;
  refreshBtn.textContent = "正在刷新…";

  try {
    const [me, actorsRes, tasksRes] = await Promise.all([
      api("/v1/me"),
      api("/v1/actors"),
      api("/v1/tasks?expand=1&limit=200"),
    ]);
    state.me = me;
    state.actors = actorsRes.actors || [];
    state.actorMap = new Map(state.actors.map((a) => [a.id, a]));
    state.tasks = tasksRes.tasks || [];
    state.taskMap = new Map(state.tasks.map((t) => [t.id, t]));
    state.lastSyncAt = Date.now();
    hideBanner();

    updateSyncStatus();
    renderDevActorSwitcher();
    renderStudioTabs();
    renderUnderSheets();
    updateStampAndCounts();
    renderProjectPills();
    renderSections();

    if (state.activeDetailId) {
      const fresh = state.taskMap.get(state.activeDetailId);
      if (fresh) {
        state.detailTask = fresh;
        renderDetailModal(fresh);
      }
    }
  } catch (err) {
    updateSyncStatus();
    renderDevActorSwitcher();
    if (err.status === 401 || err.status === 403) {
      showBanner(
        IS_LOCAL_DEV
          ? `当前视角（${state.devActor || "未设置"}）未通过鉴权：${err.message}`
          : "尚未通过 Cloudflare Access 身份校验，请刷新页面重新登录。",
        "重新加载",
        () => location.reload(),
      );
    } else if (!silent) {
      showBanner(`加载队列失败：${err.message}`, "重试", () => loadAll());
    } else {
      toast(err.message, true);
    }
    renderStudioTabs();
    renderUnderSheets();
    renderSections();
  } finally {
    state.loading = false;
    refreshBtn.disabled = false;
    refreshBtn.textContent = "刷新队列";
  }
}

/* ---- 自定义纸质控件：印章按钮组 / 项目标签 / 前置依赖搜索组件 ---- */
function setStampGroupValue(groupEl, inputEl, value, disabled = false) {
  inputEl.value = value ?? "";
  for (const btn of groupEl.querySelectorAll(".stamp-opt")) {
    btn.classList.toggle("is-selected", btn.dataset.value === String(inputEl.value));
    btn.disabled = disabled;
  }
}

function bindStampGroup(groupEl, inputEl) {
  groupEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".stamp-opt");
    if (!btn || btn.disabled) return;
    setStampGroupValue(groupEl, inputEl, btn.dataset.value);
  });
}

function renderAssigneeGroup(groupEl, inputEl, currentVal, disabled = false) {
  groupEl.innerHTML = "";
  const items = [
    { value: "", label: "不限（谁都能领）" },
    ...state.actors.map((a) => ({ value: a.id, label: a.display_name })),
  ];
  for (const item of items) {
    groupEl.append(
      el("button", {
        type: "button",
        class: `stamp-opt${String(currentVal ?? "") === item.value ? " is-selected" : ""}`,
        dataset: { value: item.value },
        disabled,
        text: item.label,
      }),
    );
  }
  inputEl.value = currentVal ?? "";
}

function renderProjectChips(chipsEl, inputEl, onChange, disabled = false) {
  chipsEl.innerHTML = "";
  const projects = [...new Set(state.tasks.map((t) => t.project).filter(Boolean))].sort();
  if (!projects.length) return;
  const cur = inputEl.value.trim();
  for (const p of projects) {
    chipsEl.append(
      el("button", {
        type: "button",
        class: `chip-btn${cur === p ? " is-selected" : ""}`,
        disabled,
        text: `#${p}`,
        onClick: () => {
          inputEl.value = cur === p ? "" : p;
          renderProjectChips(chipsEl, inputEl, onChange, disabled);
          onChange(inputEl.value.trim());
        },
      }),
    );
  }
}

function createDepsWidget({ selectedEl, searchEl, listEl }) {
  const widget = {
    selected: [],
    currentProject: "",
    excludeId: null,
    disabled: false,

    setState({ selectedIds = [], currentProject = "", excludeId = null, disabled = false }) {
      this.selected = [...new Set(selectedIds)];
      this.currentProject = (currentProject || "").trim();
      this.excludeId = excludeId;
      this.disabled = disabled;
      searchEl.value = "";
      searchEl.disabled = disabled;
      this.render();
    },

    setProject(project) {
      this.currentProject = (project || "").trim();
      this.render();
    },

    getSelected() {
      return [...this.selected];
    },

    toggle(id) {
      if (this.disabled) return;
      const idx = this.selected.indexOf(id);
      if (idx >= 0) this.selected.splice(idx, 1);
      else this.selected.push(id);
      this.render();
    },

    render() {
      selectedEl.innerHTML = "";
      if (!this.selected.length) {
        selectedEl.append(el("span", { class: "hint-text", text: "未设置前置依赖" }));
      } else {
        for (const id of this.selected) {
          const t = state.taskMap.get(id);
          const prefix = t?.project ? `#${t.project} · ` : "";
          const label = t ? `${prefix}${t.title}` : id;
          selectedEl.append(
            el("span", { class: "dep-chip" }, [
              document.createTextNode(label),
              el("button", {
                type: "button",
                class: "dep-chip-x",
                "aria-label": `移除依赖 ${label}`,
                disabled: this.disabled,
                text: "×",
                onClick: () => this.toggle(id),
              }),
            ]),
          );
        }
      }

      const q = searchEl.value.trim().toLowerCase();
      const curProj = this.currentProject;
      const candidates = state.tasks
        .filter((t) => {
          if (t.id === this.excludeId) return false;
          if (t.status === "done" || t.status === "cancelled") return false;
          if (!q) return true;
          return `${t.title} ${t.project || ""} ${t.id}`.toLowerCase().includes(q);
        })
        .sort((a, b) => {
          const sameA = curProj && a.project === curProj ? 0 : 1;
          const sameB = curProj && b.project === curProj ? 0 : 1;
          return sameA - sameB || a.priority - b.priority || a.created_at - b.created_at;
        });

      listEl.innerHTML = "";
      if (!candidates.length) {
        listEl.append(
          el("span", {
            class: "dep-opt-empty",
            text: q ? "没有匹配的未完成任务" : "当前没有可选的未完成任务",
          }),
        );
        return;
      }

      const selectedSet = new Set(this.selected);
      for (const t of candidates) {
        const checked = selectedSet.has(t.id);
        const sameProj = Boolean(curProj && t.project === curProj);
        const meta = STATUS_META[t.status]?.label || t.status;
        const checkBox = el("span", { class: "hand-mini-check" }, checked ? [createSvgCheck("#b93829", 11, 2.8)] : []);
        const body = el("span", { class: "dep-item-body" }, [
          sameProj ? el("span", { class: "dep-same-badge", text: "同项目" }) : null,
          t.project && !sameProj ? el("span", { class: "dep-proj-badge", text: `#${t.project}` }) : null,
          el("span", { text: t.title }),
          el("span", { class: "dep-proj-badge", text: `[${meta}]` }),
        ]);

        listEl.append(
          el("button", {
            type: "button",
            class: `dep-item${checked ? " is-selected" : ""}`,
            disabled: this.disabled,
            onClick: () => this.toggle(t.id),
          }, [checkBox, body]),
        );
      }
    },
  };

  searchEl.addEventListener("input", () => widget.render());
  return widget;
}

let createDeps = null;
let editDeps = null;

function createDepsWidgetInstance(prefix) {
  return createDepsWidget({
    selectedEl: $(`${prefix}-deps-selected`),
    searchEl: $(`${prefix}-deps-search`),
    listEl: $(`${prefix}-deps`),
  });
}

/* ---- 弹窗管理 ---- */
function openModal(id) {
  $(id).classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeModal(id) {
  $(id).classList.add("hidden");
  if (id === "detail-modal") {
    state.activeDetailId = null;
    state.detailTask = null;
    const url = new URL(location.href);
    if (url.searchParams.has("task")) {
      url.searchParams.delete("task");
      history.replaceState(null, "", url.pathname + url.search);
    }
  }
  const anyOpen = ["create-modal", "detail-modal"].some((m) => !$(m).classList.contains("hidden"));
  if (!anyOpen) document.body.style.overflow = "";
}

function openCreateModal(prefill = {}) {
  $("create-form").reset();
  const view = getSheetView(state.activeSheet);

  const initProject =
    prefill.project !== undefined
      ? prefill.project
      : view.activeProject && view.activeProject !== "__none__"
        ? view.activeProject
        : "";
  const initAssignee = prefill.assignee !== undefined ? prefill.assignee : defaultSheetAssignee();
  const initDeps = prefill.dependsOn || [];

  $("c-project").value = initProject;
  renderProjectChips($("c-project-chips"), $("c-project"), (proj) => createDeps.setProject(proj));
  setStampGroupValue($("c-priority-group"), $("c-priority"), "2");
  renderAssigneeGroup($("c-assignee-group"), $("c-assignee"), initAssignee);
  createDeps.setState({ selectedIds: initDeps, currentProject: initProject });

  $("create-role-hint").textContent =
    state.me?.kind === "agent"
      ? "当前为 Agent 身份：新建任务将进入「待批准 (proposed)」"
      : initDeps.length
        ? "已串联前置依赖，写入后将等待前置任务完成"
        : "新建后将直接进入「待认领 (todo)」队列";

  openModal("create-modal");
  $("c-title").focus();
}

function renderDetailActions(task) {
  const box = $("d-actions-box");
  box.innerHTML = "";
  const isHuman = state.me?.kind === "human";
  const isHolder = task.status === "claimed" && state.me?.id === task.claimed_by;
  const isOwnProposal = task.status === "proposed" && state.me?.id === task.created_by;
  const leaseExpired = task.status === "claimed" && (task.lease_until ?? 0) < Date.now();

  const btnRow = el("div", { class: "detail-btn-row" });
  const subArea = el("div", { class: "detail-panel-sub hidden" });

  const runAction = async (path, body, okMsg) => {
    try {
      const updated = await api(path, { method: "POST", body });
      toast(okMsg);
      await loadAll({ silent: true });
      if (updated?.id) await refreshDetail(updated.id);
    } catch (err) {
      toast(err.message, true);
    }
  };

  if (task.status === "proposed" && isHuman) {
    btnRow.append(
      el("button", {
        type: "button",
        class: "paper-btn paper-btn-sage",
        text: "批准入队 ✓",
        onClick: () => runAction(`/v1/tasks/${task.id}/accept`, {}, "已批准入队"),
      }),
    );
  }

  if (task.status === "review" && isHuman) {
    btnRow.append(
      el("button", {
        type: "button",
        class: "paper-btn paper-btn-sage",
        text: "验收通过 ✓",
        onClick: () => runAction(`/v1/tasks/${task.id}/approve`, {}, "已验收通过"),
      }),
      el("button", {
        type: "button",
        class: "paper-btn paper-btn-danger",
        text: "驳回重做…",
        onClick: () => {
          subArea.innerHTML = "";
          subArea.classList.remove("hidden");
          const input = el("input", { type: "text", class: "inline-input", placeholder: "写明驳回意见…" });
          subArea.append(
            el("form", {
              class: "inline-row",
              onSubmit: (e) => {
                e.preventDefault();
                if (!input.value.trim()) return;
                runAction(`/v1/tasks/${task.id}/reject`, { feedback: input.value.trim() }, "已驳回给原 Agent");
              },
            }, [input, el("button", { type: "submit", class: "paper-btn paper-btn-ink", text: "确认驳回" })]),
          );
          input.focus();
        },
      }),
    );
  }

  if (task.status === "todo" || (task.status === "claimed" && (leaseExpired || isHolder))) {
    btnRow.append(
      el("button", {
        type: "button",
        class: "paper-btn",
        text: isHolder ? "重新确认认领" : "认领此任务",
        onClick: () => runAction(`/v1/tasks/${task.id}/claim`, {}, "已认领任务"),
      }),
    );
  }

  if (isHolder) {
    btnRow.append(
      el("button", {
        type: "button",
        class: "paper-btn",
        text: "续租 (+30m)",
        onClick: () => runAction(`/v1/tasks/${task.id}/heartbeat`, {}, "租约已延长 30 分钟"),
      }),
      el("button", {
        type: "button",
        class: "paper-btn paper-btn-sage",
        text: "提交验收…",
        onClick: () => {
          subArea.innerHTML = "";
          subArea.classList.remove("hidden");
          const sumInput = el("input", { type: "text", class: "inline-input", placeholder: "交付说明（做了什么、怎么验证）" });
          const urlInput = el("input", { type: "url", class: "inline-input", placeholder: "交付链接（可选，如 PR URL）" });
          subArea.append(
            el("form", {
              class: "inline-row",
              onSubmit: (e) => {
                e.preventDefault();
                const summary = sumInput.value.trim();
                if (!summary) return;
                const artifacts = urlInput.value.trim() ? [{ kind: "url", url: urlInput.value.trim() }] : undefined;
                runAction(`/v1/tasks/${task.id}/submit`, { summary, artifacts }, "已提交验收");
              },
            }, [sumInput, urlInput, el("button", { type: "submit", class: "paper-btn paper-btn-ink", text: "提交" })]),
          );
          sumInput.focus();
        },
      }),
      el("button", {
        type: "button",
        class: "paper-btn",
        text: "提问阻塞…",
        onClick: () => {
          subArea.innerHTML = "";
          subArea.classList.remove("hidden");
          const qInput = el("input", { type: "text", class: "inline-input", placeholder: "输入需要人类确认的问题…" });
          subArea.append(
            el("form", {
              class: "inline-row",
              onSubmit: (e) => {
                e.preventDefault();
                if (!qInput.value.trim()) return;
                runAction(`/v1/tasks/${task.id}/block`, { question: qInput.value.trim() }, "已转为提问等待回答");
              },
            }, [qInput, el("button", { type: "submit", class: "paper-btn paper-btn-ink", text: "发送提问" })]),
          );
          qInput.focus();
        },
      }),
      el("button", {
        type: "button",
        class: "paper-btn",
        text: "释放回队列",
        onClick: () => runAction(`/v1/tasks/${task.id}/release`, {}, "已释放回队列"),
      }),
    );
  }

  if (isHuman && ["todo", "claimed", "blocked", "review"].includes(task.status)) {
    btnRow.append(
      el("button", {
        type: "button",
        class: "paper-btn paper-btn-sage",
        text: "直接标记完成 ✓",
        onClick: () => runAction(`/v1/tasks/${task.id}/complete`, {}, "已打卡完成"),
      }),
    );
  }

  if (task.status !== "done" && task.status !== "cancelled") {
    btnRow.append(
      el("button", {
        type: "button",
        class: "paper-btn",
        text: "↳ 顺延创建下一步",
        onClick: () => {
          closeModal("detail-modal");
          openCreateModal({
            project: task.project || "",
            assignee: task.assignee || defaultSheetAssignee(),
            dependsOn: [task.id],
          });
        },
      }),
    );
  }

  if ((isHuman && !["done", "cancelled"].includes(task.status)) || isOwnProposal) {
    btnRow.append(
      el("button", {
        type: "button",
        class: "paper-btn paper-btn-danger",
        text: isOwnProposal && !isHuman ? "撤回提案" : "取消任务",
        onClick: () => runAction(`/v1/tasks/${task.id}/cancel`, {}, "任务已取消"),
      }),
    );
  }

  if (isHuman && ["done", "cancelled"].includes(task.status)) {
    btnRow.append(
      el("button", {
        type: "button",
        class: "paper-btn paper-btn-ink",
        text: "重新打开 ↺",
        onClick: () => runAction(`/v1/tasks/${task.id}/reopen`, {}, "任务已重新打开"),
      }),
    );
  }

  if (!btnRow.children.length) {
    btnRow.append(el("span", { class: "hint-text", text: "当前身份对此状态无流转操作" }));
  }

  box.append(btnRow, subArea);
}

function renderDetailModal(task) {
  const meta = STATUS_META[task.status] || { label: task.status, cls: "" };
  $("d-id").textContent = task.id;
  const badge = $("d-status-badge");
  badge.className = `tag ${meta.cls}`;
  badge.textContent = meta.label;
  $("d-version").textContent = `v${task.version}`;
  $("detail-modal-title").textContent = task.title;

  renderDetailActions(task);

  const isHuman = state.me?.kind === "human";
  const canEdit = isHuman || (task.status === "proposed" && task.created_by === state.me?.id);
  $("d-edit-note").textContent = canEdit ? "可编辑字段（保存时校验乐观锁）" : "只读（仅人类或提案人可编辑）";

  $("e-title").value = task.title;
  $("e-project").value = task.project || "";
  $("e-due").value = toDatetimeLocalValue(task.due_at);
  $("e-desc").value = task.description || "";
  $("e-accept").value = task.acceptance || "";

  for (const field of $("edit-form").querySelectorAll("input[type='text'], input[type='datetime-local'], textarea")) {
    field.disabled = !canEdit;
  }

  renderProjectChips(
    $("e-project-chips"),
    $("e-project"),
    (proj) => editDeps.setProject(proj),
    !canEdit,
  );
  setStampGroupValue($("e-priority-group"), $("e-priority"), String(task.priority), !canEdit);
  renderAssigneeGroup($("e-assignee-group"), $("e-assignee"), task.assignee || "", !canEdit);
  editDeps.setState({
    selectedIds: task.depends_on || [],
    currentProject: task.project || "",
    excludeId: task.id,
    disabled: !canEdit,
  });

  $("e-save-btn").classList.toggle("hidden", !canEdit);

  $("d-lease-info").textContent =
    task.status === "claimed" && task.claimed_by
      ? `持有者：${actorLabel(task.claimed_by)}（${formatLeaseRemaining(task.lease_until)}）`
      : `创建者：${actorLabel(task.created_by)} · 更新于 ${formatDateTimeShort(task.updated_at)}`;

  const artList = $("d-artifacts");
  artList.innerHTML = "";
  if (!(task.artifacts || []).length) {
    artList.append(el("li", { class: "hint-text", text: "暂无交付物链接" }));
  } else {
    for (const a of task.artifacts) {
      const left = el("div", {}, [
        el("span", { class: "sub-kind", text: `[${String(a.kind || "url").toUpperCase()}]` }),
        isSafeHttpUrl(a.url)
          ? el("a", { href: a.url, target: "_blank", rel: "noopener noreferrer", text: a.note || a.url })
          : el("span", { text: a.note || a.url }),
      ]);
      artList.append(
        el("li", { class: "artifact-item" }, [
          left,
          el("span", { class: "hint-text", text: `${actorLabel(a.created_by)} · ${formatRelative(a.created_at)}` }),
        ]),
      );
    }
  }
  const canAttach = isHuman || (task.status === "claimed" && task.claimed_by === state.me?.id);
  $("artifact-form").classList.toggle("hidden", !canAttach);

  const evList = $("d-events");
  evList.innerHTML = "";
  if (!(task.events || []).length) {
    evList.append(el("li", { class: "hint-text", text: "暂无事件记录" }));
  } else {
    for (const ev of task.events) {
      const label = EVENT_LABELS[ev.type] || ev.type;
      const transition = ev.from_status && ev.to_status ? ` (${ev.from_status} → ${ev.to_status})` : "";
      const li = el("li", { class: "event-item" }, [
        el("div", { class: "event-meta" }, [
          el("span", {}, [
            el("span", { class: "event-actor", text: actorLabel(ev.actor) }),
            document.createTextNode(` · ${label}${transition}`),
          ]),
          el("span", { text: formatDateTimeShort(ev.created_at) }),
        ]),
      ]);
      if (ev.body) {
        const bodyEl = el("div", { class: "event-body" });
        appendLinkedText(bodyEl, ev.body);
        li.append(bodyEl);
      }
      evList.append(li);
    }
  }

  const isBlockedHuman = task.status === "blocked" && isHuman;
  $("comment-hint").textContent = isBlockedHuman
    ? "任务当前处于提问中，回复后将自动回到队列交给原 Agent"
    : "留言将记入事件时间线";
  $("comment-submit").textContent = isBlockedHuman ? "回复并放回队列" : "发表留言";
}

async function refreshDetail(id) {
  const detail = await api(`/v1/tasks/${id}`);
  state.detailTask = detail;
  state.taskMap.set(detail.id, detail);
  renderDetailModal(detail);
  return detail;
}

async function openDetailModal(id) {
  state.activeDetailId = id;
  state.highlightTaskId = id;
  const cached = state.taskMap.get(id);
  if (cached) {
    state.detailTask = cached;
    renderDetailModal(cached);
    openModal("detail-modal");
  }
  try {
    await refreshDetail(id);
    if (!cached) openModal("detail-modal");
  } catch (err) {
    toast(err.message, true);
    if (!cached) state.activeDetailId = null;
  }
}

/* ---- 事件绑定 ---- */
function bindEvents() {
  createDeps = createDeps || createDepsWidgetInstance("c");
  editDeps = editDeps || createDepsWidgetInstance("e");

  bindStampGroup($("c-priority-group"), $("c-priority"));
  bindStampGroup($("c-assignee-group"), $("c-assignee"));
  bindStampGroup($("e-priority-group"), $("e-priority"));
  bindStampGroup($("e-assignee-group"), $("e-assignee"));
  bindStampGroup($("a-kind-group"), $("a-kind"));

  $("c-project").addEventListener("input", () => {
    const val = $("c-project").value.trim();
    renderProjectChips($("c-project-chips"), $("c-project"), (proj) => createDeps.setProject(proj));
    createDeps.setProject(val);
  });

  $("e-project").addEventListener("input", () => {
    const val = $("e-project").value.trim();
    renderProjectChips($("e-project-chips"), $("e-project"), (proj) => editDeps.setProject(proj));
    editDeps.setProject(val);
  });

  $("refresh-btn").addEventListener("click", () => loadAll());
  $("new-task-btn").addEventListener("click", () => openCreateModal());

  if (IS_DEMO_MODE) {
    $("demo-reset-btn").classList.remove("hidden");
    $("demo-repo-link").classList.remove("hidden");
    $("guide-note").textContent =
      "※ 当前为 GitHub Pages 项目展示版（交互数据仅存于本地浏览器会话）：可体验批准提案、回答提问、验收打卡、切换右侧纸张与视角。";
    $("demo-reset-btn").addEventListener("click", async () => {
      resetDemoStore();
      state.inlinePanels.clear();
      state.highlightTaskId = null;
      toast("已重置演示打卡纸");
      await loadAll({ silent: true });
    });
  }

  $("filter-search").addEventListener("input", (e) => {
    const view = getSheetView(state.activeSheet);
    view.searchQuery = e.target.value;
    view.currentPage = 1;
    renderSections();
  });

  $("dev-actor-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("dev-actor-menu");
    const open = menu.classList.toggle("hidden");
    $("dev-actor-btn").setAttribute("aria-expanded", String(!open));
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#dev-actor-wrap")) {
      $("dev-actor-menu").classList.add("hidden");
      $("dev-actor-btn").setAttribute("aria-expanded", "false");
    }
  });

  for (const closeBtn of document.querySelectorAll("[data-close]")) {
    closeBtn.addEventListener("click", () => closeModal(closeBtn.dataset.close));
  }
  for (const backdrop of document.querySelectorAll(".modal-backdrop")) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal(backdrop.id);
    });
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderSections(), 120);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("detail-modal").classList.contains("hidden")) closeModal("detail-modal");
      else if (!$("create-modal").classList.contains("hidden")) closeModal("create-modal");
      return;
    }
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$("create-modal").classList.contains("hidden") || !$("detail-modal").classList.contains("hidden")) return;

    if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      openCreateModal();
    } else if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      loadAll();
    } else if (e.key === "[" || e.key === "ArrowLeft") {
      const view = getSheetView(state.activeSheet);
      if (view.currentPage > 1) {
        e.preventDefault();
        view.currentPage -= 1;
        renderSections();
      }
    } else if (e.key === "]" || e.key === "ArrowRight") {
      const view = getSheetView(state.activeSheet);
      if (view.currentPage < state.totalPages) {
        e.preventDefault();
        view.currentPage += 1;
        renderSections();
      }
    }
  });

  $("create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("c-title").value.trim();
    if (!title) return;
    const dueVal = $("c-due").value;
    const payload = {
      title,
      project: $("c-project").value.trim() || null,
      priority: Number($("c-priority").value),
      assignee: $("c-assignee").value || null,
      due_at: dueVal ? new Date(dueVal).toISOString() : null,
      description: $("c-desc").value,
      acceptance: $("c-accept").value,
      depends_on: createDeps.getSelected(),
    };
    try {
      const created = await api("/v1/tasks", { method: "POST", body: payload });
      closeModal("create-modal");
      state.highlightTaskId = created.id;
      state.focusHighlightPage = true;
      toast(created.status === "proposed" ? "已提交提案，等待人类批准" : "新任务已写入队列");
      await loadAll({ silent: true });
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const orig = state.detailTask;
    if (!orig) return;

    const patch = {};
    const title = $("e-title").value.trim();
    if (title !== orig.title) patch.title = title;

    const project = $("e-project").value.trim() || null;
    if (project !== (orig.project ?? null)) patch.project = project;

    const priority = Number($("e-priority").value);
    if (priority !== orig.priority) patch.priority = priority;

    const assignee = $("e-assignee").value || null;
    if (assignee !== (orig.assignee ?? null)) patch.assignee = assignee;

    const dueRaw = $("e-due").value;
    if (dueRaw !== toDatetimeLocalValue(orig.due_at)) {
      patch.due_at = dueRaw ? new Date(dueRaw).toISOString() : null;
    }

    const desc = $("e-desc").value;
    if (desc !== (orig.description || "")) patch.description = desc;

    const accept = $("e-accept").value;
    if (accept !== (orig.acceptance || "")) patch.acceptance = accept;

    const nextDeps = editDeps.getSelected().sort();
    const prevDeps = [...(orig.depends_on || [])].sort();
    if (nextDeps.length !== prevDeps.length || nextDeps.some((d, i) => d !== prevDeps[i])) {
      patch.depends_on = nextDeps;
    }

    if (!Object.keys(patch).length) {
      toast("没有需要保存的改动");
      return;
    }

    try {
      const updated = await api(`/v1/tasks/${orig.id}`, {
        method: "PATCH",
        headers: { "If-Match": String(orig.version) },
        body: patch,
      });
      toast(`已保存修改 (v${updated.version})`);
      await loadAll({ silent: true });
      await refreshDetail(orig.id);
    } catch (err) {
      if (err.code === "version_conflict") {
        toast("任务刚被其他人修改，已自动刷新最新版本", true);
        await loadAll({ silent: true });
        await refreshDetail(orig.id);
      } else {
        toast(err.message, true);
      }
    }
  });

  $("artifact-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const orig = state.detailTask;
    if (!orig) return;
    const url = $("a-url").value.trim();
    if (!url) return;
    try {
      await api(`/v1/tasks/${orig.id}/artifacts`, {
        method: "POST",
        body: {
          artifacts: [{ kind: $("a-kind").value || "url", url, note: $("a-note").value.trim() || null }],
        },
      });
      $("a-url").value = "";
      $("a-note").value = "";
      toast("交付物链接已追加");
      await loadAll({ silent: true });
      await refreshDetail(orig.id);
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("comment-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const orig = state.detailTask;
    if (!orig) return;
    const body = $("comment-input").value.trim();
    if (!body) return;
    try {
      const res = await api(`/v1/tasks/${orig.id}/comments`, { method: "POST", body: { body } });
      $("comment-input").value = "";
      toast(orig.status === "blocked" && res.status === "todo" ? "已回复并放回队列" : "留言已发送");
      await loadAll({ silent: true });
      await refreshDetail(orig.id);
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function init() {
  updateCalendarMeta();
  bindEvents();
  await loadAll();

  const targetId = new URLSearchParams(location.search).get("task");
  if (targetId) {
    const target = state.taskMap.get(targetId);
    const view = getSheetView(state.activeSheet);
    if (target && (target.status === "done" || target.status === "cancelled")) {
      view.archiveExpanded = true;
    }
    state.highlightTaskId = targetId;
    state.focusHighlightPage = true;
    renderSections();
    const row = $(`task-${targetId}`);
    if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
    await openDetailModal(targetId);
  }
}

init();
