/**
 * imap-idle.mjs — IMAP 实时收件监听器（RFC 2177 IDLE）
 *
 * 功能：为每个个人邮箱（IMAP 后端）账号建立 IDLE 长连接，服务器有新邮件时
 * 主动推送（imapflow 触发 'exists' 事件），插件立即：
 *   1) 拉取最新未读邮件（解析 subject/from）
 *   2) 写入 plugin-data 缓存（cache/ws-<accountId>-<mailId>.json，与 ws-monitor 同格式，
 *      前端 / 工具列表自动合并）
 *   3) 弹系统级桌面通知（写 _pending_notify 队列，由 AppHost 派发）
 *
 * 断线自动重连；服务器不支持 IDLE 时自动降级为周期性检查。
 * 由 index.js 启动/关停；cleanup.cjs 兜底清理。
 *
 * ── 2026-09-22：协议层从 `imap`（node-imap）迁到 `imapflow` ──
 * 业务部分（去重集、写缓存、入队通知、重连、常驻守护）原样保留，只换了协议那一半。
 *
 * ★★ 这个监听器用的是**独立的一条连接**，不走 imapflow-client.mjs 的命令连接池。
 *    原因见 05-IMAP层-imapflow迁移设计.md 第六节：IDLE 要长期占着连接，
 *    而 imapflow 的锁是独占语义。两者共用一条连接会变成
 *    「新邮件通知照弹，但点开列表一直转圈」——一半能用一半不能用，
 *    而且症状会把人引向网络或邮件服务器，而不是引向锁。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { setCryptoDataDir, decryptSensitiveFields } from "./cred-crypto.mjs";
import { runtimeDataDir } from "../lib/env.mjs";
import { appendRolling } from "./log-roll.mjs";
import { getImapConfig } from "./imap-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 数据目录由主进程经 HANAKO_PLUGIN_DATA 传入（v1 的回退路径曾经少一层，
// 导致读到空目录 → 账号数为 0 → 进程空转退出 → 父进程每 10 秒重启一次）。
// v2 统一走 lib/env.mjs，回退值与其它后端一致。
const DATA_DIR = runtimeDataDir();
const LOG_PATH = path.join(DATA_DIR, "imap-idle.log");
const POLL_FALLBACK_MS = 2 * 60 * 1000; // 不支持 IDLE 时降级轮询间隔
const MAX_FETCH_PER_EVENT = 5;          // 单次事件最多拉取/通知的邮件数
const RECONNECT_MS = 30000;             // 断线重连间隔（与迁移前一致）

function log(level, msg, data) {
  const ts = new Date().toISOString();
  // `data !== undefined`：v1 里写成 `data ?`，于是「账号数量 0」被打成空白 ——
  // 恰恰把关键信息遮住了。
  const line = data !== undefined ? `[${ts}] [${level}] ${msg} ${JSON.stringify(data)}` : `[${ts}] [${level}] ${msg}`;
  appendRolling(LOG_PATH, line);
  process.stderr.write(line + "\n");
}

function loadAccounts() {
  const accountsPath = path.join(DATA_DIR, "accounts.json");
  // ⚠️ issue #4：旧写法是裸 `catch { return [] }`，把
  //   「文件不存在」「JSON 坏了」「凭据解不开」「真没账号」压成同一个空数组，
  //   日志里就看不出到底是哪一种——而「凭据解不开」恰恰是最需要看见的那种。
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(accountsPath, "utf-8"));
  } catch (e) {
    if (e && e.code === "ENOENT") {
      log("WARN", "accounts.json 不存在，无账号可监听", { path: accountsPath });
    } else {
      log("ERROR", "accounts.json 读取/解析失败", { path: accountsPath, err: e.message });
    }
    return [];
  }

  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) {
    log("WARN", "accounts.json 里没有账号条目");
    return [];
  }

  const out = [];
  for (const item of list) {
    let acc;
    try {
      setCryptoDataDir(DATA_DIR);
      acc = decryptSensitiveFields(item);
    } catch (e) {
      // 解密链本身抛错（例如密钥派生失败）——必须留声，不能静默吞掉。
      log("ERROR", "账号凭据解密抛错，跳过该账号", {
        email: item && item.config && item.config.user,
        err: e.message,
      });
      continue;
    }
    if (acc && Array.isArray(acc._undecryptable) && acc._undecryptable.length) {
      log("ERROR", "账号凭据无法解密（可能是换过机器、或系统用户名不可用）", {
        email: acc.config && acc.config.user,
        fields: acc._undecryptable,
      });
    }
    out.push(acc);
  }
  return out;
}

// ── 已处理集合（防重复通知/缓存） ──
function loadProcessed(accountId) {
  const f = path.join(DATA_DIR, `_processed_imap_${accountId}.json`);
  try { return new Set(JSON.parse(fs.readFileSync(f, "utf-8"))); } catch { return new Set(); }
}
function saveProcessed(accountId, set) {
  const f = path.join(DATA_DIR, `_processed_imap_${accountId}.json`);
  try { fs.writeFileSync(f, JSON.stringify([...set]), "utf-8"); } catch {}
}

// ── 写缓存（与 ws-monitor 同格式，前端自动合并） ──
function saveMail(accountId, mail) {
  const cacheDir = path.join(DATA_DIR, "cache");
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
  const safeMailId = String(mail.id).replace(/:/g, "_");
  const file = path.join(cacheDir, `ws-${accountId}-${safeMailId}.json`);
  try { fs.writeFileSync(file, JSON.stringify(mail, null, 2), "utf-8"); } catch (e) {
    log("WARN", "save mail failed", { mailId: mail.id, err: e.message });
  }
}

// ── 系统桌面通知：写队列，由 AppHost 取走并派发 ──
//
// ⚠ 原写「本模块跑在受管 native 服务里，不能 spawn（Job Object → EPERM）」——
//   那条结论**已过期**：现在 native 永远建不起来（HANA_HOME 是符号链接），
//   服务实际跑在降级后的 local-machine（enforcement: none），实探可以 spawn。
//   唯一真相来源：runtime/service.mjs 的 probeSpawn。
//
// 但“写队列交给 AppHost”这个形态**暂时保留**：现链路是端到端验证过的，
// 而合并两半属于简化、不属于修复（详见 lib/notify-drain.mjs 头部）。
function notifyDesktop(subject, sender, messageId, accountId) {
  try {
    const dir = path.join(DATA_DIR, "_pending_notify");
    fs.mkdirSync(dir, { recursive: true });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
      subject: subject || "(无主题)", sender: sender || "", messageId: messageId || "",
      accountId: accountId || "", queuedAt: new Date().toISOString(),
    }), "utf-8");
  } catch (e) {
    log("WARN", "桌面通知入队失败", { err: e.message });
  }
}

// ── 从监听连接拉取并解析最新未读邮件 ──
async function fetchNewMails(client, limit = MAX_FETCH_PER_EVENT) {
  // ★ { uid: true }：imapflow 的 search **默认返回序号**，不是 UID
  //（SearchOptions.uid 的注释：「If true then returns UID numbers instead of
  //  sequence numbers」）。不加这个选项，拿序号当 UID 取信会一封都取不到 ——
  // 而这个错误在「新建、无删除、序号恰好等于 UID」的收件箱上看不出来。
  const uids = await client.search({ seen: false }, { uid: true });
  const recent = (Array.isArray(uids) ? uids : []).slice(-limit);
  if (!recent.length) return [];

  const parsed = [];
  for await (const m of client.fetch(recent, { source: true, uid: true }, { uid: true })) {
    try {
      const p = await simpleParser(m.source);
      parsed.push({
        id: String(m.uid),
        uid: m.uid,
        from: p.from ? p.from.text : "",
        subject: p.subject || "(无主题)",
        date: p.date || new Date(),
        textContent: p.text || "",
        read: false,
        platform: "imap-idle",
      });
    } catch (e) {
      log("WARN", "parse failed", { uid: m.uid, err: e.message });
    }
  }
  return parsed;
}

// ── 单个账号的 IDLE 监听 ──
async function watchAccount(account) {
  const email = account.email;
  const accountId = account.id;
  if (!email || accountId == null) return null;
  const lower = String(email).toLowerCase();
  if (lower.endsWith("@claw.163.com") || lower.endsWith("@agent.qq.com")) return null; // 非 IMAP 后端

  const cfg = account.config || {};
  const processed = loadProcessed(accountId);

  // 凭据注入 process.env 后复用共享的配置解析（含域名推断）
  const prevEnv = {};
  const setEnv = (k, v) => { prevEnv[k] = process.env[k]; if (v !== undefined && v !== null) process.env[k] = String(v); };
  setEnv("IMAP_HOST", cfg.imapHost); setEnv("IMAP_PORT", cfg.imapPort);
  setEnv("IMAP_USER", cfg.imapUser); setEnv("IMAP_PASS", cfg.imapPass);

  let client = null;
  let closed = false;
  let reconnectTimer = null;
  let fallbackTimer = null;

  const cleanup = () => { for (const k of Object.keys(prevEnv)) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; } };

  const onNewMail = async () => {
    if (closed || !client || !client.usable) return;
    try {
      const mails = await fetchNewMails(client);
      for (const mail of mails) {
        if (processed.has(mail.id)) continue;
        // 跳过自己发出的邮件
        const fromStr = mail.from || "";
        if (fromStr.includes(email)) continue;
        mail.accountId = accountId;
        mail.receivedAt = new Date().toISOString();
        saveMail(accountId, mail);
        processed.add(mail.id);
        notifyDesktop(mail.subject, fromStr, mail.id, accountId);
        log("INFO", "新邮件已缓存并通知", { accountId, mailId: mail.id, subject: mail.subject, from: fromStr });
      }
      saveProcessed(accountId, processed);
      if (processed.size > 2000) { // 防无限增长
        for (const k of [...processed].slice(0, 500)) processed.delete(k);
      }
    } catch (e) {
      log("WARN", "新邮件处理失败", { err: e.message });
    }
  };

  // IDLE：imapflow 的 idle() 在服务器结束 IDLE（超时 / 有新邮件）时 resolve，
  // 返回 `false` 表示服务器不支持 IDLE → 交给 2 分钟轮询兜底。
  const idleLoop = async (c) => {
    while (!closed && client === c && c.usable) {
      let supported;
      try {
        supported = await c.idle();
      } catch (e) {
        log("WARN", "IDLE 异常，准备重连", { email, err: e.message });
        imapEnd(c);
        return;
      }
      if (supported === false) {
        log("INFO", "服务器不支持 IDLE，降级为周期轮询", { email });
        return;
      }
      if (closed || client !== c) return;
      // IDLE 结束（多半是来了新邮件）→ 补扫一次：
      // 事件只告诉我们「变了」，不保证在事件窗口内一定抓到那一封。
      await onNewMail();
    }
  };

  const connect = async () => {
    if (closed) return;
    let next = null;
    try {
      const config = getImapConfig(email);
      if (!config.host) { log("WARN", "缺少 IMAP 主机配置，跳过", { email }); return; }

      next = new ImapFlow({
        host: config.host,
        port: config.port,
        secure: config.tls !== false,
        auth: { user: config.user, pass: config.password },
        logger: false,
      });
      // ★ 必须挂 error 监听。imapflow 是 EventEmitter，未处理的 'error'
      //   会按 Node 语义直接打崩整个服务进程（node-imap 那条路径已经中过一次）。
      next.on("error", (err) => log("WARN", "连接错误", { email, err: err.message }));

      await next.connect();
      await next.mailboxOpen("INBOX", { readOnly: true });
      if (closed) { try { next.close(); } catch {} return; }

      client = next;
      log("INFO", "已连接并进入监听", { email });

      // 身份判断，避免旧连接的事件打扰新连接
      next.on("exists", () => { if (client === next) onNewMail(); });
      next.on("close", () => { if (client === next) { log("WARN", "连接关闭，准备重连", { email }); imapEnd(next); } });

      // 兜底：周期检查（服务器不支持 IDLE 或事件偶发丢失时，仍能收到新邮件）
      if (fallbackTimer) clearInterval(fallbackTimer);
      fallbackTimer = setInterval(() => { onNewMail(); }, POLL_FALLBACK_MS);

      idleLoop(next);
    } catch (e) {
      log("WARN", "连接失败", { email, err: e.message });
      try { if (next) next.close(); } catch {}
      // ⚠️ issue #4：这里必须传 null，不能传 next。
      //   imapEnd 第一行是 `if (which && client !== which) return;`，
      //   而首连失败时 client 还是 null —— 传 next 会命中 early return，
      //   重连定时器永远排不上，账号就永久静默失联。
      imapEnd(null);
    }
  };

  const imapEnd = (which) => {
    if (closed) return;
    if (which && client !== which) return; // 旧连接的收尾，忽略
    try { if (client) client.close(); } catch {}
    client = null;
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
    cleanup();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { if (!closed) connect(); }, RECONNECT_MS);
  };

  connect();

  // 返回停止函数（进程退出时由 stopAll 统一处理，这里仅做标记）
  return () => { closed = true; if (reconnectTimer) clearTimeout(reconnectTimer); if (fallbackTimer) clearInterval(fallbackTimer); try { if (client) client.close(); } catch {} cleanup(); };
}

// ── 启动全部 IMAP 账号（可重复调用：只补启动新增账号，不重复连接已有） ──
const RECONCILE_MS = 60 * 1000;
const stopFns = new Map(); // accountId -> stopFn（仅活跃监听）
let reconcileTimer = null;
let running = false;

async function reconcile() {
  const accounts = loadAccounts();
  for (const account of accounts) {
    const id = account.id;
    if (id == null || stopFns.has(id)) continue;
    try {
      const stop = await watchAccount(account);
      if (typeof stop === "function") {
        stopFns.set(id, stop);
        log("INFO", "新增监听账号", { email: account.email });
      }
    } catch (e) {
      log("ERROR", "启动账号失败", { email: account.email, err: e.message });
    }
  }
  return accounts.length;
}

export async function startAll() {
  if (running) return;
  running = true;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  log("INFO", "数据目录", DATA_DIR);
  log("INFO", "账号数量", await reconcile());
  log("INFO", "已监听 IMAP 账号数", stopFns.size);
  // 常驻守护：定期补扫新账号。即使当前一个 IMAP 账号都没有（例如只有 ClawEmail），
  // 也保持进程存活——否则进程会立即以 0 正常退出，被父进程当成崩溃而每 10 秒重启一次。
  if (!reconcileTimer) reconcileTimer = setInterval(() => { reconcile().catch(() => {}); }, RECONCILE_MS);
}

export function stopAll() {
  running = false;
  if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
  for (const fn of stopFns.values()) { try { fn(); } catch { /* ignore */ } }
  stopFns.clear();
}

// 直接运行模式：被 runtime/service.mjs import 时不接管进程生命周期。
const IS_MAIN = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (IS_MAIN) {
  const shutdown = (code = 0) => {
    log("INFO", "收到退出信号，关闭 IMAP 监听...");
    stopAll();
    process.exit(code);
  };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGBREAK", () => shutdown(0));

  log("INFO", "文件已加载");
  startAll();
}
