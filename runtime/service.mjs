/**
 * runtime/service.mjs — 邮件后端的受管运行时（managed runtime）。
 *
 * 为什么必须有这个进程：
 * v2 的 AppHost 被宿主以 `hana-server.exe --permission --allow-fs-read=<安装目录>
 * --allow-fs-read=<app-data> --allow-fs-write=<app-data> [--allow-child-process]` 启动，
 * Node 的权限模型**在进程内部**传给子进程，于是 AppHost 及其一切子进程：
 *   · 读不到安装目录 / app-data 之外的任何文件（v1 的 plugin-data、npm 自己的代码都不行）
 *   · **没有出站网络**（Node 26 的权限模型管网络，报 ERR_ACCESS_DENIED）
 * 而邮件后端要连 IMAP/SMTP、要连 ClawEmail 的 WebSocket、要调用户自配的 LLM 端点 ——
 * 全都过不去。实测过：`childEnv()` 剥环境变量无效，因为 AppHost 的 env 是白名单，
 * 里面根本没有 NODE_OPTIONS。
 *
 * 平台为此准备了受管运行时；native profile 才允许「读当前用户可读的文件 + 外网」。
 * 所以这里把「一切需要网络/外部文件/子进程的活」收进一个进程：
 *   · inbox 命令（list/read/send/reply/…）
 *   · ClawEmail WebSocket 监听 + IMAP IDLE 监听
 *   · 出站 HTTP（LLM）
 *   · 图片代理、桌面通知
 *   · 依赖安装、v1 数据迁移
 * AppHost 那边只留工具注册、路由和转发（见 lib/runtime-host.mjs）。
 *
 * 启动参数（由 ctx.runtime.start 的 args 传入，不能用 env —— 那边的 env 也是白名单）：
 *   argv[2] = 本 App 的数据目录（app-data/hanako-mail）
 *   argv[3] = v1 数据目录（plugin-data/hanako-mail/hanako-mail），可选
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { startDeviceFlow, waitForAuthorization } from "../backend/agentqq-auth.mjs";
import { spawnSync, execFile } from "node:child_process";
import { decryptSensitiveFields, encryptSensitiveFields } from "../backend/cred-crypto.mjs";
// 依赖判定只有一份（从 backend/package.json 推导），与 AppHost 侧（http/ui.js）共用
import { missingBackendDeps } from "../backend/deps.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = path.resolve(__dirname, "..");
const BACKEND_DIR = path.join(INSTALL_DIR, "backend");

const DATA_DIR = process.argv[2] || path.join(process.env.USERPROFILE || "", ".hanako", "app-data", "hanako-mail");
const LEGACY_DIR = process.argv[3] || "";

// 必须在 import 任何 backend 模块之前设好：它们在模块作用域就算数据目录。
process.env.HANAKO_PLUGIN_DATA = DATA_DIR;

const PORT = Number(process.argv[4]) || 43179;

// 诊断缓存：服务能不能 spawn、看不看得见 npm（依赖自愈的前提）。
// 在 probeSpawn 里算一次，供 /health 报告 —— 不每次现查。
let _spawnProbe = null;   // probeSpawn() 的结果对象
let _npmRunner = null;    // findNpmRunner() 找到的 { node, cli, root } 或 null
let _npmVersion = null;   // 真跑一次 npm --version 的输出（证明它不是“看起来在”而已）
const READY_MARKER = "HANA_MAIL_SERVICE_READY";
const MAX_HTTP_BYTES = 4 * 1024 * 1024;

// 日志一律走 stderr：stdout 只用来打就绪标记（宿主要精确匹配）。
// 同时镜像到 <DATA_DIR>/service.log —— 受管运行时的输出由宿主捕获，拿不到时
// 这个文件是唯一能读到的现场（启动期崩溃、沙箱拒绝、缺少文件都看得到）。
const SERVICE_LOG = path.join(DATA_DIR, "service.log");
function log(level, msg, data) {
  const ts = new Date().toISOString();
  const tail = data !== undefined ? ` ${JSON.stringify(data)}` : "";
  const line = `[${ts}] [${level}] ${msg}${tail}`;
  try { process.stderr.write(line + "\n"); } catch { /* ignore */ }
  try {
    let existing = "";
    try { existing = fs.readFileSync(SERVICE_LOG, "utf-8"); } catch { /* 首次 */ }
    // 简单的滚动：保留最后 64 KB，防止长期运行后无限增长。
    const next = (existing.length > 64 * 1024 ? existing.slice(-48 * 1024) : existing) + line + "\n";
    fs.writeFileSync(SERVICE_LOG, next, "utf-8");
  } catch { /* 日志失败不影响服务 */ }
}

