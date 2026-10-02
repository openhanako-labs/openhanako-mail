import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import * as llm from "../backend/llm.mjs";
// 宿主模型契约（app/models.infer）：凭据、endpoint、协议全在宿主侧，本层不碰。
import { listHostModels, inferText } from "../lib/model-host.mjs";
import * as blocklist from "../backend/blocklist.mjs";
import { htmlToText } from "../backend/common.mjs";
// 后端依赖清单的判定只有一份（从 backend/package.json 推导），见 backend/deps.mjs
import { missingBackendDeps } from "../backend/deps.mjs";
// 凭据加密统一走公共模块（routes/tools/ws-monitor 共用，消除加解密不对称）
import {
  setCryptoDataDir,
  encryptSensitiveFields,
  decryptSensitiveFields,
} from "../backend/cred-crypto.mjs";
// 常驻 worker IPC：替代「每次 API 调用冷启 node 子进程跑 inbox.mjs」
import * as workerClient from "../backend/worker-client.mjs";
// v2：安装目录只读，一切运行时写入落到 App 数据目录（与子进程共用同一路径）
import { runtimeDataDir, APP_ID, legacyDataDir } from "../lib/env.mjs";
// 需要网络/外部文件/子进程的活全部转发给受管 native 服务（见 lib/runtime-host.mjs）
import { callService, isServiceReady, serviceProfile } from "../lib/runtime-host.mjs";
import { notificationStatus, sendTestNotification } from "../lib/notify-drain.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 凭证明文加密（实现已迁移至 backend/cred-crypto.mjs，此处仅保留说明） ──
// 历史实现：AES-256-GCM + scrypt(用户名 + 硬编码盐)。
// 现实现：AES-256-GCM + scrypt(用户名 + per-install 随机盐)，兼容旧格式解密。
// 加解密函数由上面 import 的 cred-crypto.mjs 提供。

// 兼容 dev 加载：如果 __dirname 指向源目录，尝试用插件上下文解析
const DEVICES = new Set(["C", "D", "E", "W"]);
function isDevSymlink(dir) {
  const root = dir.split(path.sep).slice(0, 3).join(path.sep).toUpperCase();
  return DEVICES.has(root[0]) && root.includes(".hanako\\plugins-dev");
}

// Fallback mapType（当 ESM import 失败时使用）
function _mapTypeFallback(name) {
  const n = name.toLowerCase();
  if (n.includes("inbox") || n === "收件箱") return "inbox";
  if (n.includes("sent") || n.includes("已发送")) return "sent";
  if (n.includes("draft") || n.includes("草稿")) return "drafts";
  if (n.includes("trash") || n.includes("已删除")) return "trash";
  if (n.includes("spam") || n.includes("垃圾")) return "spam";
  return "custom";
}

function _defaultFoldersFallback(accountId) {
  return [
    { id: "INBOX", accountId, name: "收件箱", path: "INBOX", type: "inbox", unreadCount: 0, totalCount: 0 },
    { id: "Sent", accountId, name: "已发送", path: "Sent", type: "sent", unreadCount: 0, totalCount: 0 },
    { id: "Drafts", accountId, name: "草稿", path: "Drafts", type: "drafts", unreadCount: 0, totalCount: 0 },
    { id: "Trash", accountId, name: "已删除", path: "Trash", type: "trash", unreadCount: 0, totalCount: 0 },
    { id: "Spam", accountId, name: "垃圾邮件", path: "Spam", type: "spam", unreadCount: 0, totalCount: 0 },
  ];
}

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const BACKEND_DIR = path.join(PLUGIN_ROOT, "backend");
// 注：v0.3.0 起图片代理不再由本进程 spawn 子进程，改由受管服务拉取（见 getImageProxy）。

// 执行后端命令：常驻 worker IPC（v0.1.3 起替代每次冷启 node 子进程）。
// 参数语义与旧 execFile 版 runInbox 完全一致（CLI 风格 args + 账号凭据 env），
// 成功 resolve 解析后的数据，失败 reject Error。
async function runInbox(args, extraEnv = {}) {
  return await workerClient.runCli(args[0], args.slice(1), extraEnv);
}

function resolveAccount(accountsList, accountId) {
  return accountsList.find(a => a.id === accountId);
}

// 检查后端依赖是否完整
// 返回 null(OK) / { error, hint }(缺失且未在安装) / { installing: true }(正在后台安装)
//
// 懒求值：模块加载时 apply() 还没跑，HANAKO_PLUGIN_DATA 未写入，此时算出的路径可能不对
// （后果只有一个锁文件位置，但没必要留这个坑）。
function installLockPath() {
  return path.join(runtimeDataDir(), ".hanako-auto-install.lock");
}

function checkBackendDeps(account) {
  if (!account) return null;

  // 清单来自 backend/deps.mjs（唯一判定，从 backend/package.json 推导）。
  // 这里以前是按账号类型分叉的两份硬编码清单，0.6.0 把 imap 换成 imapflow 时
  // 两边都没跟着改，于是“IMAP 依赖未安装”这条化石提示把 QQ 邮箱的同步整条挡住。
  //
  // 也不再按账号类型分叉：后端在模块加载时就会 import imapflow / @clawemail/node-sdk，
  // 任何一个缺失都会把整个后端带下去 —— “缺了就是全都不能用”才是诚实的说法。
  const missing = missingBackendDeps(BACKEND_DIR);
  if (!missing.length) return null;

  if (fs.existsSync(installLockPath())) return { installing: true };
  return {
    error: `后端依赖缺失：${missing.join("、")}。这些依赖随安装包发布（backend/node_modules），当前安装不完整。`,
    hint: "正式安装：重新安装本应用；开发目录：cd backend && npm install。",
  };
}

// 统一处理依赖检查结果：安装中→返回 202，缺失→返回 400，OK→返回 false
function handleDepIssue(c, depIssue) {
  if (!depIssue) return false; // 无问题
  if (depIssue.installing) {
    return c.json({ ok: false, installing: true, message: "后端依赖正在自动安装中，请稍候…" }, 202);
  }
  return c.json({ ok: false, error: depIssue.error, hint: depIssue.hint }, 400);
}

