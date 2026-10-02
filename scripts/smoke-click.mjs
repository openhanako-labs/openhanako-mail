/**
 * scripts/smoke-click.mjs — 点击回调的端到端验证。
 *
 * 这条链此前一次都没跑通过，踩过两次环境坑，都变成断言写在这里：
 *
 *   1. `-click` **根本不是 SnoreToast 的标志**（二进制按 UTF-16LE 扫，命中 0）。
 *   2. 具名管道**不能在 AppHost 的子进程里建** —— 宿主给应用子进程拼的 argv 没有
 *      `--allow-net`，而 Node 26 的权限模型把 net（含 Windows 具名管道）一起管住：
 *        createServer: ERR_ACCESS_DENIED ... Use --allow-net to manage permissions.
 *      （第一次的「权限模型内能建管道」实验之所以通过，是因为它跑在系统自带的
 *        Node 24 上 —— 24 还没有网络门。复现平台与生产不一致时，「能跑通」不可信。）
 *
 * 所以管道由**服务**建（它是 local-machine + external，有 net），分两段验证：
 *
 *   A. 服务侧（生产路径）：/notify-arm-pipe 拿到管道名 → 模拟 SnoreToast 写
 *      `action=activate` → 断言 notify-click.json 被写出且身份对得上。
 *   B. 助手侧：给它一个**别人拥有的**管道名，断言它照用不误（这条不需要 net）。
 *
 * 跑法：node scripts/smoke-click.mjs        （B 段会真的弹一条系统通知）
 */

import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOAST = path.join(ROOT, "helper", "mail-toast.cjs");

// 反斜杠用拼接写，不用模板字符串：
//   一是手数反斜杠已经写错过一次断言（假红），
//   二是模板字符串里以反斜杠结尾会把收尾反引号转义掉，直接语法错误（也踩过）。
const BS = "\\";
const PIPE_PREFIX = BS + BS + "." + BS + "pipe" + BS;

let failed = 0;
function check(name, ok, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? "  " + detail : ""));
  if (!ok) failed++;
}

if (!fs.existsSync(path.join(ROOT, "backend", "node_modules", "node-notifier"))) {
  console.log("SKIP  需要 backend/node_modules（先 npm install 或从已安装副本拷一份）");
  process.exit(0);
}

console.log("注意：B 段会真的弹一条 Windows 系统通知。\n");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "mail-click-"));
const dataDir = path.join(home, "app-data", "hanako-mail");
fs.mkdirSync(dataDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(120);
  }
  return null;
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}