// ── 依赖：现在服务能自己补了 ──
//
// ⚠ 历史：这里原写的是「受管 native 运行时被 Job Object 管着，服务不能再 spawn 任何进程
//   （实测报 spawn EPERM），npm 永远跑不起来 —— 因此依赖随包发布，这里只做检查」。
//   **那条结论已过期。** 它是在服务跑 native profile 时测的；现在 native 永远建不起来
//  （HANA_HOME 是符号链接），服务实际跑在降级后的 local-machine（enforcement: none），
//   2026-09-22 实探可以 spawn（见 probeSpawn）。而 scripts/restore-backend-deps.mjs
//  （09-20）说的「服务有能力 spawn + 出网」是对的。
//
// 于是这个暗坑真修掉了：更新 App 会把 backend/node_modules 整个清掉，
// 以前只能让用户自己开终端跑 restore-backend-deps.mjs，现在服务自己补。
//
// 但仍以「依赖随包发布」为主：解压即用、不依赖网络与 npm。
// 自愈是兜底，不是常规路径。
//
// 判定抽到 backend/deps.mjs —— AppHost 那一侧（http/ui.js）也要用同一份规则。
// 起因：那边曾有两份硬编码清单，0.6.0 换依赖时没同步，把 QQ 邮箱的同步整条挡住了。

/**
 * 找一对能跑 npm 的 (node.exe, npm-cli.js)。
 *
 * 注意：服务自己的 `process.execPath` 是 **hana-server.exe**（宿主自带的 node，
 * 旁边没有 npm）。拿它去跑 npm-cli.js 只会把参数当成服务启动参数 ——
 * 所以必须凑齐一对，凑不齐宁可不装。
 */
