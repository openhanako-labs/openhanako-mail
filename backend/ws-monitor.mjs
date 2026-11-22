/**
 * WebSocket 实时收件监听器
 * 
 * 功能：
 * - 为每个 ClawEmail 账号建立 WebSocket 连接
 * - 收到新邮件后写入 plugin-data 缓存
 * - 收到新邮件后直接调用 helper/mail-toast.cjs 弹系统级桌面通知
 */

import { MailClient } from "@clawemail/node-sdk";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
// accounts.json 中的 apiKey 是加密存储的（routes/ui.js 加密落盘），读取后必须解密，
// 否则 MailClient 会拿到 "ENC:..." 密文导致 WebSocket 实时收件失效。
import { setCryptoDataDir, decryptSensitiveFields } from "./cred-crypto.mjs";
import { appendRolling } from "./log-roll.mjs";

// 供 runtime/service.mjs 覆盖数据目录（服务启动时先设好再 import 本模块）
export function setDataDir(dir) { if (dir) process.env.HANAKO_PLUGIN_DATA = dir; }

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getDataDir() {
  // plugin-data 目录在 Hana 的数据根下，不在插件目录内
  const dataRoot = process.env.HANAKO_PLUGIN_DATA || path.join(process.env.USERPROFILE || "", ".hanako", "plugin-data", "hanako-mail", "hanako-mail");
  return dataRoot;
}

const LOG_PATH = path.join(getDataDir(), "ws-monitor.log");
function log(level, msg, data) {
  const ts = new Date().toISOString();
  const line = data ? `[${ts}] [${level}] ${msg} ${JSON.stringify(data)}` : `[${ts}] [${level}] ${msg}`;
  appendRolling(LOG_PATH, line);
  console.log(line);
}

function getCacheDir() {
  return path.join(getDataDir(), "cache");
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

// ── _pending_notify 孤儿清理 ────────────────────────────────────────────
// 起因：派发失败或 App 重启中断时，队列没有 TTL 清理。
// 2026-09-25 实测：32 个通知从 2026-07-26 起从未被 ack，永远留在磁盘上。
// 判据：超过 7 天未被 ack 的通知视为孤儿。7 天足够长——正常链路 5 秒一轮，
// 即使 App 挂了三天、toast 助手卡了三天，也不该有通知活到 7 天还没派发。
const NOTIFY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const NOTIFY_PRUNE_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟节流
let _lastNotifyPrune = 0;

export function prunePendingNotify() {
  const dir = path.join(getDataDir(), "_pending_notify");
  let names;
  try { names = fs.readdirSync(dir); } catch { return { removed: 0 }; }
  const cutoff = Date.now() - NOTIFY_MAX_AGE_MS;
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.mtimeMs >= cutoff) continue;
    try { fs.unlinkSync(full); removed++; } catch { /* ignore */ }
  }
  return { removed };
}

/** 5 分钟节流；只在有新通知要写时才跑，App 长期不活跃时不白扫。 */
function maybePrunePendingNotify() {
  const now = Date.now();
  if (now - _lastNotifyPrune < NOTIFY_PRUNE_INTERVAL_MS) return;
  _lastNotifyPrune = now;
  try { prunePendingNotify(); } catch { /* ignore */ }
}

// ── cache/ws-*.json 清理 ────────────────────────────────────────────────
// 每封实时收到的邮件都会在 cache/ 落一个 ws-<accountId>-<mailId>.json（含正文全文），
// 原来**没有任何清理机制** —— 2026-09-22 实测 62 个文件 / 1.65 MB，随收信量线性增长，
// 最大的单个已 529 KB。
//
// ★ 只按「数量」淘汰，**故意不设时间上限**。
// 这两个文件看起来像缓存，其实不是：`readWsCache()`（http/ui.js:324、tools/sync.js:21）
// 把它们整个并进邮件列表，而服务器侧固定只给最新 50 封（`list --limit=50`）——
// 比那 50 封更老的、只靠实时通道收到的信，**这份文件是它们在本地唯一的痕迹**。
// 最初写成「14 天」时实测会删掉 62 个里的 54 个，等于让列表里的旧邮件凭空消失。
// 所以这里把它当「可见归档」处理：只封顶数量，不按时间清。
const WS_CACHE_MAX_FILES = 500;
const WS_CACHE_PRUNE_EVERY = 50; // 每写入这么多封清理一次
let _savesSincePrune = 0;