// 将 account 的 apiKey / email / IMAP 配置透传给后端子进程。
// 这样 CLAWEMAIL_API_KEY 来自 accounts.json，backend/.env 仅作兜底（子进程 loadEnv 仅在缺失时填充）。
// 个人邮箱的 IMAP 配置也通过环境变量透传。
function inboxEnvFor(account) {
  const env = {};
  if (account && account.apiKey) env.CLAWEMAIL_API_KEY = account.apiKey;
  if (account && account.email) env.CLAWEMAIL_ADDRESS = account.email;
  // 个人邮箱 IMAP 配置
  if (account && account.config) {
    if (account.config.imapHost) env.IMAP_HOST = account.config.imapHost;
    if (account.config.imapPort) env.IMAP_PORT = String(account.config.imapPort);
    if (account.config.imapUser) env.IMAP_USER = account.config.imapUser;
    if (account.config.imapPass) env.IMAP_PASS = account.config.imapPass;
    if (account.config.smtpHost) env.SMTP_HOST = account.config.smtpHost;
    if (account.config.smtpPort) env.SMTP_PORT = String(account.config.smtpPort);
    if (account.config.smtpUser) env.SMTP_USER = account.config.smtpUser;
    if (account.config.smtpPass) env.SMTP_PASS = account.config.smtpPass;
  }
  return env;
}

// ── 摘要提取 ────────────────────────────────────────────
function snippetFrom(r) {
  let text = "";
  if (r && typeof r.html === "object" && r.html && r.html.content != null) {
    text = String(r.html.content);
  } else if (typeof r === "object" && r && typeof r.html === "string") {
    text = r.html;
  }
  if (text) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<head[\s\S]*?<\/head>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/\s+/g, " ")
      .trim();
  } else if (r && typeof r.text === "string") {
    text = r.text.trim();
  } else if (r && typeof r.body === "string") {
    text = r.body.trim();
  }
  if (!text) return "";
  const cap = 180;
  return text.length > cap ? text.slice(0, cap).replace(/\s+\S*$/, "") + "…" : text;
}

function mergeSnippets(messages, previousCache) {
  if (!Array.isArray(messages)) return messages;
  const byId = {};
  if (Array.isArray(previousCache)) previousCache.forEach(m => { if (m && m.id && m.snippet) byId[m.id] = m.snippet; });
  messages.forEach(m => {
    if (!m || !m.id) return;
    if (byId[m.id]) m.snippet = byId[m.id];
  });
  return messages;
}

async function batchFetchSnippets(account, messages, topN = 12) {
  const need = messages.filter(m => m && m.id && !m.snippet).slice(0, topN);
  if (!need.length) return messages;
  const out = await Promise.all(need.map(async (m) => {
    try {
      const r = await runInbox(["read", account.email, m.id], inboxEnvFor(account));
      return snippetFrom(r);
    } catch (e) {
      return "";
    }
  }));
  need.forEach((m, i) => { m.snippet = out[i]; });
  return messages;
}
// 邮件里的外网图片代理（解决沙箱 iframe 无法访问外网的问题）。
// 安全约束：仅允许 http/https；屏蔽私有/回环地址防 SSRF；校验 Content-Type 为 image/*。
// 拉取交给受管服务：AppHost 及其子进程都在 Node 权限模型里，**发不出任何网络请求**，
// 而受管 native 服务不允许再 spawn —— 所以代理改为服务内直连（runtime/service.mjs），
// SSRF 加固（仅 http/https、屏蔽私网/回环、DNS 重绑校验、限大小/跳转/类型）也在那边。
const getImageProxy = async (c) => {
  const url = c.req.query("url") || "";
  if (!url) return c.json({ ok: false, error: "url is required" }, 400);
  let parsed;
  try { parsed = new URL(url); }
  catch { return c.json({ ok: false, error: "invalid url" }, 400); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return c.json({ ok: false, error: "only http/https allowed" }, 400);
  }
  const host = parsed.hostname.toLowerCase();
  const blocked = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|::1|fc[0-9a-f]{2}:)/i;
  if (blocked.test(host)) {
    return c.json({ ok: false, error: "blocked host (private/loopback)" }, 403);
  }
  try {
    const out = await callService("/proxy", { url });
    if (!out?.ok) return c.json({ ok: false, error: out?.error || "fetch failed" }, 502);
    const buf = Buffer.from(out.base64, "base64");
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": out.ct,
        "Content-Length": String(buf.length),
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (e) {
    return c.json({ ok: false, error: String(e.message || e) }, 502);
  }
};

/**
 * 一次 AI 调用：提示词 + 用户选中的模型 → 宿主契约 ctx.models。
 *
 * 只认 provider / model 两个字段：它们来自 /llm-detect，而那份列表已经按宿主的
 * 标识符规则过滤过（中文、空格、斜杠的名字进不去），所以这里不必再校验一遍。
 *
 * 没有「猜一个默认供应商」这种回落。宁可让用户去点一下选择器，
 * 也不要静默换个模型跑出来一段看不出问题的总结 —— 那种失败最难查。
 */
async function runAi(prompt, llmCfg, body = {}) {
  const provider = String(llmCfg?.providerId || llmCfg?.provider || body?.providerId || "").trim();
  const model = String(llmCfg?.model || body?.model || "").trim();
  if (!provider || !model) {
    return { ok: false, error: "还没选模型：请在「AI 设置」里选一个供应商与模型（列表来自宿主模型目录）" };
  }
  const r = await inferText({
    provider,
    model,
    messages: [{ role: "user", content: prompt.user }],
    systemPrompt: prompt.system || undefined,
    maxTokens: prompt.maxTokens,
    temperature: prompt.temperature,
    timeoutMs: 120_000,
  });
  if (!r.ok) {
    return { ok: false, error: `${provider} / ${model}：${r.error}`, timedOut: !!r.timedOut };
  }
  // gate 带回去：同一个模型走哪条路，用户应该看得见（直连时凭据确实经过了本 App）。
  return { ok: true, text: r.text, usage: r.usage, requestId: r.requestId, via: r.gate || r.via || "contract" };
}