function findNpmRunner() {
  const exeDir = path.dirname(process.execPath);
  const roots = [exeDir, path.join(exeDir, "..", "lib")];
  for (const p of String(process.env.PATH || "").split(path.delimiter)) {
    if (p) roots.push(p);
  }
  roots.push(path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs"));

  for (const root of roots) {
    for (const rel of ["node_modules/npm/bin/npm-cli.js", "lib/node_modules/npm/bin/npm-cli.js"]) {
      try {
        const cli = path.resolve(root, rel);
        if (!fs.existsSync(cli)) continue;
        const node = path.resolve(root, "node.exe");
        if (!fs.existsSync(node)) continue;
        return { node, cli, root: path.resolve(root) };
      } catch { /* 继续找 */ }
    }
  }
  return null;
}

/** 缺依赖时用 npm 补上。**必须异步**：spawnSync 会把 HTTP 事件循环一起堵死。 */
function autoInstallDeps(missing) {
  const runner = findNpmRunner();
  if (!runner) {
    log("WARN", "依赖自愈跳过：找不到配套的 node.exe + npm-cli.js", { missing });
    return Promise.resolve(false);
  }
  // 这锁文件原本是给 AppHost 看的（它据此回 202「正在自动安装中」），一直没东西写它。
  const lock = path.join(DATA_DIR, ".hanako-auto-install.lock");
  try { fs.writeFileSync(lock, new Date().toISOString()); } catch { /* ignore */ }
  log("INFO", "依赖缺失，开始后台自愈安装", { missing, node: runner.node, npmCli: runner.cli, cwd: BACKEND_DIR });
  const t0 = Date.now();
  return new Promise((resolve) => {
    execFile(runner.node, [runner.cli, "install", "--omit=dev", "--no-audit", "--no-fund"], {
      cwd: BACKEND_DIR,
      encoding: "utf-8",
      timeout: 180000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" },
    }, (err, stdout, stderr) => {
      const still = missingBackendDeps(BACKEND_DIR);
      const ok = !err && still.length === 0;
      log(ok ? "INFO" : "ERROR", ok ? "依赖自愈完成" : "依赖自愈未成功", {
        ms: Date.now() - t0,
        stillMissing: still,
        error: err ? { code: err.code, message: err.message } : null,
        stdoutTail: String(stdout || "").trim().slice(-300),
        stderrTail: String(stderr || "").trim().slice(-500),
      });
      try { fs.rmSync(lock, { force: true }); } catch { /* ignore */ }
      resolve(ok);
    });
  });
}

function checkDeps() {
  return missingBackendDeps(BACKEND_DIR);
}

/**
 * ★ 一次性探针：受管服务到底能不能 spawn？
 *
 * 仓库里对此有两句**互相否定**的话：
 *   · 本文件与 clawemail-backend / notify-drain / imap-idle / ws-monitor / agentqq-* 等 7 处写着
 *     「受管 native 服务不能 spawn（Job Object，实测 spawn EPERM）」——
 *     通知为什么分两半、图片代理为什么改进程内、mail-cli 为什么被替掉，都是围绕这句建的；
 *   · scripts/restore-backend-deps.mjs（2026-09-20）说服务「有能力 spawn + 出网」。
 *
 * 可疑之处：那句 EPERM 是在服务还跑在 **native** profile 时测的；
 * 而现在 native 永远建不起来（HANA_HOME 是符号链接），服务实际一直跑在降级后的
 * local-machine（enforcement: none，无沙箱）—— 当初那个限制可能已经不在了。
 *
 * 结论决定两件实事：依赖是否必须随包发布、通知为何要分两半。
 * 所以启动时真跑一次，把结果写进 service.log —— 不再靠注释互相说服。
 */
function probeSpawn() {
  const t0 = Date.now();
  let out;
  try {
    const r = spawnSync(process.execPath, ["-v"], { encoding: "utf-8", timeout: 10000, windowsHide: true });
    const ok = !r.error && r.status === 0;
    out = {
      canSpawn: ok,
      status: r.status,
      stdout: String(r.stdout || "").trim(),
      error: r.error ? { code: r.error.code, message: r.error.message } : null,
      ms: Date.now() - t0,
    };
  } catch (e) {
    out = { canSpawn: false, error: { code: e.code, message: e.message }, ms: Date.now() - t0 };
  }
  _spawnProbe = out;
  log(out.canSpawn ? "INFO" : "WARN", "spawn 能力探针", out);

  // 自愈的前提不只是“能 spawn”，还要“看得见 npm”。
  // 服务自己的 execPath 是 hana-server.exe（旁边没有 npm），所以要靠 PATH 扫。
  if (out.canSpawn) {
    _npmRunner = findNpmRunner();
    if (!_npmRunner) {
      log("WARN", "npm 探针：找不到配套的 node.exe + npm-cli.js，依赖自愈将不可用");
    } else {
      try {
        const v = spawnSync(_npmRunner.node, [_npmRunner.cli, "--version"], {
          encoding: "utf-8", timeout: 30000, windowsHide: true,
        });
        _npmVersion = String(v.stdout || "").trim() || null;
        log("INFO", "npm 探针", { root: _npmRunner.root, version: _npmVersion, status: v.status, err: v.error ? v.error.code : null });
      } catch (e) {
        log("WARN", "npm 探针异常", { error: e.message });
      }
    }
  }
  return out.canSpawn;
}

function reportDeps() {
  const missing = checkDeps();
  if (missing.length === 0) { log("INFO", "后端依赖就绪"); return true; }
  log("WARN", "后端依赖缺失", { missing, hint: "将尝试后台自愈安装（见 main()）" });
  return false;
}

// ── v1 数据迁移（服务能读 plugin-data，AppHost 不能） ──
const MIGRATE_ENTRIES = ["accounts.json", ".cred-salt", "cache"];

function copyEntry(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) copyEntry(path.join(from, name), path.join(to, name));
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function migrate(from, to) {
  const result = { ok: true, copied: [], skipped: [], errors: [], from, to };
  try {
    if (!from || !fs.existsSync(from)) { result.errors.push({ rel: "", error: "source-missing" }); return result; }
    fs.mkdirSync(to, { recursive: true });
    for (const rel of MIGRATE_ENTRIES) {
      const src = path.join(from, rel);
      const dst = path.join(to, rel);
      if (!fs.existsSync(src)) { result.skipped.push(`${rel}:absent`); continue; }
      if (fs.existsSync(dst)) { result.skipped.push(`${rel}:exists`); continue; } // 绝不覆盖现有数据
      try { copyEntry(src, dst); result.copied.push(rel); }
      catch (e) { result.ok = false; result.errors.push({ rel, error: e.message }); }
    }
  } catch (e) {
    result.ok = false;
    result.errors.push({ rel: "", error: e.message });
  }
  return result;
}

// ── 出站 HTTP（LLM 端点等）。AppHost 没有网，只有这里能发。 ──
function rawRequest({ url, method = "POST", headers = {}, body = "", timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { resolve({ ok: false, error: "invalid url" }); return; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") { resolve({ ok: false, error: "only http/https allowed" }); return; }

    const payload = typeof body === "string" ? body : (body ? JSON.stringify(body) : "");
    const hdrs = { ...headers };
    if (payload) hdrs["content-length"] = Buffer.byteLength(payload);

    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(parsed, { method: String(method).toUpperCase(), headers: hdrs, timeout: timeoutMs }, (resp) => {
      const chunks = [];
      let total = 0;
      resp.on("data", (c) => {
        total += c.length;
        if (total > MAX_HTTP_BYTES) { resp.destroy(); resolve({ ok: false, error: "response too large", status: resp.statusCode }); return; }
        chunks.push(c);
      });
      resp.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        let json;
        try { json = JSON.parse(text); } catch { /* 非 JSON 就回原文 */ }
        resolve({ ok: true, status: resp.statusCode, json, text: json === undefined ? text : undefined });
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: "request error: " + e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "request timeout" }); });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 图片代理。
 *
 * 以前这里是 execFile(_proxy-fetch.cjs) —— 在 AppHost 里没网、只能靠子进程。
 *
 * ⚠ 原文补的理由是「服务跑在受管 native profile 里不能再 spawn（Job Object，实测 EPERM）」
 *   —— 那条结论**已过期**（现在服务跑降级后的 local-machine，实探可以 spawn；
 *   唯一真相来源：本文件的 probeSpawn）。
 *
 * 进程内直连依旧是对的：服务自己就有原生出站网络，少一个进程、少一层 cmd.exe 解析面。
 * 保留原来那套 SSRF 加固：
 *   · 仅 http/https
 *   · 屏蔽私网 / 回环（host 字符串 + DNS 解析后校验 IP，防 rebinding）
 *   · 限大小、限跳转、校验 content-type
 */
const MAX_PROXY_BYTES = 2.5 * 1024 * 1024; // base64 后约 3.3MB，卡在 AppHost 4MB 响应上限内
const PROXY_MAX_REDIRECTS = 4;
const BLOCKED_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|::1|fc[0-9a-f]{2}:|fe80:)/i;

function isBlockedHost(host) {
  const h = String(host || "").toLowerCase();
  if (BLOCKED_HOST.test(h)) return true;
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return !!(mapped && BLOCKED_HOST.test(mapped[1]));
}

async function verifyResolved(host) {
  const dns = await import("node:dns");
  const addrs = await dns.promises.lookup(host, { all: true });
  for (const a of addrs || []) {
    if (isBlockedHost(a.address)) throw new Error("blocked resolved ip: " + a.address);
  }
}

async function proxyFetch(rawUrl) {
  let current = rawUrl;
  for (let hop = 0; hop <= PROXY_MAX_REDIRECTS; hop++) {
    let parsed;
    try { parsed = new URL(current); } catch { return { ok: false, error: "invalid url" }; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: "only http/https allowed" };
    if (isBlockedHost(parsed.hostname)) return { ok: false, error: "blocked host (private/loopback)" };
    try { await verifyResolved(parsed.hostname); } catch (e) { return { ok: false, error: e.message }; }

    let resp;
    try {
      resp = await fetch(parsed, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: { "user-agent": "Hanako-Mail/1.0", accept: "image/*" },
      });
    } catch (e) {
      return { ok: false, error: "fetch failed: " + e.message };
    }

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) return { ok: false, error: "redirect without location" };
      current = new URL(loc, parsed).href; // 下一轮会重新做完整校验
      continue;
    }
    if (resp.status !== 200) return { ok: false, error: "upstream " + resp.status };

    const ct = String(resp.headers.get("content-type") || "").toLowerCase();
    if (!ct.startsWith("image/")) return { ok: false, error: "not an image (content-type " + ct + ")" };

    const len = Number(resp.headers.get("content-length") || 0);
    if (len > MAX_PROXY_BYTES) return { ok: false, error: "image too large for proxy" };

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_PROXY_BYTES) return { ok: false, error: "image too large for proxy" };
    return { ok: true, ct, base64: buf.toString("base64") };
  }
  return { ok: false, error: "too many redirects" };
}

