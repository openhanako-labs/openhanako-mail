import fs from "node:fs";
import path from "node:path";
import { normalizeFolder, defaultFolders, inboxEnvFor } from "../backend/common.mjs";
import { decryptSensitiveFields } from "../backend/cred-crypto.mjs";
// 常驻 worker IPC（v0.1.3 起替代每次冷启 node 子进程跑 inbox.mjs）
import * as workerClient from "../backend/worker-client.mjs";

async function runInbox(args, extraEnv = {}) {
  return await workerClient.runCli(args[0], args.slice(1), extraEnv);
}

function resolveAccount(ctx, accountId) {
  const dataDir = path.join(ctx.dataDir, ctx.pluginId);
  const accountsPath = path.join(dataDir, "accounts.json");
  let accounts = [];
  // 读入即解密，与 http/ui.js 的 accounts() 对齐——密文透传给后端必然登录失败（issue #2 Bug 2）
  try { accounts = JSON.parse(fs.readFileSync(accountsPath, "utf-8")).map(decryptSensitiveFields); } catch {}
  const account = accounts.find(a => a.id === accountId);
  if (!account) return null;
  return account;
}

function readWsCache(ctx, accountId) {
  const cacheDir = path.join(ctx.dataDir, ctx.pluginId, "cache");
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

export const name = "mail_sync";
export const description = "同步邮箱文件夹";

export const parameters = {
  type: "object",
  properties: {
    accountId: { type: "string", description: "账号 ID" },
    folder: { type: "string", description: "文件夹名（可选，默认 INBOX）" },
  },
  required: ["accountId"],
};

export async function execute(input, ctx) {
  const accountId = input?.accountId || "";
  const folder = input?.folder || "INBOX";
  ctx.log?.info?.("mail_sync", { accountId, folder });

  const dataDir = path.join(ctx.dataDir, ctx.pluginId, "cache");
  fs.mkdirSync(dataDir, { recursive: true });

  const account = resolveAccount(ctx, accountId);
  if (!account) return { ok: false, error: "account not found" };
  const extraEnv = inboxEnvFor(account);

  try {
    let folders = [];
    try {
      const foldersRaw = await runInbox(["folders", account.email], extraEnv);
      folders = (Array.isArray(foldersRaw) ? foldersRaw : []).map(f => normalizeFolder(f, accountId));
    } catch (e) {
      ctx.log?.warn?.("mail_sync.folders_fallback", { error: e.message });
      folders = defaultFolders(accountId);
    }

    let messagesRaw = [];
    try {
      messagesRaw = await runInbox(["list", account.email, `--fid=${folder}`, "--limit=50"], extraEnv);
    } catch (e) {
      ctx.log?.warn?.("mail_sync.list_fallback", { error: e.message });
    }
    let messages = Array.isArray(messagesRaw) ? messagesRaw : [];

    // 合并 WebSocket 实时缓存（ClawEmail 账号）
    if (account.email.endsWith("@claw.163.com")) {
      const wsMails = readWsCache(ctx, accountId);
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

    fs.writeFileSync(path.join(dataDir, `folders-${accountId}.json`), JSON.stringify(folders, null, 2), "utf-8");
    fs.writeFileSync(path.join(dataDir, `messages-${accountId}-${folder}.json`), JSON.stringify(messages, null, 2), "utf-8");

    return { ok: true, data: { folders, messages } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}