export function pruneWsCache() {
  const cacheDir = getCacheDir();
  let names;
  try {
    names = fs.readdirSync(cacheDir);
  } catch {
    return { removed: 0, kept: 0 };
  }
  const entries = [];
  for (const name of names) {
    if (!name.startsWith("ws-") || !name.endsWith(".json")) continue;
    const full = path.join(cacheDir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    entries.push({ full, mtime: st.mtimeMs });
  }
  entries.sort((a, b) => b.mtime - a.mtime); // 新 → 旧
  let removed = 0;
  for (let i = 0; i < entries.length; i++) {
    if (i < WS_CACHE_MAX_FILES) continue; // 上限内的一律不动
    try {
      fs.unlinkSync(entries[i].full);
      removed++;
    } catch {
      /* 删不掉就留着，下次再说 */
    }
  }
  return { removed, kept: entries.length - removed };
}

function saveMail(accountId, mail) {
  const cacheDir = getCacheDir();
  ensureDir(cacheDir);
  const safeMailId = mail.id.replace(/:/g, "_");
  const file = path.join(cacheDir, `ws-${accountId}-${safeMailId}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(mail, null, 2), "utf-8");
  } catch (e) {
    log("WARN", "save mail failed", { mailId: mail.id, err: e.message });
  }
  _savesSincePrune++;
  if (_savesSincePrune >= WS_CACHE_PRUNE_EVERY) {
    _savesSincePrune = 0;
    const pruned = pruneWsCache();
    if (pruned.removed) log("INFO", "缓存清理", pruned);
  }
}

function loadAccounts() {
  const accountsPath = path.join(getDataDir(), "accounts.json");
  // 同 issue #4：裸 catch 会把四种失败压成同一个空数组，日志里看不出原因。
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(accountsPath, "utf-8"));
  } catch (e) {
    if (e && e.code === "ENOENT") {
      log("WARN", "accounts.json 不存在，无账号可监控", { path: accountsPath });
    } else {
      log("ERROR", "accounts.json 读取/解析失败", { path: accountsPath, err: e.message });
    }
    return [];
  }

  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    try {
      setCryptoDataDir(getDataDir());
      const acc = decryptSensitiveFields(item);
      if (acc && Array.isArray(acc._undecryptable) && acc._undecryptable.length) {
        log("ERROR", "账号凭据无法解密（可能是换过机器、或系统用户名不可用）", {
          email: acc.config && acc.config.user,
          fields: acc._undecryptable,
        });
      }
      out.push(acc);
    } catch (e) {
      log("ERROR", "账号凭据解密抛错，跳过该账号", {
        email: item && item.config && item.config.user,
        err: e.message,
      });
    }
  }
  return out;
}

function loadProcessed(accountId) {
  const f = path.join(getDataDir(), `_processed_${accountId}.json`);
  try { return new Set(JSON.parse(fs.readFileSync(f, "utf-8"))); } catch { return new Set(); }
}

function saveProcessed(accountId, set) {
  const f = path.join(getDataDir(), `_processed_${accountId}.json`);
  fs.writeFileSync(f, JSON.stringify([...set]), "utf-8");
}

// ── 桌面通知：写队列，由 AppHost 取走并派发 ──
//
// ⚠ 原写「本模块跑在受管 native 服务里，不能 spawn（Job Object → EPERM）」——
//   那条结论**已过期**：现在 native 永远建不起来（HANA_HOME 是符号链接），
//   服务实际跑在降级后的 local-machine（enforcement: none），实探可以 spawn。
//   唯一真相来源：runtime/service.mjs 的 probeSpawn。
//
// 但“写队列交给 AppHost”这个形态**暂时保留**：现链路是端到端验证过的，
// 而合并两半属于简化、不属于修复（详见 lib/notify-drain.mjs 头部）。
function notifyDesktop(subject, sender, messageId, accountId) {
  maybePrunePendingNotify();
  try {
    const dir = path.join(getDataDir(), "_pending_notify");
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

async function startAccount(account) {
  if (!account.apiKey || !account.email) return;
  if (!account.email.endsWith("@claw.163.com")) return; // 只处理 ClawEmail

  const accountId = account.id;
  const processed = loadProcessed(accountId);

  const client = new MailClient({
    apiKey: account.apiKey,
    user: account.email,
    logger: {
      info: (msg, data) => log("INFO", msg, data),
      warn: (msg, data) => log("WARN", msg, data),
      error: (msg, data) => log("ERROR", msg, data),
    },
  });

  client.accountId = accountId;

  client.ws.onMessage(async (notification) => {
    const mailId = notification?.mailId;
    if (!mailId) return;
    if (processed.has(mailId)) return;

    try {
      const email = await client.mail.read({ id: mailId, markRead: true });
      const fromArr = Array.isArray(email.from) ? email.from : [email.from || ""];
      const fromStr = fromArr.join(" ");
      const subject = email.subject || "(无主题)";
      const textContent = email.text?.content || email.html?.content || "";

      // 跳过自己发出的邮件
      if (fromArr.some(f => f.includes(account.email))) {
        processed.add(mailId);
        saveProcessed(accountId, processed);
        return;
      }

      const mail = {
        id: mailId,
        from: email.from,
        to: email.to,
        subject,
        date: email.date,
        textContent,
        hasHtml: !!email.html?.content,
        attachments: email.attachments?.map(a => ({ id: a.id, filename: a.filename, contentType: a.contentType, size: a.size })),
        platform: "clawemail",
        accountId,
        receivedAt: new Date().toISOString(),
      };

      saveMail(accountId, mail);
      processed.add(mailId);
      saveProcessed(accountId, processed);

      // 桌面通知
      notifyDesktop(subject, fromStr, mailId, accountId);

      log("INFO", "新邮件已缓存", { accountId, mailId, subject, from: fromStr });
    } catch (e) {
      log("ERROR", "处理邮件失败", { accountId, mailId, err: e.message });
    }
  });

  client.ws.onDisconnect(async (reason) => {
    log("WARN", `WebSocket 断开: ${reason}，5秒后重连...`);
    setTimeout(() => startAccount(account), 5000);
  });

  try {
    await client.ws.connect();
    log("INFO", `WebSocket 已连接: ${account.email}`);
  } catch (e) {
    log("ERROR", `连接失败: ${e.message}`);
    setTimeout(() => startAccount(account), 10000);
  }
}

// 启动所有账号
export async function startAll() {
  ensureDir(getDataDir());
  const pruned = pruneWsCache();
  const accounts = loadAccounts();
  log("INFO", "数据目录", getDataDir());
  log("INFO", "缓存清理", pruned);
  log("INFO", "账号数量", accounts.length);
  for (const account of accounts) {
    log("INFO", "启动账号", account.email);
    try { await startAccount(account); } catch (e) {
      log("ERROR", "启动账号失败", { email: account.email, err: e.message });
    }
  }
}

// 直接运行模式（被 spawn 时执行）。
// 被 runtime/service.mjs import 时不自启 —— 那里由服务自己调 startAll() 并拥有生命周期。
// 否则本文件的 SIGTERM 处理器会把整个服务进程一起带走。
const IS_MAIN = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (IS_MAIN) {
  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("INFO", "收到退出信号，正在关闭 WebSocket 监听...");
    process.exit(code);
  };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGBREAK", () => shutdown(0)); // Windows Ctrl+Break

  try {
    log("INFO", "文件已加载");
    await startAll();
  } catch (e) {
    log("ERROR", "启动失败", e);
  }
}
