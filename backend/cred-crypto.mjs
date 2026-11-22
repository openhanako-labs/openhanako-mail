/**
 * cred-crypto.mjs — 邮箱凭据静态加密（AES-256-GCM）
 *
 * 统一供 routes/ui.js、tools/accounts.js、backend/ws-monitor.mjs 使用，
 * 消除此前「routes 加密落盘、tools 明文写、ws-monitor 直接读密文」的加解密不对称。
 *
 * 密钥派生：
 *   主密钥 = scrypt("hanako-mail-install:" + per-install 随机盐, "hanako-mail-nonce", 32)
 *   - per-install 盐：首次使用时生成 16 字节随机值，存于
 *     <plugin-data>/hanako-mail/.cred-salt（与 accounts.json 同目录）
 *   - 主密钥**不再参与用户名**。之前是 scrypt(用户名 + ":" + 盐)，而在 macOS
 *     受管运行时沙盒里 os.userInfo() 会抛 ENOENT（uv_os_get_passwd 不可用），
 *     密钥直接推不出来，进而把整条实时收件链路拖死（issue #4）。
 *     改成本机盐单因子后，沙盒里也能正常派生。
 *   - 兼容：解密时依次尝试「本次主密钥 → 旧版(用户名+盐) → 最老(用户名+硬编码盐)」，
 *     既有的 accounts.json 照旧能读。
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

/**
 * 取当前系统用户名，拿不到返回 null。
 *
 * ⚠️ 必须包 try：macOS 受管运行时沙盒里 `uv_os_get_passwd` 返 ENOENT，
 *   `os.userInfo()` 直接抛错。旧代码没包，于是一个取用户名失败就把
 *   整个解密链路拖垮（issue #4 第 1 点）。
 */
function safeUserName() {
  try {
    const name = os.userInfo().username;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

/** 当前主密钥：只依赖本机 per-install 盐，不参与用户名。 */
function installKey() {
  return deriveKey(`hanako-mail-install:${getInstanceSalt()}`);
}

/** 0.6.x 的主密钥：用户名 + per-install 盐。仅用于解密既有数据。 */
function userSaltKey() {
  const name = safeUserName();
  return name ? deriveKey(`${name}:${getInstanceSalt()}`) : null;
}

/** 最老的密钥：用户名 + 硬编码盐。仅用于解密。 */
function legacyKey() {
  const name = safeUserName();
  return name ? deriveKey(`${name}-${LEGACY_SALT}`) : null;
}

/**
 * 按优先级列出可用于解密的密钥。
 *
 * ⚠️ 每个候选单独包 try：旧代码是 `[currentKey(), legacyKey()]` 直接写在
 *   循环头里，数组先求值、try 只盖住解密本身——第一个候选一抛就全完。
 */
function keyCandidates() {
  const out = [];
  for (const build of [installKey, userSaltKey, legacyKey]) {
    try {
      const key = build();
      if (key) out.push(key);
    } catch { /* 该候选不可用，继续下一个 */ }
  }
  return out;
}

/**
 * 加密明文。返回 `ENC:<iv>:<tag>:<ciphertext>`（hex）。
 * 非字符串 / 空串原样返回。
 */
export function encryptField(text) {
  if (!text || typeof text !== "string") return text;
  const key = installKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `ENC:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

/**
 * 解密。
 *
 * 返回：
 *   - 明文（不是密文、或者成功解开）
 *   - **null** —— 看着是密文但所有密钥都解不开
 *
 * ⚠️ 最后一种是 issue #4 改的：旧代码「原样返回」，于是 `ENC:1e...` 会被
 *   当成密码发给服务器，表现成一次莫名其妙的 `NO LOGIN Login error`，
 *   日志里完全看不出是“换过机器/用户名不可用”导致的解不开。
 *   返回 null 让上层能明确说“这行凭据解不开”，而不是拿密文去撞服务器。
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

  for (const key of keyCandidates()) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(data), decipher.final()]);
      return dec.toString("utf8");
    } catch { /* 尝试下一个密钥 */ }
  }
  return null; // 是密文，但没有任何候选密钥能解开
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
  // 解不开的字段名收集起来，上层可据此报“凭据无法解密”而不是“密码错误”
  const undecryptable = [];
  const dec = (field, value) => {
    const r = decryptField(value);
    if (r === null) undecryptable.push(field);
    return r;
  };
  if (out.apiKey && typeof out.apiKey === "string") out.apiKey = dec("apiKey", out.apiKey);
  if (out.config && typeof out.config === "object") {
    const cfg = { ...out.config };
    for (const k of SENSITIVE_CONFIG_KEYS) {
      if (cfg[k] && typeof cfg[k] === "string") cfg[k] = dec(k, cfg[k]);
    }
    out.config = cfg;
  }
  if (undecryptable.length) out._undecryptable = undecryptable;
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
