import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inboxEnvFor } from "../backend/common.mjs";
import { decryptSensitiveFields } from "../backend/cred-crypto.mjs";
// v2：安装目录只读，临时参数文件改写到 App 数据目录
import { runtimeDataDir } from "../lib/env.mjs";
// 常驻 worker IPC（v0.1.3 起替代每次冷启 node 子进程跑 inbox.mjs）
import * as workerClient from "../backend/worker-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.join(__dirname, "..", "backend");

async function runInbox(args, extraEnv = {}) {
  return await workerClient.runCli(args[0], args.slice(1), extraEnv);
}

// 结构化参数走 --json=<file> 通道（与 routes/ui.js 一致），避免长正文/特殊字符
// 在命令行参数中受限或被解析错位
function writeOptsFile(obj) {
  const dir = path.join(runtimeDataDir(), "_tmp");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `opts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(file, JSON.stringify(obj), "utf-8");
  return file;
}
function safeUnlink(p) {
  try { if (p) fs.unlinkSync(p); } catch {}
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

export const name = "mail_send";
export const description = "发送邮件";

export const parameters = {
  type: "object",
  properties: {
    accountId: { type: "string", description: "账号 ID" },
    to: { type: "string", description: "收件人邮箱地址" },
    subject: { type: "string", description: "邮件主题" },
    body: { type: "string", description: "邮件正文" },
    messageId: { type: "string", description: "回复的邮件 ID（可选，传此参数时回复邮件）" },
  },
  required: ["accountId", "to", "subject", "body"],
};

export async function execute(input, ctx) {
  const { accountId, to, subject, body, messageId } = input || {};
  if (!accountId || !to || !subject || !body) {
    return { ok: false, error: "accountId, to, subject, body are required" };
  }
  ctx.log?.info?.("mail_send", { accountId, to, subject, messageId });

  const account = resolveAccount(ctx, accountId);
  if (!account) return { ok: false, error: "account not found" };
  const extraEnv = inboxEnvFor(account);

  try {
    const optsFile = writeOptsFile({ to, subject, body });
    try {
      if (messageId) {
        const result = await runInbox(["reply", account.email, messageId, `--json=${optsFile}`], extraEnv);
        if (result.error) return { ok: false, error: result.error };
        return { ok: true, data: result };
      }

      const result = await runInbox(["send", account.email, `--json=${optsFile}`], extraEnv);
      if (result.error) return { ok: false, error: result.error };
      return { ok: true, data: result };
    } finally {
      safeUnlink(optsFile);
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
