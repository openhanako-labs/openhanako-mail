import fs from "node:fs";
import path from "node:path";
import { inboxEnvFor } from "../backend/common.mjs";
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

export const name = "mail_messages";
export const description = "获取邮件列表或单封邮件";

export const parameters = {
  type: "object",
  properties: {
    accountId: { type: "string", description: "账号 ID" },
    folderId: { type: "string", description: "文件夹 ID（可选，默认 INBOX）" },
    messageId: { type: "string", description: "邮件 ID（可选，传此参数则获取单封邮件）" },
  },
  required: ["accountId"],
};

export async function execute(input, ctx) {
  const accountId = input?.accountId || "";
  const folderId = input?.folderId || "INBOX";
  const messageId = input?.messageId || "";

  if (!accountId) return { ok: false, error: "accountId is required" };

  const account = resolveAccount(ctx, accountId);
  if (!account) return { ok: false, error: "account not found" };
  const extraEnv = inboxEnvFor(account);

  try {
    if (messageId) {
      const result = await runInbox(["read", account.email, messageId], extraEnv);
      if (result.error) return { ok: false, error: result.error };
      return { ok: true, data: result };
    }

    const result = await runInbox(["list", account.email, `--fid=${folderId}`, `--limit=50`], extraEnv);
    if (result.error) return { ok: false, error: result.error };
    const list = Array.isArray(result) ? result : [];
    return { ok: true, data: list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