// 从邮件对象抽取发件人邮箱（兼容 from 为字符串 / 数组 / {address} 对象）
function senderOf(msg) {
  const f = msg && msg.from;
  if (!f) return "";
  if (typeof f === "string") {
    const m = f.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    return m ? m[0].toLowerCase() : f.toLowerCase();
  }
  if (Array.isArray(f)) {
    const first = f[0];
    if (typeof first === "string") return senderOf({ from: first });
    if (first && typeof first === "object" && first.address) return String(first.address).toLowerCase();
  }
  if (typeof f === "object" && f.address) return String(f.address).toLowerCase();
  return "";
}

export default function (app, ctx) {
  const dataDir = path.join(ctx.dataDir, ctx.pluginId);
  // 凭据加密数据目录与 accounts.json 对齐（routes/tools/ws-monitor 同一路径）
  setCryptoDataDir(dataDir);
  const cacheDir = path.join(dataDir, "cache");

  // ── accounts.json 路径解析 ─────────────────────────────────
  // v1 的写法是 path.join(ctx.dataDir, ctx.pluginId)，能跑通全靠 legacyCtx 把
  // dataDir 报成「父目录」做反向偏移。但那个投影只在 registerRoutes 真的把 lctx
  // 传进来时成立；传错一个是静默的多套一层目录 —— accounts.json 读不到，
  // 卡片就显示「暂无账号」，而账号其实一直在，后端也正常收信。
  //
  // 按候选顺序取第一个真实存在 accounts.json 的目录，**读和写用同一个**，
  // 并在日志里写清命中哪一个。都不存在时落回 v1 约定路径（首次添加会写到那里）。
  // 候选是去重后的列表：v2 的 ctx.dataDir 已含 App id，拼上 pluginId 会重复。
  const _acctCandidates = [dataDir, ctx.dataDir, runtimeDataDir(), path.join(runtimeDataDir(), APP_ID), legacyDataDir()];
  const _acctSeen = new Set();
  let _accountsDir = dataDir;
  for (const d of _acctCandidates) {
    if (!d || _acctSeen.has(d)) continue;
    _acctSeen.add(d);
    if (fs.existsSync(path.join(d, "accounts.json"))) {
      _accountsDir = d;
      break;
    }
  }
  const _accountsFile = path.join(_accountsDir, "accounts.json");
  if (_accountsDir !== dataDir) {
    ctx.log && ctx.log.warn("accounts.json 不在 v1 约定路径上，已改用实际命中的目录",
      { tried: dataDir, resolved: _accountsDir, file: _accountsFile });
  }
  // v2：卡片界面是 ui/ 下的静态文档（由宿主持有本 App 的 ui/ 路由），
  // 不再由这里读模板注入 pluginId —— 页面自己从 location 推导 appId。

  function ensureDir() {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, "utf-8")); }
    catch { return fallback; }
  }

  function writeJson(file, data) {
    ensureDir();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
  }

  function readWsCache(accountId) {
    const files = [];
    try {
      const entries = fs.readdirSync(cacheDir);
      const prefix = `ws-${accountId}-`;
      for (const f of entries) {
        if (f.startsWith(prefix) && f.endsWith(".json")) {
          try {
            const content = JSON.parse(fs.readFileSync(path.join(cacheDir, f), "utf-8"));
            files.push({
              ...content,
              id: content.mailId || content.id || f,
            });
          } catch {}
        }
      }
    } catch {}
    return files;
  }

  function accounts() {
    const raw = readJson(_accountsFile, []);
    return Array.isArray(raw) ? raw.map(decryptSensitiveFields) : [];
  }

  function saveAccounts(list) {
    const encrypted = list.map(encryptSensitiveFields);
    try { fs.mkdirSync(_accountsDir, { recursive: true }); } catch { /* 已存在 */ }
    writeJson(_accountsFile, encrypted);
  }

  const getAccounts = (c) => c.json({ ok: true, data: accounts() });
  const postAccounts = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const list = accounts();
    if (body.action === "create" && body.name && body.email) {
      const account = {
        id: Date.now().toString(),
        name: body.name,
        email: body.email,
        provider: body.provider || "imap",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (body.apiKey) account.apiKey = body.apiKey;
      if (body.config && typeof body.config === "object") account.config = body.config;
      list.push(account);
      saveAccounts(list);
      return c.json({ ok: true, data: list });
    }
    if (body.action === "update" && body.id) {
      const idx = list.findIndex((a) => a.id === body.id);
      if (idx < 0) return c.json({ ok: false, error: "account not found" }, 404);
      const account = list[idx];
      const updated = { ...account, updatedAt: Date.now() };
      if (typeof body.name === "string" && body.name) updated.name = body.name;
      if (typeof body.email === "string" && body.email) updated.email = body.email;
      if (typeof body.provider === "string" && body.provider) updated.provider = body.provider;
      // 凭据仅在显式提供非空值时才更新；空值 / 未提供 = 保留原值（前端不回显密码）
      if (body.apiKey !== undefined && String(body.apiKey).trim()) {
        updated.apiKey = String(body.apiKey).trim();
      }
      if (body.config && typeof body.config === "object") {
        updated.config = { ...(updated.config || {}), ...body.config };
        // 显式传空字符串的密码字段 = 清除该字段
        for (const k of ["imapPass", "smtpPass"]) {
          if (body.config[k] === "") delete updated.config[k];
        }
      }
      list[idx] = updated;
      saveAccounts(list);
      return c.json({ ok: true, data: list });
    }
    if (body.action === "delete" && body.id) {
      const next = list.filter((a) => a.id !== body.id);
      saveAccounts(next);
      return c.json({ ok: true, data: next });
    }
    return c.json({ ok: false, error: "invalid action" }, 400);
  };

  const getFolders = (c) => {
    const accountId = c.req.query("accountId") || "";
    const cache = readJson(path.join(cacheDir, `folders-${accountId}.json`), []);
    return c.json({ ok: true, data: cache });
  };

  const getMessages = (c) => {
    const accountId = c.req.query("accountId") || "";
    const folderId = c.req.query("folderId") || "INBOX";
    const cache = readJson(path.join(cacheDir, `messages-${accountId}-${folderId}.json`), []);
    return c.json({ ok: true, data: cache });
  };

  const getMessageById = async (c) => {
    const accountId = c.req.query("accountId") || "";
    const messageId = c.req.param("messageId");

    if (!accountId) return c.json({ ok: false, error: "accountId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    try {
      const folder = c.req.query("folder") || "INBOX";
      const result = await runInbox(["read", account.email, messageId, `--folder=${folder}`], inboxEnvFor(account));
      if (result.error) return c.json({ ok: false, error: result.error });
      return c.json({ ok: true, data: result });
    } catch (e) {
      try { fs.appendFileSync(path.join(dataDir, "debug-read.log"), `[${new Date().toISOString()}] read fail id=${messageId} :: ${e.stack || e.message}\n`); } catch {}
      return c.json({ ok: false, error: String(e.message || e) });
    }
  };

  const deleteMessage = async (c) => {
    const accountId = c.req.query("accountId") || "";
    const messageId = c.req.param("messageId");

    if (!accountId) return c.json({ ok: false, error: "accountId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    try {
      // 传入来源文件夹，使后端两步删除（INBOX→垃圾箱，垃圾箱内→永久删）按正确分支执行
      const folder = c.req.query("folder") || "INBOX";
      const result = await runInbox(["delete", account.email, messageId, `--folder=${folder}`], inboxEnvFor(account));
      if (result.error) return c.json({ ok: false, error: result.error });

      // 从本地缓存移除已删邮件，使前端列表在下次加载时立即反映删除结果
      try {
        if (fs.existsSync(cacheDir)) {
          const files = fs.readdirSync(cacheDir).filter(f => f.startsWith("messages-") && f.endsWith(".json"));
          for (const f of files) {
            const fp = path.join(cacheDir, f);
            try {
              const arr = JSON.parse(fs.readFileSync(fp, "utf-8"));
              if (Array.isArray(arr)) {
                const filtered = arr.filter(m => String(m.id) !== String(messageId));
                if (filtered.length !== arr.length) {
                  fs.writeFileSync(fp, JSON.stringify(filtered, null, 2));
                }
              }
            } catch {}
          }
        }
      } catch (cacheErr) {
        console.warn("delete cache cleanup skipped:", cacheErr.message);
      }

      return c.json({ ok: true, data: result });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) });
    }
  };

  const postSync = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const accountId = body?.accountId || "";
    const folder = body?.folder || "INBOX";
    ctx.log?.info?.("mail_sync", { accountId, folder });

    if (!accountId) return c.json({ ok: false, error: "accountId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

  const depIssue = checkBackendDeps(account);
  if (depIssue) return c.json({ ok: false, error: depIssue.error, hint: depIssue.hint }, 400);

  try {
    let folders = [];
      try {
        const foldersRaw = await runInbox(["folders", account.email], inboxEnvFor(account));
        folders = (Array.isArray(foldersRaw) ? foldersRaw : []).map(f => ({
          id: String(f.id ?? f.name ?? ""),
          accountId,
          name: f.name ?? f.id ?? "",
          path: String(f.id ?? f.name ?? ""),
          type: _mapTypeFallback(String(f.name ?? f.id ?? "")),
          unreadCount: Number(f.unread ?? 0),
          totalCount: Number(f.unread ?? 0),
        }));
      } catch (e) {
        ctx.log?.warn?.("mail_sync.folders_fallback", { error: e.message });
        folders = _defaultFoldersFallback(accountId);
      }

      const messagesRaw = await runInbox(["list", account.email, `--fid=${folder}`, "--limit=50"], inboxEnvFor(account));
      let messages = Array.isArray(messagesRaw) ? messagesRaw : [];

      // 合并 WebSocket 实时缓存（ClawEmail 账号）
      if (account.email.endsWith("@claw.163.com")) {
        const wsMails = readWsCache(accountId);
        if (wsMails.length) {
          const byId = new Map(messages.map(m => [m.id, m]));
          for (const m of wsMails) {
            if (!byId.has(m.id)) {
              byId.set(m.id, m);
            }
          }
          messages = Array.from(byId.values()).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        }
      }

      // 垃圾邮件自动过滤（6.3）：仅对收件箱执行，把黑名单发件人的邮件移入垃圾箱
      if (folder === "INBOX") {
        try {
          const f = await runInbox(["filter-spam", account.email, `--fid=${folder}`], inboxEnvFor(account));
          if (f && f.ok && Array.isArray(f.movedIds) && f.movedIds.length) {
            const movedSet = new Set(f.movedIds);
            messages = messages.filter((m) => !movedSet.has(String(m.id)));
            ctx.log?.info?.("mail_sync.spam_auto_filtered", { count: f.movedIds.length });
          }
        } catch (e) {
          ctx.log?.warn?.("mail_sync.spam_filter_failed", { error: e.message });
        }
      }

      // 摘要：复用上次缓存的，并行补抓前 N 条未缓存的
      const previousCache = readJson(path.join(cacheDir, `messages-${accountId}-${folder}.json`), []);
      mergeSnippets(messages, previousCache);
      await batchFetchSnippets(account, messages, 12);

      ensureDir();
      writeJson(path.join(cacheDir, `folders-${accountId}.json`), folders);
      writeJson(path.join(cacheDir, `messages-${accountId}-${folder}.json`), messages);

      return c.json({ ok: true, data: { folders, messages } });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    }
  };

  // 把结构化发送参数（含 cc/bcc/附件）写入临时 JSON 文件，供 inbox.mjs 以 --json= 读取，
  // 避免 CLI 参数无法表达数组/二进制附件的问题。
  function writeInboxOptions(obj) {
    const dir = path.join(BACKEND_DIR, "data", "_tmp");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `opts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(file, JSON.stringify(obj), "utf-8");
    return file;
  }
  function safeUnlink(p) {
    try { if (p) fs.unlinkSync(p); } catch {}
  }

  const postSend = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { accountId, to, subject, body: text, messageId, cc, bcc, attachments } = body;
    if (!accountId) return c.json({ ok: false, error: "accountId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;

    const optsFile = writeInboxOptions({ to, subject, body: text, cc, bcc, attachments });
    try {
      let result;
      if (messageId) {
        result = await runInbox(["reply", account.email, messageId, `--json=${optsFile}`], inboxEnvFor(account));
      } else {
        result = await runInbox(["send", account.email, `--json=${optsFile}`], inboxEnvFor(account));
      }
      if (result.error) return c.json({ ok: false, error: result.error });
      return c.json({ ok: true, data: result });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    } finally {
      safeUnlink(optsFile);
    }
  };

  const postForward = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { accountId, to, subject, body: text, messageId, cc, bcc, attachments } = body;
    if (!accountId) return c.json({ ok: false, error: "accountId is required" });
    if (!messageId) return c.json({ ok: false, error: "messageId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;

    const optsFile = writeInboxOptions({ to, subject, body: text, cc, bcc, attachments });
    try {
      const result = await runInbox(["forward", account.email, messageId, `--json=${optsFile}`], inboxEnvFor(account));
      if (result.error) return c.json({ ok: false, error: result.error });
      return c.json({ ok: true, data: result });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    } finally {
      safeUnlink(optsFile);
    }
  };

  // 从邮件对象抽取纯文本（用于 LLM 处理）
  function plainOf(m) {
    if (!m) return "";
    if (typeof m.text === "string" && m.text.trim()) return m.text;
    if (typeof m.body === "string" && m.body.trim()) return m.body;
    if (typeof m.snippet === "string" && m.snippet.trim()) return m.snippet;
    if (typeof m.textBody === "string" && m.textBody.trim()) return m.textBody;
    // HTML-only 邮件兜底：从 html/textContent 提取可读文本
    const htmlSrc = m.html || m.textContent || "";
    if (htmlSrc) return htmlToText(htmlSrc);
    return "";
  }

  // 读取单封邮件正文（供总结/翻译复用）
  const readMailPlain = async (account, messageId) => {
    const result = await runInbox(["read", account.email, messageId], inboxEnvFor(account));
    if (result.error) throw new Error(result.error);
    const text = plainOf(result);
    if (!text) throw new Error("该邮件没有可处理的纯文本内容（或为纯图片邮件）");
    return text;
  };

  const postSummarize = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const accountId = body?.accountId || "";
    const messageId = body?.messageId || "";
    const targetLang = body?.targetLang || "中文";
    const llmCfg = body?.llmConfig || null; // 只包含 { provider, model } 引用，不带凭据
    if (!accountId || !messageId) return c.json({ ok: false, error: "accountId 和 messageId 必填" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;

    try {
      const text = await readMailPlain(account, messageId);
      const r = await runAi(llm.summarizePrompt(text, targetLang), llmCfg, body);
      return r.ok
        ? c.json({ ok: true, data: r.text, usage: r.usage, via: r.via })
        : c.json({ ok: false, error: r.error, timedOut: r.timedOut });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) });
    }
  };

  const postTranslate = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const accountId = body?.accountId || "";
    const messageId = body?.messageId || "";
    const targetLang = body?.targetLang || "中文";
    const llmCfg = body?.llmConfig || null;
    if (!accountId || !messageId) return c.json({ ok: false, error: "accountId 和 messageId 必填" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;

    try {
      const text = await readMailPlain(account, messageId);
      const r = await runAi(llm.translatePrompt(text, targetLang), llmCfg, body);
      return r.ok
        ? c.json({ ok: true, data: r.text, usage: r.usage, via: r.via })
        : c.json({ ok: false, error: r.error, timedOut: r.timedOut });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) });
    }
  };

  const postMarkRead = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const accountId = body?.accountId || "";
    const messageId = body?.messageId || "";
    const folder = body?.folder || "INBOX";
    const wantRead = body?.read !== false; // 默认 true（标已读），false = 标未读
    if (!accountId || !messageId) return c.json({ ok: false, error: "accountId/messageId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;

    // 始终更新本地缓存（保证 UI 视觉一致）
    function updateLocalRead(readState) {
      try {
        const cacheFile = path.join(cacheDir, `messages-${accountId}-${folder}.json`);
        const msgs = readJson(cacheFile, null);
        if (Array.isArray(msgs)) {
          const target = msgs.find(m => m.id === messageId);
          if (target) { target.read = !!readState; writeJson(cacheFile, msgs); }
        }
      } catch {}
    }

    try {
      // 标未读：部分后端不支持，直接本地标记
      if (!wantRead) {
        updateLocalRead(false);
        return c.json({ ok: true, data: { fallback: true, reason: "mark-unread-local" } });
      }
      const result = await runInbox(["mark-read", account.email, messageId, `--folder=${folder}`], inboxEnvFor(account));
      if (result && result.error) {
        updateLocalRead(true);
        return c.json({ ok: true, data: { fallback: true, reason: String(result.error).slice(0, 200) } });
      }
      updateLocalRead(true);
      return c.json({ ok: true, data: result });
    } catch (e) {
      try { fs.appendFileSync(path.join(dataDir, "debug-markread.log"), `[${new Date().toISOString()}] mark-read ${messageId} :: ${e.stack || e.message}\n`); } catch {}
      updateLocalRead(wantRead);
      return c.json({ ok: true, data: { fallback: true, reason: String(e.message || e).slice(0, 200) } });
    }
  };

  const postMarkSpam = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const accountId = body?.accountId || "";
    const messageId = body?.messageId || "";
    const folder = body?.folder || "INBOX";
    if (!accountId || !messageId) return c.json({ ok: false, error: "accountId/messageId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;

    try {
      // 先从缓存取出该邮件的发件人，用于联动黑名单
      let senderEmail = "";
      try {
        const fp = path.join(cacheDir, `messages-${accountId}-${folder}.json`);
        const arr = readJson(fp, null);
        if (Array.isArray(arr)) {
          const hit = arr.find(m => String(m.id) === String(messageId));
          if (hit) senderEmail = senderOf(hit);
        }
      } catch {}

      const result = await runInbox(["spam", account.email, messageId], inboxEnvFor(account));
      if (result && result.error) return c.json({ ok: false, error: result.error });

      // 从原文件夹缓存移除（已移到垃圾箱，列表不应再显示）
      try {
        const fp = path.join(cacheDir, `messages-${accountId}-${folder}.json`);
        const arr = readJson(fp, null);
        if (Array.isArray(arr)) {
          const filtered = arr.filter(m => String(m.id) !== String(messageId));
          if (filtered.length !== arr.length) writeJson(fp, filtered);
        }
      } catch {}

      // 联动：标记为垃圾 → 把发件人写入黑名单（6.4），下次同步自动拦截
      let blacklisted = false;
      if (senderEmail) {
        try { blocklist.addToBlacklist(senderEmail); blacklisted = true; } catch {}
      }

      return c.json({ ok: true, data: result, blacklisted, senderEmail });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) });
    }
  };

  const getBlocklist = async (c) => {
    return c.json({ ok: true, data: blocklist.getBlocklist() });
  };

  // 批量删除（v0.1.5）：单次 IPC 处理多封，单封失败不中断
  const postBulkDelete = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const accountId = body?.accountId || "";
    const ids = Array.isArray(body?.ids) ? body.ids.map((x) => String(x)) : [];
    const folder = body?.folder || "INBOX";
    if (!accountId) return c.json({ ok: false, error: "accountId is required" });
    if (!ids.length) return c.json({ ok: false, error: "ids is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });
    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;
    const optsFile = writeInboxOptions({ ids, folder });
    try {
      const result = await runInbox(["bulk-delete", account.email, `--json=${optsFile}`], inboxEnvFor(account));
      if (result && result.error) return c.json({ ok: false, error: result.error });
      // 同步从本地缓存移除已删邮件
      try {
        const cacheFile = path.join(cacheDir, `messages-${accountId}-${folder}.json`);
        const arr = readJson(cacheFile, null);
        if (Array.isArray(arr)) {
          const rm = new Set((result?.deleted || []).map(String));
          const filtered = arr.filter((m) => !rm.has(String(m.id)));
          if (filtered.length !== arr.length) writeJson(cacheFile, filtered);
        }
      } catch {}
      return c.json({ ok: true, data: result });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) });
    } finally {
      safeUnlink(optsFile);
    }
  };

  // 保存草稿（v0.1.5）：仅 IMAP 后端支持（append 到 DRAFTS）
  const postDraft = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { accountId, to, cc, bcc, subject, body: text } = body;
    if (!accountId) return c.json({ ok: false, error: "accountId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });
    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;
    const optsFile = writeInboxOptions({ to, cc, bcc, subject, body: text });
    try {
      const result = await runInbox(["save-draft", account.email, `--json=${optsFile}`], inboxEnvFor(account));
      if (result && result.error) return c.json({ ok: false, error: result.error });
      return c.json({ ok: true, data: result });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) });
    } finally {
      safeUnlink(optsFile);
    }
  };

  const postBlocklist = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const type = body?.type === "white" ? "white" : "black";
    const email = (body?.email || "").trim();
    const action = body?.action === "remove" ? "remove" : "add";
    if (!email) return c.json({ ok: false, error: "email is required" });
    let data;
    if (type === "white") {
      data = action === "remove" ? blocklist.removeFromWhitelist(email) : blocklist.addToWhitelist(email);
    } else {
      data = action === "remove" ? blocklist.removeFromBlacklist(email) : blocklist.addToBlacklist(email);
    }
    return c.json({ ok: true, data });
  };

  const getSearch = async (c) => {
    const accountId = c.req.query("accountId") || "";
    const q = (c.req.query("q") || "").trim();
    if (!accountId || !q) return c.json({ ok: false, error: "accountId/q is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });
    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;
    try {
      const result = await runInbox(["search", account.email, q], inboxEnvFor(account));
      if (result && result.error) return c.json({ ok: false, error: result.error });
      const list = Array.isArray(result) ? result : [];
      // 也补一下摘要，便于结果卡复用
      mergeSnippets(list, list);
      await batchFetchSnippets(account, list, 8);
      return c.json({ ok: true, data: list });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) });
    }
  };

  const getAttachment = async (c) => {
    const accountId = c.req.query("accountId") || "";
    const messageId = c.req.param("messageId");
    const partId = c.req.param("partId");
    const asDownload = c.req.query("download") === "1";
    const folder = c.req.query("folder") || "INBOX";
    if (!accountId || !messageId || !partId) {
      return c.json({ ok: false, error: "accountId/messageId/partId is required" }, 400);
    }
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" }, 404);
    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;
    try {
      const r = await runInbox(["attachment", account.email, messageId, partId, `--folder=${folder}`], inboxEnvFor(account));
      if (r && r.error) return c.json({ ok: false, error: String(r.error) }, 400);
      if (!r || !r.base64) return c.json({ ok: false, error: "attachment not found" }, 404);
      const buf = Buffer.from(r.base64, "base64");
      const rawName = r.filename || `attachment_${partId}`;
      const safeName = rawName.replace(/["\\]/g, "");
      const encodedName = encodeURIComponent(rawName);
      const disposition = (asDownload ? "attachment" : "inline") +
        `; filename="${safeName}"; filename*=UTF-8''${encodedName}`;
      return new Response(buf, {
        status: 200,
        headers: {
          "Content-Type": r.contentType || "application/octet-stream",
          "Content-Disposition": disposition,
          "Content-Length": String(buf.length),
          "Cache-Control": "private, max-age=300",
        },
      });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) }, 500);
    }
  };

  // ── LLM：模型列表与连接自检 ─────────────────────────────
  //
  // 只有一个数据源：宿主契约 ctx.models（能力位 app/models.infer）。
  // 这一段以前是「读 provider-catalog.json + bus provider:credentials +
  // PROVIDER_PRESETS 猜 Base URL + 借受管服务代发 HTTP」，v0.6.13 整块删除。
  // 凭据、endpoint、API 协议、用量记账都在宿主侧，本层拿不到 key —— 这是设计，不是缺能。

  const postLlmDetect = async (c) => {
    const r = await listHostModels();

    if (!r.ok) {
      // 未授权 / 宿主版本不支持 / list 抛了 —— 把原话递出去。
      // 不再翻译成「你去加个供应商」：那句会把人引去改一个本来就对的地方。
      return c.json({
        ok: true,
        data: [],
        source: "host-contract",
        error: r.error || "",
        hint: `未检测到可用模型：${r.error || "宿主模型目录不可用"}`,
      });
    }

    const data = r.models.map((m) => ({
      id: `host:${m.provider}:${m.id}`,
      name: m.name || m.id,
      provider: m.provider,
      model: m.id,
      reasoning: !!m.reasoning,
      // 只是个标记，不是门禁：名字不合宿主旧规则的一律照列、照能选。
      hostIdOk: m.hostIdOk !== false,
      fromHost: true,
      configured: true,
      note: `来源: 宿主模型目录「${m.provider}」`,
      needsKey: false,
      needsBaseUrl: false,
    }));

    // 空结果要说清是哪一层空：未授权 / 目录为空 / 条目读不出名字，三种修法不同。
    let hint = "";
    if (!data.length) {
      hint = r.total
        ? `宿主返回了 ${r.total} 个条目，但本层没能从里面读出 provider 与模型名`
        : "宿主模型目录为空：请先在 Hana 设置 → 模型 里添加供应商与聊天模型";
    } else if (r.suspect) {
      // 不删、不藏，也不再标成「可能不收」—— 它们只是走另一扇门。
      hint = `其中 ${r.suspect} 个由宿主模型目录以外的通路提供（provider 名含中文、空格或斜杠，` +
        `宿主契约不收，但 bus 能取到凭据）——走的是直连，凭据只在服务端流转`;
    }

    return c.json({
      ok: true, data, source: "host-contract+bus",
      total: r.total, fromContract: r.fromContract, fromBus: r.fromBus,
      suspect: r.suspect, hint,
    });
  };

  // 连接自检：让选中的模型回一个固定短词。
  // 这一步是唯一能证明「模型真的跑得通」的东西 —— 列表拿到不等于能推理。
  const postLlmTest = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const r = await runAi(llm.pingPrompt(), body?.llmConfig || null, body);
    if (!r.ok) return c.json({ ok: false, error: r.error, timedOut: r.timedOut });
    return c.json({ ok: true, data: { reply: r.text, usage: r.usage, requestId: r.requestId } });
  };

  // 这一整块是路由注册表。它差点在 v0.6.13 被连带删掉 —— 当时用注释标题做定界
  // 去替换 LLM 区，而「依赖安装状态查询」这个标题在文件里不止一处，切点取到了更早
  // 的那一个，20 条注册语句一起没了。handler 定义还在、路由没了 —— 表现是卡片每个
  // 面板都报 404，而 node --check 完全正常。恢复取自原仓库 main 分支的同一块。
  app.get("/accounts", getAccounts);
  app.post("/accounts", postAccounts);
  app.get("/folders", getFolders);
  app.get("/messages", getMessages);
  app.get("/messages/:messageId", getMessageById);
  app.delete("/messages/:messageId", deleteMessage);
  app.post("/sync", postSync);
  app.post("/send", postSend);
  app.post("/forward", postForward);
  app.post("/summarize", postSummarize);
  app.post("/translate", postTranslate);
  app.post("/mark-read", postMarkRead);
  app.post("/mark-spam", postMarkSpam);
  app.post("/bulk-delete", postBulkDelete);
  app.post("/draft", postDraft);
  app.get("/blocklist", getBlocklist);
  app.post("/blocklist", postBlocklist);
  app.get("/search", getSearch);
  app.get("/attachments/:messageId/:partId", getAttachment);
  app.get("/image-proxy", getImageProxy);

  // ── 依赖安装状态查询（前端轮询用）──
  app.get("/deps-status", (c) => {
    const installing = fs.existsSync(installLockPath());
    // 与 checkBackendDeps 用同一份判定（以前这里又是一份硬编码清单，会各自腐烂）
    const missing = missingBackendDeps(BACKEND_DIR);
    return c.json({ ok: true, installing, missing, ready: missing.length === 0 && !installing });
  });

  // ── 桌面通知 ──
  // 拉起 .NET / node-notifier 助手要子进程，而 AppHost 的子进程没有网络也读不到
  // 安装目录外的文件，所以交给受管服务去发（它保留原链路）。
  const postNotify = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const res = await callService("/notify", {
      subject: body.subject || "(无主题)",
      sender: body.sender || "",
      messageId: body.messageId || "",
      accountId: body.accountId || "",
      // 这封邮件被发现时所在的文件夹；卡片轮询的是用户正在看的 folder，不恒为 INBOX。
      folder: body.folder || "INBOX",
    });
    return c.json({ ok: res?.ok !== false, method: "native", error: res?.ok === false ? res.error : undefined });
  };

  // ── AgentQQ 设备码授权（转发给受管服务：设备流程要发 HTTPS，AppHost 无网）──
  // 令牌不经这条路径：服务拿到后直接写进加密的 accounts.json。
  app.post("/agentqq/login/start", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const r = await callService("/agentqq/login/start", { name: body.name || "" });
    return c.json(r?.ok ? { ok: true, ...r.data } : { ok: false, error: r?.error || "启动授权失败" });
  });

  app.post("/agentqq/login/status", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const r = await callService("/agentqq/login/status", { sessionId: body.sessionId || "" });
    return c.json(r?.ok ? { ok: true, ...r.data } : { ok: false, error: r?.error || "查询授权状态失败" });
  });

  // 点击回跳文件与 toast 助手同目录（app-data）。
  //
  // 原来读的是 os.tmpdir()/hanako-mail-click.json，而写它的是 mail-toast.cjs ——
  // 那个进程在权限模型里、写不进 Temp，所以这条回跳链从未真正落地过。现在两侧对齐。
  const CLICK_FILE = path.join(dataDir, "notify-click.json");

  const getClicksLatest = (c) => {
    const clickFile = CLICK_FILE;
    try {
      if (!fs.existsSync(clickFile)) return c.json({ ok: true, data: null });
      const raw = fs.readFileSync(clickFile, "utf-8");
      // Try parsing as JSON object with or without wrapping
      let data;
      try { data = JSON.parse(raw); } catch {
        // Might be key=value format from batch file; try to extract
        const m = raw.match(/\{.*\}/);
        if (m) data = JSON.parse(m[0]);
        else return c.json({ ok: true, data: null });
      }
      // Clear after read
      fs.unlinkSync(clickFile);
      return c.json({ ok: true, data });
    } catch {
      return c.json({ ok: true, data: null });
    }
  };

  // ── 通知链路的观测与自检 ──
  //
  // 补的是「失败只存在于日志里」这个缺口：原先一条通知没弹出来，用户侧完全不可见 ——
  // 实测两次失败就那样躺了两天，没人发现。
  const getNotifyStatus = async (c) => {
    const local = notificationStatus();
    const q = await callService("/pending-notify", { limit: 0 });
    return c.json({
      ok: true,
      data: {
        ...local,
        queueDepth: typeof q?.depth === "number" ? q.depth : null,
        serviceReady: isServiceReady(),
        // native 沙箱建不起来时服务会降级到 local-machine，
        // 这件事用户应该看得见，而不是只在日志里。
        serviceProfile: serviceProfile(),
      },
    });
  };

  const postNotifyTest = async (c) => {
    const r = await sendTestNotification(console);
    return c.json({ ok: true, data: r });
  };

  app.post("/notify", postNotify);
  app.get("/clicks/latest", getClicksLatest);
  app.get("/notify-status", getNotifyStatus);
  app.post("/notify-test", postNotifyTest);
  app.post("/llm-detect", postLlmDetect);
  app.post("/llm-test", postLlmTest);

  // ── 后台轮询新邮件 ──────────────────────────────────
  const POLL_INTERVAL_MS = 60 * 1000; // 60 秒（v0.1.6：原 5 分钟，提升新邮件感知速度）
  const POLL_FETCH_LIMIT = 5;         // 对比最近 N 封，避免漏掉中间到达的多封
  const LAST_IDS_PATH = path.join(dataDir, "_poll_last_ids.json");

  function readLastIds() {
    try { return JSON.parse(fs.readFileSync(LAST_IDS_PATH, "utf-8")); } catch { return {}; }
  }
  function writeLastIds(obj) {
    ensureDir();
    fs.writeFileSync(LAST_IDS_PATH, JSON.stringify(obj), "utf-8");
  }

  async function pollAccounts() {
    const list = accounts();
    if (!list.length) return;
    const lastIds = readLastIds();
    let changed = false;

    for (const account of list) {
      try {
        const result = await runInbox(["list", account.email, "--fid=INBOX", `--limit=${POLL_FETCH_LIMIT}`], inboxEnvFor(account));
        const messages = Array.isArray(result) ? result : [];
        if (!messages.length) continue;
        const key = `${account.id}:INBOX`;
        const prev = lastIds[key];
        const known = Array.isArray(prev) ? prev : (prev ? [prev] : []);
        const currentIds = messages.map((m) => String(m.id));
        const fresh = currentIds.filter((id) => !known.includes(id));

        if (fresh.length) {
          // 新邮件 → 写缓存（前端列表刷新即可见，解决「刷新也没用」）
          // 注意：桌面通知由 ws-monitor（ClawEmail）/ imap-idle（IMAP）实时路径负责，
          // 这里不再弹通知，避免与实时路径重复（v0.1.18）。
          try {
            const cacheFile = path.join(cacheDir, `messages-${account.id}-INBOX.json`);
            const cached = readJson(cacheFile, []);
            const byId = new Map((Array.isArray(cached) ? cached : []).map((m) => [String(m.id), m]));
            for (const m of messages) byId.set(String(m.id), m);
            const merged = Array.from(byId.values()).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
            writeJson(cacheFile, merged.slice(0, 50));
          } catch {}
        }

        lastIds[key] = currentIds.slice(0, POLL_FETCH_LIMIT);
        changed = true;
      } catch (e) {
        // 单账号轮询失败不影响其他账号
        console.warn(`hanako-mail poll fail: ${account.email}: ${e.message}`);
      }
    }

    if (changed) writeLastIds(lastIds);
  }

  // 启动轮询
  const pollTimer = setInterval(pollAccounts, POLL_INTERVAL_MS);
  // 首次加载时检查一次（延迟 30 秒，避免阻塞启动）
  setTimeout(pollAccounts, 30 * 1000);

  // ── 后台自动同步（用户需求：自动同步，而非仅手动） ──
  // 6 分钟（原来 3 分钟）。这一轮要发两次请求：list --limit=50 与 filter-spam（内部再拉一批），
  // 改 6 分钟后从 20 轮/小时降到 10 轮。
  // 不必担心新邮件延迟：60 秒轮询（pollAccounts）负责“有新邮件就让它可见”，
  // 这里负责的是“定期把缓存对齐服务器 + 跑黑名单”。
  const AUTO_SYNC_INTERVAL_MS = 6 * 60 * 1000; // 6 分钟
  let autoSyncRunning = false;
  async function autoSyncAccounts() {
    if (autoSyncRunning) return; // 防止与手动同步或上一轮重叠
    autoSyncRunning = true;
    try {
      const list = accounts();
      for (const account of list) {
        try {
          const messagesRaw = await runInbox(["list", account.email, "--fid=INBOX", "--limit=50"], inboxEnvFor(account));
          const messages = Array.isArray(messagesRaw) ? messagesRaw : [];
          // 自动过滤垃圾邮件（6.3）：移走黑名单发件人邮件后再落缓存
          try {
            const f = await runInbox(["filter-spam", account.email, "--fid=INBOX"], inboxEnvFor(account));
            if (f && f.ok && Array.isArray(f.movedIds) && f.movedIds.length) {
              const movedSet = new Set(f.movedIds);
              writeJson(path.join(cacheDir, `messages-${account.id}-INBOX.json`), messages.filter((m) => !movedSet.has(String(m.id))));
            } else {
              writeJson(path.join(cacheDir, `messages-${account.id}-INBOX.json`), messages);
            }
          } catch (fe) {
            ctx?.log?.warn?.("auto_sync.spam_filter_failed", { account: account.id, error: fe.message });
            writeJson(path.join(cacheDir, `messages-${account.id}-INBOX.json`), messages);
          }
        } catch (e) {
          ctx?.log?.warn?.("auto_sync.failed", { account: account.id, error: e.message });
        }
      }
    } finally {
      autoSyncRunning = false;
    }
  }
  setInterval(autoSyncAccounts, AUTO_SYNC_INTERVAL_MS);
  // 启动后 15 秒先做一轮，避免用户等待 3 分钟
  setTimeout(autoSyncAccounts, 15 * 1000);
}