// ── 桌面通知：写队列，由 AppHost 取走并派发 ──
//
// ⚠ 原写「服务不能 spawn（Job Object → EPERM），而 Windows 通知必须拉起一个进程」——
//   那条结论**已过期**：现在服务跑在降级后的 local-machine，实探可以 spawn
//  （唯一真相来源：本文件的 probeSpawn）。
//
// 但“写队列交给 AppHost”暂时保留：现链路是端到端验证过的，
// 合并两半属于简化、不属于修复（详见 lib/notify-drain.mjs 头部）。
function notifyDir() {
  const dir = path.join(DATA_DIR, "_pending_notify");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

// 队列上限与寿命。
//
// 原来两者都没 —— 队列只增不减，且“取走即删”一旦失败就彻底丢。
// 上限取“丢最旧”而不是“拒新的”：用户更关心刚到的信。
const NOTIFY_MAX = 200;
const NOTIFY_TTL_MS = 24 * 60 * 60 * 1000;

/** 读出队列（带 id），按入队时间升序；顺带清掉过期与损坏的条目。 */
function listNotifications() {
  const dir = notifyDir();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  const now = Date.now();
  const rows = [];
  for (const f of files) {
    const p = path.join(dir, f);
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(p, "utf-8")); } catch { rec = null; }
    if (!rec) { try { fs.unlinkSync(p); } catch { /* ignore */ } continue; }
    const at = Date.parse(rec.queuedAt || "");
    if (Number.isFinite(at) && now - at > NOTIFY_TTL_MS) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
      continue;
    }
    rows.push({ id: f.replace(/\.json$/, ""), ...rec });
  }
  rows.sort((a, b) => String(a.queuedAt || "").localeCompare(String(b.queuedAt || "")));
  return rows;
}

