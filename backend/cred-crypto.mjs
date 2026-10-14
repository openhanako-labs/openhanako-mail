/**
 * cred-crypto.mjs — 邮箱凭据静态加密（AES-256-GCM）
 *
 * 统一供 routes/ui.js、tools/accounts.js、backend/ws-monitor.mjs 使用，
 * 消除此前「routes 加密落盘、tools 明文写、ws-monitor 直接读密文」的加解密不对称。
 *
 * 密钥派生：
 *   密钥 = scrypt(用户名 + ":" + per-install 随机盐, "hanako-mail-nonce", 32)
 *   - per-install 盐：首次使用时生成 16 字节随机值，存于
 *     <plugin-data>/hanako-mail/.cred-salt（与 accounts.json 同目录）
 *   - 相比旧版「用户名 + 硬编码盐」：攻击者仅凭 accounts.json + 公开用户名
 *     无法离线推导密钥，还必须同时拿到 .cred-salt 文件。
 *   - 兼容旧格式：解密时新密钥失败（GCM 校验失败）自动回退旧密钥
 *     （用户名 + "hanako-mail-plugin-salt-v1"），保证既有 accounts.json 可读。
 *
 * 注意：这是「防备份泄露」级别的混淆加固，不是操作系统级密钥保护；
 * 同机同用户运行的任意进程仍可读到盐与账号文件。如需更强保护应使用
 * OS 级方案（Windows DPAPI / macOS Keychain）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LEGACY_SALT = "hanako-mail-plugin-salt-v1";
const KDF_NONCE = "hanako-mail-nonce";
const KEY_LEN = 32;
const SALT_FILE_NAME = ".cred-salt";

let _dataDir = "";

/** 设置凭据数据目录（routes/tools 在拿到 ctx 后调用）。 */
export function setCryptoDataDir(dir) {
  if (dir && typeof dir === "string") _dataDir = dir;
}

/** 解析凭据数据目录：显式设置 > HANAKO_PLUGIN_DATA（主进程/子进程）> 默认 App 数据目录。 */
export function getCryptoDataDir() {
  if (_dataDir) return _dataDir;
  if (process.env.HANAKO_PLUGIN_DATA) return process.env.HANAKO_PLUGIN_DATA;
  const home = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
  return path.join(home, "app-data", "hanako-mail");
}

function saltFilePath() {
  return path.join(getCryptoDataDir(), SALT_FILE_NAME);
}

// 读取（或首次生成）per-install 随机盐
function getInstanceSalt() {
  const file = saltFilePath();
  try {
    const existing = fs.readFileSync(file, "utf-8").trim();
    if (/^[0-9a-f]{32}$/i.test(existing)) return existing;
  } catch { /* 不存在则生成 */ }
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
  const salt = crypto.randomBytes(16).toString("hex");
  try { fs.writeFileSync(file, salt, "utf-8"); } catch { /* 写失败则退化为仅内存 */ }
  return salt;
}

function deriveKey(saltMaterial) {
  return crypto.scryptSync(saltMaterial, KDF_NONCE, KEY_LEN);
}

function currentKey() {
  const salt = getInstanceSalt();
  return deriveKey(`${os.userInfo().username}:${salt}`);
}

function legacyKey() {
  return deriveKey(`${os.userInfo().username}-${LEGACY_SALT}`);
}

/**
 * 加密明文。返回 `ENC:<iv>:<tag>:<ciphertext>`（hex）。
 * 非字符串 / 空串原样返回。
 */
export function encryptField(text) {
  if (!text || typeof text !== "string") return text;
  const key = currentKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `ENC:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

/**
 * 解密。自动兼容旧格式（旧密钥解不开时回退）。
 * 无法解密时原样返回（保持向后兼容，不抛错）。
 */
export function decryptField(token) {
  if (!token || typeof token !== "string") return token;
  if (!token.startsWith("ENC:")) return token;
  const parts = token.slice(4).split(":");
  if (parts.length !== 3) return token;
  const [ivHex, tagHex, encHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(encHex, "hex");

  for (const key of [currentKey(), legacyKey()]) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(data), decipher.final()]);
      return dec.toString("utf8");
    } catch { /* 尝试下一个密钥 */ }
  }
  return token; // 两个密钥均失败：原样返回
}

/** 需要加密的 account.config 字段。新增凭据请加到这里。 */
const SENSITIVE_CONFIG_KEYS = ["imapPass", "smtpPass", "agentqqAccessToken", "agentqqRefreshToken"];

export function encryptSensitiveFields(account) {
  const out = { ...account };
  if (out.apiKey && typeof out.apiKey === "string") out.apiKey = encryptField(out.apiKey);
  if (out.config && typeof out.config === "object") {
    const cfg = { ...out.config };
    for (const k of SENSITIVE_CONFIG_KEYS) {
      if (cfg[k] && typeof cfg[k] === "string") cfg[k] = encryptField(cfg[k]);
    }
    out.config = cfg;
  }
  return out;
}

export function decryptSensitiveFields(account) {
  if (!account || typeof account !== "object") return account;
  const out = { ...account };
  if (out.apiKey && typeof out.apiKey === "string") out.apiKey = decryptField(out.apiKey);
  if (out.config && typeof out.config === "object") {
    const cfg = { ...out.config };
    for (const k of SENSITIVE_CONFIG_KEYS) {
      if (cfg[k] && typeof cfg[k] === "string") cfg[k] = decryptField(cfg[k]);
    }
    out.config = cfg;
  }
  return out;
}

/**
 * 脱敏：返回 account 的浅拷贝，敏感字段非空时以 "****" 替代。
 * 用于工具输出与日志——明文凭据不得进入模型上下文（issue #2 Bug 3）。
 * 字段清单与 encrypt/decryptSensitiveFields 同源（apiKey + SENSITIVE_CONFIG_KEYS），
 * 新增凭据字段只改 SENSITIVE_CONFIG_KEYS 一处。
 */
export function redactAccount(account) {
  if (!account || typeof account !== "object") return account;
  const out = { ...account };
  if (out.apiKey) out.apiKey = "****";
  if (out.config && typeof out.config === "object") {
    const cfg = { ...out.config };
    for (const k of SENSITIVE_CONFIG_KEYS) {
      if (cfg[k]) cfg[k] = "****";
    }
    out.config = cfg;
  }
  return out;
}
