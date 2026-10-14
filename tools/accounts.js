import fs from "node:fs";
import path from "node:path";
import { setCryptoDataDir, encryptSensitiveFields, decryptSensitiveFields, redactAccount } from "../backend/cred-crypto.mjs";

export const name = "mail_accounts";
export const description = "邮件账号管理：列表/创建/删除账号";

export const parameters = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "create", "delete"], description: "操作类型" },
    name: { type: "string", description: "账号名称（create 时必填）" },
    email: { type: "string", description: "邮箱地址（create 时必填）" },
    provider: { type: "string", description: "邮箱提供商（create 时可选，默认 imap）" },
    id: { type: "string", description: "账号 ID（delete 时必填）" },
  },
};

export async function execute(input, ctx) {
  const action = input?.action || "list";
  ctx.log?.info?.("mail_accounts", { action });

  const dataDir = path.join(ctx.dataDir, ctx.pluginId);
  // 与 routes/ui.js 使用同一套凭据加解密（此前 tools 明文读写会破坏加密格式）
  setCryptoDataDir(dataDir);
  const accountsPath = path.join(dataDir, "accounts.json");

  function readAccounts() {
    try { return JSON.parse(fs.readFileSync(accountsPath, "utf-8")).map(decryptSensitiveFields); }
    catch { return []; }
  }

  function writeAccounts(list) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(accountsPath, JSON.stringify(list.map(encryptSensitiveFields), null, 2), "utf-8");
  }

  if (action === "list") {
    // 输出脱敏：明文凭据不得进入模型上下文与日志（issue #2 Bug 3）
    return { ok: true, data: readAccounts().map(redactAccount) };
  }

  if (action === "create") {
    const { name, email, provider } = input || {};
    if (!name || !email) return { ok: false, error: "name and email are required" };
    const list = readAccounts();
    const account = { id: Date.now().toString(), name, email, provider: provider || "imap", createdAt: Date.now(), updatedAt: Date.now() };
    list.push(account);
    writeAccounts(list);
    return { ok: true, data: list.map(redactAccount) };
  }

  if (action === "delete") {
    const { id } = input || {};
    const list = readAccounts().filter((a) => a.id !== id);
    writeAccounts(list);
    return { ok: true, data: list.map(redactAccount) };
  }

  return { ok: false, error: "unknown action" };
}