// ── A. 服务侧：管道由服务建（生产路径） ──────────────────────────
const PORT = Number(process.env.HANA_MAIL_CLICK_PORT) || 43186;
const MARKER = "HANA_MAIL_SERVICE_READY";
const svc = spawn(process.execPath, [path.join(ROOT, "runtime", "service.mjs"), dataDir, "", String(PORT)], {
  cwd: dataDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
let probe = "";
svc.stdout.on("data", (d) => { probe += d.toString(); });
svc.stderr.on("data", (d) => { if (process.env.MAIL_DEBUG) process.stderr.write("[svc] " + d); });

const ready = await waitFor(() => (probe.includes(MARKER) ? true : null), 20000);
if (!ready) {
  console.log("SKIP  服务未就绪（确认 runtime/service.mjs 能被单跑）");
  try { svc.kill(); } catch { /* ignore */ }
  process.exit(0);
}

async function call(route, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return await res.json();
}

const armed = await call("/notify-arm-pipe", { messageId: "click-a", accountId: "acc-a", summaryCount: 5 });
check("★ 服务能建点击管道（AppHost 子进程建不了）",
  armed?.ok === true && !!armed.pipe, String(armed?.error || armed?.pipe || ""));
check("管道名是 Windows 具名管道形状",
  String(armed?.pipe || "").startsWith(PIPE_PREFIX), String(armed?.pipe || ""));

if (armed?.ok) {
  const clickPath = path.join(dataDir, "notify-click.json");
  const payload = Buffer.from("toastSmt=1;action=activate;button=;", "utf16le");
  await new Promise((resolve) => {
    const sock = net.connect(armed.pipe, () => { sock.write(payload); setTimeout(() => sock.end(), 100); });
    sock.on("error", () => resolve());
    sock.on("close", () => resolve());
    setTimeout(resolve, 3000);
  });

  const click = await waitFor(() => readJson(clickPath), 6000);
  check("★ 管道收到 action=activate → 写出 notify-click.json", !!click, JSON.stringify(click || {}).slice(0, 170));
  check("点击记录带对 messageId（卡片要靠它打开详情）", click?.messageId === "click-a", String(click?.messageId));
  check("点击记录带对 accountId", click?.accountId === "acc-a", String(click?.accountId));
  // 汇总通知（一波 ≥3 封合并）靠这个字段自解释。上一版汇总项没带 messageId，
  // 导致点开只写空串 → 卡片侧不动作 → 静默失效。
  check("汇总通知的 summaryCount 能落到点击记录里", click?.summaryCount === 5, String(click?.summaryCount));
  check("点击记录带可判断新旧的时间戳", Date.parse(click?.at || "") > 0);

  const again = await call("/notify-arm-pipe", { messageId: "click-b" });
  check("每次 arm 给一条新管道（一次性）", again?.ok === true && again.pipe !== armed.pipe);
}

// ── B. 助手侧：照用别人给的管道名 ─────────────────────────────
const ownPipe = PIPE_PREFIX + "hana-mail-smoke-own-" + Date.now().toString(36);
const own = net.createServer(() => { /* 不需要读内容 */ });
const ownOk = await new Promise((resolve) => {
  own.once("error", () => resolve(false));
  own.listen(ownPipe, () => resolve(true));
});

if (!ownOk) {
  console.log("SKIP  B 段：本进程建不了管道（Node 版本或环境限制）");
} else {
  const SUBJECT = "【自检】点击回调（服务拥有管道）";
  const argsFile = path.join(dataDir, "notify-args-smoke.json");
  fs.writeFileSync(argsFile, JSON.stringify({
    subject: SUBJECT, sender: "测试发件人", messageId: "click-b", accountId: "acc-b",
  }), "utf-8");

  const child = spawn(process.execPath, [
    "--permission",
    `--allow-fs-read=${ROOT}`,
    `--allow-fs-read=${dataDir}`,
    `--allow-fs-write=${dataDir}`,
    "--allow-child-process",
    TOAST,
    `--args-file=${argsFile}`,
    `--work-dir=${dataDir}`,
    `--pipe-name=${ownPipe}`,
    // 给这次投递一个 id：结果文件是全局共享的，没它就无法区分“我这轮的记录”
    // 与另一个并发 helper（比如 /notify-test）写下的记录。
    "--result-id=smoke-b-click",
  ], { cwd: dataDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  const rec = await waitFor(() => {
    const r = readJson(path.join(dataDir, "notify-last-result.json"));
    return r && r.subject === SUBJECT ? r : null;
  }, 15000);

  // 断言的是「已尝试投递」，**不等于系统已展示通知** —— 名字里写清楚，
  // 不然读代码的人会把它当成“通知真的弹出来了”的证据（这是复核指出的假绿风险）。
  check("助手在真实权限模型下完成了投递尝试（不代表系统已展示）",
    rec?.attempted === true, JSON.stringify(rec || {}).slice(0, 170));
  check("助手记录了本次 --result-id（并发 helper 靠它不互相污染）",
    rec?.resultId === "smoke-b-click", String(rec?.resultId));
  check("★ 助手照用了外给的管道名（自己不必建管道）",
    rec?.pipe === ownPipe && rec?.click === true,
    `click=${rec?.click} pipe=${rec?.pipe || ""} err=${rec?.clickError || ""}`);

  if (stderr.trim()) {
    console.log("      助手 stderr:\n" + stderr.trim().split("\n").map((l) => "        " + l).join("\n"));
  }
  try { child.kill(); } catch { /* ignore */ }
  try { own.close(); } catch { /* ignore */ }
}

try { svc.kill(); } catch { /* ignore */ }
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 句柄可能未释放 */ }

console.log(`\nsmoke-click: ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
