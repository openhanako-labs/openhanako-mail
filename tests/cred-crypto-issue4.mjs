/**
 * 验证 issue #4 的四处修复：
 *   1. 用户名不可用（macOS 沙盒）时不再抛错，主密钥仍可用
 *   2. 新旧三种密钥格式都能解开（不能把用户已有密码锁死）
 *   3. 解不开时返回 null，而不是把 ENC:... 原样当成密码
 *   4. decryptSensitiveFields 会标记 _undecryptable
 *
 * 跑法：node tests/cred-crypto-issue4.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cred-crypto-test-"));
process.env.HANAKO_PLUGIN_DATA = TMP;

const mod = await import("../backend/cred-crypto.mjs");
const { encryptField, decryptField, decryptSensitiveFields, setCryptoDataDir } = mod;
setCryptoDataDir(TMP);

const KDF_NONCE = "hanako-mail-nonce";
const LEGACY_SALT = "hanako-mail-plugin-salt-v1";
const KEY_LEN = 32;
const derive = (m) => crypto.scryptSync(m, KDF_NONCE, KEY_LEN);

// 读（或造）per-install 盐，用于构造"旧格式"密文
const saltFile = path.join(TMP, ".cred-salt");
function salt() {
  if (fs.existsSync(saltFile)) return fs.readFileSync(saltFile, "utf-8").trim();
  const s = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(saltFile, s, "utf-8");
  return s;
}

function encryptWith(key, text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `ENC:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}

const realUser = (() => {
  try { return os.userInfo().username; } catch { return "unknown"; }
})();

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

console.log(`临时数据目录：${TMP}`);
console.log(`系统用户名：${realUser}\n`);

// ── 1. 新格式往返 ──
console.log("1) 新主密钥往返");
const secret = "p@ssw0rd-测试-🔐";
const encNew = encryptField(secret);
check("加密结果以 ENC: 开头", String(encNew).startsWith("ENC:"));
check("新格式能解回原文", decryptField(encNew) === secret);

// ── 2. 旧格式兼容（0.6.x：用户名 + 盐） ──
console.log("\n2) 旧格式兼容");
const encUserSalt = encryptWith(derive(`${realUser}:${salt()}`), "old-user-salt");
check("用户名+盐 解出正确", decryptField(encUserSalt) === "old-user-salt", `得到 ${JSON.stringify(decryptField(encUserSalt))}`);

const encLegacy = encryptWith(derive(`${realUser}-${LEGACY_SALT}`), "old-legacy");
check("用户名+硬编码盐 解出正确", decryptField(encLegacy) === "old-legacy", `得到 ${JSON.stringify(decryptField(encLegacy))}`);

// ── 3. 明文幂等 / 解不开返回 null ──
console.log("\n3) 边界行为");
check("明文原样返回", decryptField("plain-text") === "plain-text");
check("空值原样返回", decryptField("") === "");
const broken = `ENC:${crypto.randomBytes(12).toString("hex")}:${crypto.randomBytes(16).toString("hex")}:${crypto.randomBytes(16).toString("hex")}`;
check("解不开返回 null（不是原文）", decryptField(broken) === null, `得到 ${JSON.stringify(decryptField(broken))}`);

// ── 4. decryptSensitiveFields 标记 ──
console.log("\n4) 字段级标记");
const acc = decryptSensitiveFields({
  id: "a1",
  config: { user: "u@example.com", imapPass: broken, smtpPass: encryptField("ok-pass") },
});
check("正常字段解出", acc.config.smtpPass === "ok-pass");
check("坏字段变 null", acc.config.imapPass === null);
check("坏字段被标记", Array.isArray(acc._undecryptable) && acc._undecryptable.includes("imapPass"), JSON.stringify(acc._undecryptable));

// ── 5. 用户名不可用（模拟 macOS 沙盒） ──
console.log("\n5) os.userInfo() 抛错时");
fs.rmSync(saltFile, { force: true });           // 让盐重新生成，避免旧密文误导
const origUserInfo = os.userInfo;
os.userInfo = () => { throw Object.assign(new Error("uv_os_get_passwd returned ENOENT"), { code: "ENOENT" }); };
try {
  // 必须在 patch 之后重新加载模块，才能走到 safeUserName()
  const fresh = await import(`../backend/cred-crypto.mjs?t=${Date.now()}`);
  fresh.setCryptoDataDir(TMP);

  let encOk = null;
  let threw = null;
  try { encOk = fresh.encryptField("sandbox-secret"); } catch (e) { threw = e; }
  check("加密不抛错", threw === null, threw ? `抛了 ${threw.message}` : "");
  check("沙盒下仍能加密", typeof encOk === "string" && encOk.startsWith("ENC:"));
  check("沙盒下能解回（只靠本机盐）", fresh.decryptField(encOk) === "sandbox-secret");

  // 旧格式在沙盒里应当解不开（用户名取不到），但要返回 null 而不是抛错
  let legacyThrew = null;
  let legacyVal;
  try { legacyVal = fresh.decryptField(encUserSalt); } catch (e) { legacyThrew = e; }
  check("旧格式在沙盒里不抛错", legacyThrew === null, legacyThrew ? `抛了 ${legacyThrew.message}` : "");
  check("旧格式在沙盒里返回 null（该格式本就依赖用户名）", legacyVal === null, `得到 ${JSON.stringify(legacyVal)}`);
} finally {
  os.userInfo = origUserInfo;
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