function queueNotification(payload) {
  try {
    const messageId = String(payload.messageId || "");
    const rows = listNotifications();

    // 同一封邮件去重。不加这条会怎样：IMAP IDLE 重连后会重新扫 UNSEEN，
    // 同一封会再入队一次，用户就收到重复通知。
    if (messageId && rows.some((r) => r.messageId === messageId)) {
      return { ok: true, queued: false, deduped: true };
    }

    if (rows.length >= NOTIFY_MAX) {
      for (const old of rows.slice(0, rows.length - NOTIFY_MAX + 1)) {
        try { fs.unlinkSync(path.join(notifyDir(), `${old.id}.json`)); } catch { /* ignore */ }
      }
    }

    const id = Date.now().toString(36) + randomBytes(3).toString("hex");
    fs.writeFileSync(path.join(notifyDir(), `${id}.json`), JSON.stringify({
      subject: payload.subject || "(无主题)",
      sender: payload.sender || "",
      messageId,
      accountId: payload.accountId || "",
      // 实时监听那两条（imap-idle / ws-monitor）直接写目录、不经这里，
      // 它们没这个字段 —— 读取侧默认 INBOX，与它们的语义一致。
      folder: payload.folder || "INBOX",
      queuedAt: new Date().toISOString(),
    }), "utf-8");
    return { ok: true, queued: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 读取队列（AppHost 调用）。**只读不删**。
 *
 * 删除必须等 AppHost 确认发送完成（见 /notify-ack）。
 * 原来是读完就 unlink，而删除发生在 toast 被拉起**之前** —— 只要发送失败，
 * 这条通知就永久消失。实测两次失败（09-20 23:15、09-21 19:06）就是这么丢的。
 */
function drainNotifications(limit = 10) {
  const all = listNotifications();
  return { ok: true, items: all.slice(0, limit), depth: all.length };
}

/** AppHost 确认这批已经投递出去，才真正删除。 */
function ackNotifications(ids) {
  const dir = notifyDir();
  let acked = 0;
  for (const id of (Array.isArray(ids) ? ids : [])) {
    const name = String(id);
    // 只接受本模块自己生成的 id 形状，避免路径穿越。
    if (!/^[\w.-]+$/.test(name)) continue;
    try { fs.unlinkSync(path.join(dir, `${name}.json`)); acked++; } catch { /* 可能已被 TTL 清掉 */ }
  }
  return { ok: true, acked };
}

// ── 点击回调：管道由**服务**拥有 ──
//
// 为什么不能由 AppHost 那一侧建：宿主给应用子进程拼的 argv 只有
// `--permission --allow-fs-read=<安装目录> --allow-fs-read=<app-data>
//  --allow-fs-write=<app-data> [--allow-child-process]`，**没有 --allow-net**；
// 而 Node 26 的权限模型把 net（含 \\.\pipe\）也一起管住。实测助手侧建管道直接报：
//
//   createServer: ERR_ACCESS_DENIED
//     Access to this API has been restricted. Use --allow-net to manage permissions.
//
// 服务这边不一样：它是 profile local-machine + network: external，本来就在监听
// 127.0.0.1，有 net。所以管道放这里 —— AppHost 只负责「拉起 SnoreToast 并把管道名
// 传进去」，点击事件落回服务，服务写 notify-click.json（卡片轮询读的就是它）。
//
// 管道生命周期：收到事件 → 写文件 → 关；或 ARM_TTL_MS 到点自动关。
const ARM_TTL_MS = 90 * 1000;
const armedPipes = new Map(); // name -> { server, timer, meta }

function closeArmedPipe(name) {
  const rec = armedPipes.get(name);
  if (!rec) return;
  armedPipes.delete(name);
  clearTimeout(rec.timer);
  try { rec.server.close(); } catch { /* ignore */ }
}

/**
 * 建一条一次性管道，等 SnoreToast 把点击事件写回来。
 *
 * meta（messageId / accountId）必须由调用方带上：SnoreToast 写回的内容只有
 * `action=activate;button=;...`，不含邮件身份 —— 没有 meta 就不知道点的是哪封。
 */
function armClickPipe(meta) {
  const name = `\\\\.\\pipe\\hana-mail-click-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    let server;
    try {
      server = net.createServer((sock) => {
        const chunks = [];
        // data 与 end 都会来（有些情况下收不到 end，所以 data 也处理一次），
        // 没有这个开关会把同一封点击写两遍、日志打两行。
        let handled = false;
        const handle = () => {
          if (handled) return;
          handled = true;
          const raw = Buffer.concat(chunks).toString("utf16le");
          const kv = {};
          for (const part of raw.split(";")) {
            const i = part.indexOf("=");
            if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1);
          }
          if (kv.action === "activate") {
            try {
              fs.writeFileSync(path.join(DATA_DIR, "notify-click.json"), JSON.stringify({
                action: kv.action,
                messageId: meta?.messageId || "",
                accountId: meta?.accountId || "",
                // 点开要跳回哪一封：光有 messageId 不够，读信 API 还.folder 参数。
                // 卡片那边如果拿当前浏览的 folder 去顶替，就会取错文件夹里的这封。
                folder: meta?.folder || "INBOX",
                // 汇总通知（一波 ≥3 封合并）才有这个值；单封为 0。
                // 写进点击记录是为了让卡片能区分「点开一封」与「点开一批」。
                summaryCount: Number(meta?.summaryCount) || 0,
                pipe: name,
                at: new Date().toISOString(),
              }), "utf-8");
              log("INFO", "通知点击已记录", {
                messageId: meta?.messageId || "",
                summaryCount: Number(meta?.summaryCount) || 0,
              });
            } catch (e) {
              log("WARN", "通知点击写入失败", { err: e.message });
            }
          }
          closeArmedPipe(name);
        };
        sock.on("data", (d) => {
          chunks.push(d);
          // 有些情况下不会收到 end（SnoreToast 写完就走），所以 data 也处理一次。
          if (d.toString("utf16le").includes("action=")) handle();
        });
        sock.on("end", handle);
        sock.on("error", () => { /* 忽略：不影响通知本身 */ });
      });
    } catch (e) {
      finish({ ok: false, error: `createServer: ${e.code || ""} ${e.message}` });
      return;
    }

    server.once("error", (e) => {
      closeArmedPipe(name);
      finish({ ok: false, error: `listen: ${e.code || ""} ${e.message}` });
    });

    server.listen(name, () => {
      const timer = setTimeout(() => closeArmedPipe(name), ARM_TTL_MS);
      if (typeof timer.unref === "function") timer.unref();
      armedPipes.set(name, { server, timer, meta });
      finish({ ok: true, pipe: name, ttlMs: ARM_TTL_MS });
    });
  });
}

// ── AgentQQ 设备码授权 ──────────────────────────────────
//
// 为什么放在服务里：设备流程要发 HTTPS 请求，而 AppHost 没有网。
// 流程分两步（浏览器那段在用户手上，可能好几分钟）：
//   1) /agentqq/login/start  → 返回设备码 + 授权链接，后台开一个长轮询
//   2) /agentqq/login/status → 卡片轮询状态；成功后服务自己把账号写进 accounts.json
// 令牌不经浏览器、不经卡片，只存在服务内存与加密的 accounts.json 里。

const authSessions = new Map(); // sessionId -> { state, email, error, browserUrl, inputCode, expiresAt }
const AUTH_SESSION_TTL_MS = 15 * 60 * 1000;

function sweepAuthSessions() {
  const now = Date.now();
  for (const [id, s] of authSessions) {
    if (s.state !== "pending" && now - (s.updatedAt || 0) > AUTH_SESSION_TTL_MS) authSessions.delete(id);
    else if (s.state === "pending" && now > s.deadlineAt) {
      s.state = "expired"; s.error = "授权超时，请重新发起"; s.updatedAt = now;
    }
  }
}

/** 把授权得到的账号写进 accounts.json（服务与 AppHost 共用同一目录）。 */
function writeAgentqqAccount({ name, email, account }) {
  const file = path.join(DATA_DIR, "accounts.json");
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  list = list.map(decryptSensitiveFields);

  // 同一个邮箱重复授权 = 更新，不新增
  const idx = list.findIndex((a) => String(a.email || "").toLowerCase() === String(email).toLowerCase());
  const rec = {
    id: idx >= 0 ? list[idx].id : String(Date.now()),
    name: name || (idx >= 0 ? list[idx].name : "AgentQQ"),
    email,
    provider: "agentqq",
    createdAt: idx >= 0 ? list[idx].createdAt : Date.now(),
    updatedAt: Date.now(),
    config: {
      ...(idx >= 0 ? list[idx].config || {} : {}),
      agentqqAccessToken: account.accessToken,
      agentqqRefreshToken: account.refreshToken,
      agentqqExpiresAt: String(account.expiresAt),
      agentqqAliasId: account.aliasId || "",
    },
  };
  if (idx >= 0) list[idx] = rec; else list.push(rec);
  fs.writeFileSync(file, JSON.stringify(list.map(encryptSensitiveFields), null, 2), "utf-8");
  return rec;
}

async function startAgentqqLogin({ name }) {
  const dev = await startDeviceFlow();
  const sessionId = randomBytes(8).toString("hex");
  const session = {
    state: "pending",
    browserUrl: dev.browserUrl,
    inputCode: dev.inputCode,
    expiresIn: dev.expiresIn,
    deadlineAt: Date.now() + Math.min(dev.expiresIn * 1000, 10 * 60 * 1000),
    updatedAt: Date.now(),
  };
  authSessions.set(sessionId, session);

  // 后台等授权：拿不到就等，拿到就建账号。不阻塞这个请求。
  (async () => {
    try {
      const tokens = await waitForAuthorization(dev.pollUrl, { deadlineMs: session.deadlineAt });
      const auth = await import("./agentqq-backend.mjs").then((m) => m);
      // 用刚拿到的令牌写进进程环境，才能调 /v1/me
      process.env.AGENTQQ_ACCESS_TOKEN = tokens.accessToken;
      process.env.AGENTQQ_REFRESH_TOKEN = tokens.refreshToken;
      process.env.AGENTQQ_EXPIRES_AT = String(tokens.expiresAt);
      process.env.AGENTQQ_ALIAS_ID = "";
      auth.shutdown();

      const ident = await auth.getIdentity();
      const first = ident.aliases.find((a) => a.id) || null;
      const email = (first && first.email) || "agentqq@agent.qq.com";
      const rec = writeAgentqqAccount({
        name,
        email,
        account: { ...tokens, aliasId: first ? first.id : "" },
      });

      session.state = "authorized";
      session.email = email;
      session.accountId = rec.id;
      session.aliases = ident.aliases;
      session.updatedAt = Date.now();
      log("INFO", "AgentQQ 授权成功，账号已创建", { email, accountId: rec.id });
    } catch (e) {
      session.state = "failed";
      session.error = e?.message || String(e);
      session.updatedAt = Date.now();
      log("WARN", "AgentQQ 授权失败", { error: session.error });
    }
  })();

  return {
    sessionId,
    inputCode: dev.inputCode,
    browserUrl: dev.browserUrl,
    expiresIn: dev.expiresIn,
  };
}

// ── 延迟到此处才 import 后端：它们都在模块作用域读 HANAKO_PLUGIN_DATA ──
//
// 必须过 pathToFileURL：Windows 上从非 C: 盘（如 W:）用绝对路径 import() 会撞
// ERR_UNSUPPORTED_ESM_URL_SCHEME（"Received protocol 'w:'"）。把反斜杠换成斜杠
// **不够** —— 盘符仍被当成 URL scheme。
function backendModule(rel) {
  return import(pathToFileURL(path.join(BACKEND_DIR, rel)).href);
}

let inbox = null;
async function loadBackend() {
  try {
    inbox = await backendModule("inbox.mjs");
    log("INFO", "inbox 命令表已加载");
  } catch (e) {
    log("ERROR", "inbox 加载失败（依赖可能未装好，/cli 会不可用）", { error: e.message });
    inbox = null;
  }
}

async function startListeners() {
  try {
    const wsMonitor = await backendModule("ws-monitor.mjs");
    await wsMonitor.startAll();
    log("INFO", "ws-monitor 已启动");
  } catch (e) { log("ERROR", "ws-monitor 启动失败", { error: e.message }); }
  try {
    const imapIdle = await backendModule("imap-idle.mjs");
    await imapIdle.startAll();
    log("INFO", "imap-idle 已启动");
  } catch (e) { log("ERROR", "imap-idle 启动失败", { error: e.message }); }
}

// ── HTTP 服务 ──
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > MAX_HTTP_BYTES) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const s = Buffer.concat(chunks).toString("utf-8");
      if (!s) { resolve({}); return; }
      try { resolve(JSON.parse(s)); } catch { resolve(null); }
    });
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const route = url.pathname;

  // /health 不挑方法：桥（callService）总是 POST，手工排查时常 GET。
  // 只认 GET 会让桥拿到 404 —— 实测踩过。
  if (route === "/health") {
    return send(res, 200, {
      ok: true,
      deps: checkDeps().length === 0,
      missing: checkDeps(),
      node: process.version,
      port: PORT,
      // 诊断：依赖自愈的前提（能 spawn + 看得见 npm）。放 /health 而不是新端点 ——
      // 回环本来就没鉴权，不再多一个可被本机进程触发的动作。
      spawn: _spawnProbe,
      npm: _npmRunner ? { root: _npmRunner.root, version: _npmVersion } : null,
    });
  }

  if (req.method !== "POST") return send(res, 405, { ok: false, error: "method not allowed" });
  const body = await readBody(req);
  if (body === null) return send(res, 413, { ok: false, error: "body too large or invalid json" });

  try {
    if (route === "/migrate") {
      return send(res, 200, migrate(body.from || LEGACY_DIR, body.to || DATA_DIR));
    }
    if (route === "/cli") {
      if (!inbox) return send(res, 503, { ok: false, error: "backend not loaded" });
      const handler = inbox.COMMANDS?.[body.cmd];
      if (!handler) return send(res, 400, { ok: false, error: `unknown command: ${body.cmd}` });
      for (const [k, v] of Object.entries(body.env || {})) {
        if (v !== undefined && v !== null) process.env[k] = String(v);
      }
      inbox.resetAccountCache();
      const data = await handler(body.args || []);
      return send(res, 200, { ok: true, data });
    }
    if (route === "/http") return send(res, 200, await rawRequest(body));
    if (route === "/proxy") return send(res, 200, await proxyFetch(body.url));
    if (route === "/notify") return send(res, 200, queueNotification(body));
    if (route === "/pending-notify") return send(res, 200, drainNotifications(body.limit));
    if (route === "/notify-ack") return send(res, 200, ackNotifications(body.ids));
    if (route === "/notify-arm-pipe") {
      // 管道名与事件回流都在这一侧（有 net）。AppHost 拿名字去拉起 SnoreToast。
      return send(res, 200, await armClickPipe({
        messageId: body.messageId,
        accountId: body.accountId,
        folder: body.folder,
        summaryCount: body.summaryCount,
      }));
    }

    if (route === "/agentqq/login/start") {
      sweepAuthSessions();
      return send(res, 200, { ok: true, data: await startAgentqqLogin({ name: body.name }) });
    }
    if (route === "/agentqq/login/status") {
      sweepAuthSessions();
      const s = authSessions.get(body.sessionId);
      if (!s) return send(res, 200, { ok: true, data: { state: "unknown" } });
      return send(res, 200, {
        ok: true,
        data: {
          state: s.state,
          email: s.email,
          accountId: s.accountId,
          aliases: s.aliases,
          error: s.error,
          inputCode: s.inputCode,
          browserUrl: s.browserUrl,
        },
      });
    }
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }

  return send(res, 404, { ok: false, error: "not found" });
}

async function main() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }
  log("INFO", "邮件后端服务启动", {
    dataDir: DATA_DIR,
    legacyDir: LEGACY_DIR,
    port: PORT,
    node: process.version,
    argv: process.argv.slice(1),
    cwd: process.cwd(),
  });

  // 迁移放在服务里做，而不是让 AppHost 启动后再调一次：
  // AppHost 读不到 plugin-data（不在它的只读白名单里）。
  // 服务启动 = 迁移完成，两件事绑成一件。
  try {
    const res = migrate(LEGACY_DIR, DATA_DIR);
    if (res.copied.length) log("INFO", "已从 v1 数据目录迁移", { copied: res.copied, from: res.from });
    else if (res.errors?.some((e) => e.error !== "source-missing")) {
      log("ERROR", "数据迁移失败，账号可能无法读取", {
        errors: res.errors,
        hint: `可手动把 ${LEGACY_DIR} 下的 accounts.json / .cred-salt / cache 复制到 ${DATA_DIR}`,
      });
    } else {
      log("INFO", "无需迁移（v1 数据目录不存在或目标已就绪）", { skipped: res.skipped });
    }
  } catch (e) {
    log("ERROR", "数据迁移异常，账号可能无法读取", { error: e.message });
  }

  // 依赖检查不再阻塞就绪：缺失时 /cli 会报错，但服务本身要起来，
  // 这样 /health 与其它端点仍可用（也便于诊断）。
  const depsOk = reportDeps();
  // 启动时真测一次 spawn 能力（结论落在 service.log），见上面 probeSpawn 的注释。
  probeSpawn();

  if (depsOk) {
    startListeners().catch((e) => log("ERROR", "监听启动失败", { error: e.message }));
    await loadBackend();
  } else {
    // 缺依赖：**后台**自愈，装好了再加载后端。
    // 这里绝不能阻塞 —— 服务必须立刻开始监听，否则 AppHost 在 15 秒就绪超时后会重试，
    // 而一个还在 npm install 的服务进程会和第二个进程抢同一个 backend/node_modules。
    //
    // ★ 监听器也推到自愈之后：ws-monitor / imap-idle 一上来就 import 后端依赖
    //   （@clawemail/node-sdk、imapflow），依赖没到位时启动必然失败 ——
    //   实测就是“自愈 5 秒装完了，但两个监听器已经死在那里”，
    //   而后端加载了、监听器没回来，从外面看依旧像“同步不工作”。
    autoInstallDeps(checkDeps())
      .then(async (ok) => {
        if (!ok) {
          log("ERROR", "依赖自愈未成功，邮件功能不可用", {
            missing: checkDeps(),
            hint: "正式安装下依赖随包发布（backend/node_modules），可重新安装本应用；"
              + "开发目录可手动 `cd backend && npm install`。",
          });
          return;
        }
        startListeners().catch((e) => log("ERROR", "自愈后监听启动失败", { error: e.message }));
        try {
          await loadBackend();
          log("INFO", "自愈后后端与监听器已启动");
        } catch (e) {
          log("ERROR", "自愈后加载后端失败", { error: e.message });
        }
      })
      .catch((e) => log("ERROR", "后台自愈异常", { error: e.message }));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { try { send(res, 500, { ok: false, error: e.message }); } catch { /* ignore */ } });
  });

  server.on("error", (e) => {
    log("ERROR", "HTTP 服务启动失败", { error: e.message, port: PORT });
    process.exit(1);
  });

  server.listen(PORT, "127.0.0.1", () => {
    log("INFO", `HTTP 已监听 127.0.0.1:${PORT}`);
    // stdout 只打这一行：宿主按它判定服务已就绪。
    process.stdout.write(READY_MARKER + "\n");
  });
}

// 启动期的同步崩溃也要留下痕迹：受管进程的 stdout/stderr 被宿主收走，
// 拿不到时 service.log 是唯一现场。
process.on("uncaughtException", (e) => {
  log("ERROR", "uncaughtException", { error: e?.stack || String(e) });
});
process.on("unhandledRejection", (e) => {
  log("ERROR", "unhandledRejection", { error: e?.stack || String(e) });
});

main().catch((e) => { log("ERROR", "服务启动失败", { error: e?.stack || String(e) }); process.exit(1); });
