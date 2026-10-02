/**
 * scripts/smoke-load.mjs — 装载自检（不需要宿主，可直接 node 跑）。
 *
 * 覆盖 v1→v2 迁移里最容易静默出错的部分：
 *   1) ctx 投影：老代码 path.join(ctx.dataDir, ctx.pluginId) 必须仍解析到真实 App 数据目录
 *   2) 路由 registrar 真的能跑完：v2 里 registrar 抛错 = 整应用 failed
 *   3) 不存在与 ctx.routes.register() 互斥的顶层 routes/ 源文件
 *   4) 受管服务缺席时，apply() 只能降级、不能抛（工具与卡片要还能用）
 *   5) 转发层在服务不可用时返回 { ok:false }，不抛异常
 *
 * 真正跑通邮件链路要连宿主环境，见 README「自检」一节里单独跑 service.mjs 的办法。
 *
 * 用法：node scripts/smoke-load.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Windows 上从非 C: 盘（如 W:）用绝对路径 import() 会撞
// ERR_UNSUPPORTED_ESM_URL_SCHEME（"Received protocol 'w:'"）—— 必须先转成 file:// URL。
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}
/**
 * 剥掉注释行，只留代码。
 * 给「某段旧代码不该再出现」这类断言用 —— 否则注释里提一句旧名字就把断言打红，
 * 而那些注释正是我们想让下一个人看懂的东西。
 * 判定：行首（去空白后）以 // 或 * 开头的算注释行。够用且不会误伤行内字符串。
 */
function codeOnly(src) {
  return src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
}


// ── 造一个隔离的 HANA_HOME ──
const home = fs.mkdtempSync(path.join(os.tmpdir(), "mail-smoke-"));
const appDataDir = path.join(home, "app-data", "hanako-mail");
fs.mkdirSync(appDataDir, { recursive: true });

process.env.HANA_HOME = home;
delete process.env.HANAKO_PLUGIN_DATA;

// ── 假的 v2 ctx：routes.register 必须真的把 registrar 跑一遍 ──
const registeredTools = [];
const registeredRoutes = [];
const fakeLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const ctx = {
  dataDir: appDataDir,
  logger: fakeLogger,
  tools: { register: (t) => { registeredTools.push(t); return () => {}; } },
  routes: {
    register: async (fn) => {
      const app = {
        get: (p) => registeredRoutes.push(["GET", p]),
        post: (p) => registeredRoutes.push(["POST", p]),
        put: (p) => registeredRoutes.push(["PUT", p]),
        delete: (p) => registeredRoutes.push(["DELETE", p]),
        all: (p) => registeredRoutes.push(["ALL", p]),
      };
      await fn(app);
      return () => {};
    },
  },
  bus: { request: async () => ({}) },
  // 故意**不提供** ctx.runtime：AppHost 在服务缺席时必须降级而不是崩
};

// ── 装载 ──
const mod = await load("index.js");
check("index.js 导出 apply", typeof mod.apply === "function");

let dispose = null;
let loadErr = null;
try { dispose = await mod.apply(ctx); }
catch (e) { loadErr = e; }
check("服务缺席时 apply() 不抛（降级）", loadErr === null, loadErr?.message);
check("apply 仍返回 disposer", typeof dispose === "function");

// ── 1. 数据目录钉死 ──
check("HANAKO_PLUGIN_DATA = ctx.dataDir", process.env.HANAKO_PLUGIN_DATA === appDataDir,
  `实际=${process.env.HANAKO_PLUGIN_DATA}`);

// ── 2. ctx 投影：老表达式必须仍指向真实 App 数据目录 ──
const { legacyCtx } = await load("lib/legacy-ctx.mjs");
const lctx = legacyCtx(ctx);
check("join(lctx.dataDir, lctx.pluginId) === ctx.dataDir",
  path.join(lctx.dataDir, lctx.pluginId) === ctx.dataDir,
  `得 ${path.join(lctx.dataDir, lctx.pluginId)}`);
check("lctx.pluginDir 指向包根", lctx.pluginDir === ROOT);
check("lctx.log 是 v1 形状", typeof lctx.log.info === "function" && typeof lctx.log.warn === "function");

// ── 3. 注册面 ──
const names = registeredTools.map((t) => t.name).sort();
const expect = ["mail_accounts", "mail_folders", "mail_messages", "mail_send", "mail_sync"];
check("注册 5 个工具", names.length === 5, names.join(","));
check("工具名齐全", expect.every((n) => names.includes(n)), names.join(","));
check("每个工具都是 v2 单参 execute", registeredTools.every((t) => t.execute.length <= 1));

const paths = registeredRoutes.map(([, p]) => p);
check("路由 registrar 跑完且注册了路由", registeredRoutes.length > 15, `共 ${registeredRoutes.length} 条`);
check("包含 /accounts 与 /send", paths.includes("/accounts") && paths.includes("/send"));
check("不再有 v1 的模板路由 /mail", !paths.includes("/mail"));

// v2 把顶级 routes/ 目录当成另一条路由来源，与 ctx.routes.register() 互斥；
// 两边同时存在 = 整应用装载 failed（且 validate-app 静态校验查不到这条）。
const routesDir = path.join(ROOT, "routes");
let hasRouteSource = false;
if (fs.existsSync(routesDir)) {
  hasRouteSource = fs.readdirSync(routesDir, { withFileTypes: true })
    .some((e) => e.isFile() && /\.(m|c)?[jt]s$/.test(e.name));
}
check("不存在与 ctx.routes.register() 互斥的顶层 routes/ 源文件", !hasRouteSource);

// ── 4. 转发层：服务不可用时必须返回 { ok:false }，绝不抛 ──
const { callService, serviceState, SERVICE_PORT } = await load("lib/runtime-host.mjs");
check("服务未启动时 serviceState 为 failed（已优雅降级）", serviceState() === "failed", serviceState());
check("端口在服务允许范围内（1024-65535）", SERVICE_PORT >= 1024 && SERVICE_PORT <= 65535, String(SERVICE_PORT));
const down = await callService("/health", {});
check("服务不可用时 callService 返回 ok:false", down?.ok === false, JSON.stringify(down).slice(0, 120));

// 惰性自愈：首次装载时权限可能还没记账（实测 apply 与授权差约 190ms），
// 那时 startService 被拒。callService 必须在第一次真调用时补起，
// 而不是把“首次失败”当终态 —— 否则用户得手动重新加载一次应用。
const rtSrc = fs.readFileSync(path.join(ROOT, "lib", "runtime-host.mjs"), "utf-8");check("callService 在服务未就绪时会惰性重启", /if \(_state !== "ready" \|\| !_runtimeId\)[\s\S]{0,200}await doStart\(\)/.test(rtSrc));
check("惰性重启做了并发去重（_starting）", rtSrc.includes("_starting"));
check("失败后仍保留启动参数以便重试", rtSrc.includes("_startArgs"));

check("卡片带 appSurfaceSession 凭证（v2 app 路由要求）", (() => {
  // 踩过：v2 的 app 路由不再认 v1 的 ?token=，服务端只收
  // X-Hana-App-Surface-Session 头或 appSurfaceSession 查询参数。
  // 用旧写法会拿到 403，而前端只会静默显示“暂无账号”—— 很难定位。
  const card = fs.readFileSync(path.join(ROOT, "ui", "mail.html"), "utf-8");
  return card.includes("appSurfaceSession");
})());

// 迁移放在服务启动流程里（AppHost 读不到 plugin-data，且 apply 可能早于授权）
const svcSrc = fs.readFileSync(path.join(ROOT, "runtime", "service.mjs"), "utf-8");
check("服务启动时自己完成 v1 迁移", /async function main\(\)[\s\S]{0,900}migrate\(LEGACY_DIR, DATA_DIR\)/.test(svcSrc));

// 残留的 childEnv 引用会变成运行期 SyntaxError（"does not provide an export named"），
// 静态语法检查查不出来 —— 这一条就是为它设的。
check("backend/lib 里不再有 childEnv 引用", (() => {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (!/\.(mjs|js|cjs)$/.test(e.name)) continue;
      if (fs.readFileSync(p, "utf-8").includes("childEnv")) hits.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, "backend")); walk(path.join(ROOT, "lib"));
  if (hits.length) console.log("      残留:", hits.join(", "));
  return hits.length === 0;
})());

let runCliThrew = false;
const { runCli } = await load("backend/worker-client.mjs");
try { await runCli("folders", ["a@b.c"]); } catch { runCliThrew = true; }
check("runCli 服务不可用时抛 Error（保持旧语义）", runCliThrew);

// ── 5. imap-idle 的两处保证（不能空转退出、不能自动接管进程） ──
const imapIdleSrc = fs.readFileSync(path.join(ROOT, "backend", "imap-idle.mjs"), "utf-8");
check("imap-idle 用 runtimeDataDir（不再自己推算少一层的回退路径）", imapIdleSrc.includes("runtimeDataDir()"));
check("imap-idle 有常驻守护（不会空转退出被父进程 10s 重启）", imapIdleSrc.includes("reconcileTimer"));
check("imap-idle 被 import 时不接管进程生命周期", imapIdleSrc.includes("IS_MAIN"));
const wsSrc = fs.readFileSync(path.join(ROOT, "backend", "ws-monitor.mjs"), "utf-8");
check("ws-monitor 被 import 时不接管进程生命周期", wsSrc.includes("IS_MAIN"));

// ── 6. manifest 与实现一致 ──
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf-8"));
const caps = manifest.capabilities || [];
const rtHost = fs.readFileSync(path.join(ROOT, "lib", "runtime-host.mjs"), "utf-8");
check("manifest 声明了 app/runtime.execute", caps.includes("app/runtime.execute"));
check("manifest 声明了 app/runtime.native", caps.includes("app/runtime.native"));
check("manifest 声明了 app/runtime.network", caps.includes("app/runtime.network"));
// native 沙箱身份在部分机器上永远建不起来（HANA_HOME 上有符号链接/重解析点），
// 这条降级要能在 manifest 里被授权，否则就是「降级也降不下来」——邮件功能整个不可用。
check("manifest 声明了 app/runtime.local-machine（native 降级路径要用）",
  caps.includes("app/runtime.local-machine"));
check("manifest 声明了 app/process.spawn（AppHost 要用它发桌面通知）", caps.includes("app/process.spawn"));

// 核心不变量：**服务侧（backend/*.mjs）不许有任何 spawn/execFile**。
// 服务跑在受管 native 运行时里，被 Job Object 管着，spawn 会直接 EPERM ——
// 之前 npm install / mail-cli / 图片代理 / 通知全死在这里，而且只在真实装载时暴露。
// 静态语法检查查不出这类问题，所以拿一个断言把它钉死。
check("服务侧（backend/*.mjs）无 spawn/execFile", (() => {
  const bad = [];
  for (const e of fs.readdirSync(path.join(ROOT, "backend"), { withFileTypes: true })) {
    if (!e.isFile() || !/\.mjs$/.test(e.name)) continue;
    const src = fs.readFileSync(path.join(ROOT, "backend", e.name), "utf-8");
    // 去掉注释行再查，避免把解释性注释当成调用
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    if (/\b(spawn|execFile|execFileSync|spawnSync)\s*\(/.test(code)) bad.push(e.name);
  }
  if (bad.length) console.log("      含 spawn:", bad.join(", "));
  return bad.length === 0;
})());

// 通知派发必须在 AppHost 侧（那里有 --allow-child-process）
//
// 注意：下面两条只验**形状**（文件在不在、源码里有没有这个字符串），不验行为。
// 历史上正是这个缺口让两个真 bug 躺了两天（队列「取走即删」、靠 SnoreToast
// 退出码判送达）。**行为**由 `scripts/smoke-notify.mjs` 负责，跑完本文件请一并跑它。
check("通知派发在 AppHost 侧（lib/notify-drain.mjs）", fs.existsSync(path.join(ROOT, "lib", "notify-drain.mjs")));
check("服务不自己发通知，而是入队", fs.readFileSync(path.join(ROOT, "runtime", "service.mjs"), "utf-8").includes("_pending_notify"));
check("profile 降级链首位是 native（优先有沙箱）", rtHost.includes('const RUNTIME_PROFILES = ["native"'));
check("profile 降级链含 local-machine（native 沙箱身份失败时的退路）", rtHost.includes('RUNTIME_PROFILES = ["native", "local-machine"]'));
check("manifest 声明了 app/runtime.local-machine", caps.includes("app/runtime.local-machine"));
check("仅沙箱身份类错误才触发降级", rtHost.includes("function shouldFallThrough"));
// 派发器必须**无条件**启动。它本身就是「服务不可用时的探针」，
// 而 runtime-host 的惰性自愈只等「第一次真调用」—— 唯一会周期性发起真调用的
// 消费者就是它。挂在 if (ready) 里等于让两条路互相等（实测踩过：服务起不来的那次，
// 通知也一起没了）。这里用源码位置断言，比“文件存在”强一点。
{
  const indexSrc = fs.readFileSync(path.join(ROOT, "index.js"), "utf-8");
  const drainAt = indexSrc.indexOf("startNotificationDrain(log)");
  const readyAt = indexSrc.indexOf("if (ready)");
  check("通知派发不挂在服务就绪分支里（startNotificationDrain 在 if (ready) 之前）",
    drainAt > -1 && readyAt > -1 && drainAt < readyAt,
    `drainAt=${drainAt} readyAt=${readyAt}`);
}
check("通知队列是「确认后删」而不是「取走即删」",
  fs.readFileSync(path.join(ROOT, "runtime", "service.mjs"), "utf-8").includes("ackNotifications")
  && fs.existsSync(path.join(ROOT, "scripts", "smoke-notify.mjs")));
check("network: external 与 manifest 一致", rtHost.includes('network: "external"'));
check("readyMarker 与服务端一致",
  rtHost.includes("HANA_MAIL_SERVICE_READY")
  && fs.readFileSync(path.join(ROOT, "runtime", "service.mjs"), "utf-8").includes("HANA_MAIL_SERVICE_READY"));

// 卡片封面（face）。官方校验器**不查它**，而写坏了只会静默降级成“未声明”——
// 所以把运行时那套规则（bundle/index.js 的 wkr 函数）在这里重实现一遍作为断言：
// 相对 ui/ 目录、不能用反斜杠、分段不能空/./../以.开头、扩展名限 png|webp|svg、文件必须存在。
const FACE_EXTS = new Set([".png", ".webp", ".svg"]);
function faceProblem(image) {
  const o = String(image).trim();
  if (!o) return "empty";
  if (o.includes("\\") || o.includes("\0")) return "illegal characters";
  if (o.startsWith("/")) return "must be relative to ui/";
  const segs = o.split("/");
  if (segs.some((s) => !s || s === "." || s === ".." || s.startsWith("."))) return "escapes ui/";
  const ext = path.extname(segs[segs.length - 1]).toLowerCase();
  if (!FACE_EXTS.has(ext)) return `bad extension "${ext || "none"}"`;
  const abs = path.join(ROOT, "ui", ...segs);
  try { if (!fs.statSync(abs).isFile()) return `not a file at ui/${segs.join("/")}`; }
  catch { return `missing ui/${segs.join("/")}`; }
  return null;
}
for (const [i, card] of (manifest.contributes?.cards || []).entries()) {
  if (card.face === undefined) continue;
  const img = card.face && typeof card.face === "object" ? card.face.image : undefined;
  const prob = typeof img === "string" ? faceProblem(img) : "face.image must be a string";
  check(`卡片 "${card.id}" 的 face 声明合法`, prob === null, prob || String(img));
}

// ── 7. 日志滚动与缓存清理（2026-09-22：实测两处无上限增长） ──
// 起因：ws-monitor.log 12 天长到 710 KB 而**没有任何滚动**；cache/ws-*.json 63 个
// 1.65 MB 而**没有任何清理机制**。这里既验「改对了」，也验「真的会滚动」——
// 前者是形状，后者是行为，只验形状就是之前让两个真 bug 躺两天的那个缺口。
{
  const { appendRolling, LOG_MAX_CHARS } = await load("backend/log-roll.mjs");
  const probe = path.join(home, "roll-probe.log");
  for (let i = 0; i < 4000; i++) appendRolling(probe, "x".repeat(40), 4096, 2048);
  const probeSize = fs.statSync(probe).size;
  // 4000 行 × 41 字符 ≈ 164 KB，滚动后必须只剩末尾一小截
  check("appendRolling 真的滚动（写 4000 行后文件仍很小）", probeSize <= 4096 + 64, `实际 ${probeSize} B`);
  check("appendRolling 保留的是末尾内容",
    fs.readFileSync(probe, "utf-8").trimEnd().endsWith("x".repeat(40)));
  check("LOG_MAX_CHARS 是有限值", Number.isFinite(LOG_MAX_CHARS) && LOG_MAX_CHARS > 1024, String(LOG_MAX_CHARS));

  const wsSrc2 = fs.readFileSync(path.join(ROOT, "backend", "ws-monitor.mjs"), "utf-8");
  const idleSrc2 = fs.readFileSync(path.join(ROOT, "backend", "imap-idle.mjs"), "utf-8");
  const rawAppend = (src) => /\bfs\.appendFileSync\s*\(\s*LOG_PATH/.test(src);
  check("ws-monitor 不再裸 appendFileSync 到日志", !rawAppend(wsSrc2));
  check("imap-idle 不再裸 appendFileSync 到日志", !rawAppend(idleSrc2));
  check("ws-monitor 走 appendRolling", wsSrc2.includes("appendRolling(LOG_PATH"));
  check("imap-idle 走 appendRolling", idleSrc2.includes("appendRolling(LOG_PATH"));
  check("ws-monitor 缓存清理是数量上限（不设时间上限）",
    wsSrc2.includes("pruneWsCache") && wsSrc2.includes("WS_CACHE_MAX_FILES"));
  check("★ 缓存清理没有时间上限（那会删掉列表里的旧邮件）",
    !wsSrc2.includes("WS_CACHE_MAX_AGE_MS") && !/tooOld/.test(wsSrc2));
  check("startAll 启动时清理一次缓存", /startAll\(\)[\s\S]{0,260}pruneWsCache\(\)/.test(wsSrc2));
  check("saveMail 每若干封也清理一次（长期不收信不重启也不涨）", /_savesSincePrune\s*\+\+/.test(wsSrc2));

  // 只按数量淘汰，**故意不设时间上限**。这里除了验行为，还要验「存量不会被误删」——
  // 实测 2026-09-22 时 cache/ 里有 62 个，最老的来自 7 月；早先写成「14 天」时
  // 会删掉其中 54 个，而它们是列表里旧邮件在本地唯一的痕迹。
  const { pruneWsCache } = await load("backend/ws-monitor.mjs");
  const cacheDir = path.join(appDataDir, "cache");
  const WS_MAX_FILES = 500;
  const wipeCache = () => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.mkdirSync(cacheDir, { recursive: true });
  };
  const touch = (name, atMs) => {
    const p = path.join(cacheDir, name);
    fs.writeFileSync(p, "{}");
    fs.utimesSync(p, new Date(atMs), new Date(atMs));
    return p;
  };
  const wsLeft = () => fs.readdirSync(cacheDir).filter((n) => n.startsWith("ws-"));
  const nowMs = Date.now();

  // A. 存量在限额内 → 一个都不删（包括跨越数月的旧文件）
  wipeCache();
  const QUARTER = 90 * 24 * 60 * 60 * 1000;
  for (let i = 0; i < 40; i++) touch(`ws-a-old${String(i).padStart(3, "0")}.json`, nowMs - QUARTER - i * 1000);
  for (let i = 0; i < 22; i++) touch(`ws-a-new${String(i).padStart(3, "0")}.json`, nowMs - i * 1000);
  const resA = pruneWsCache();
  check("pruneWsCache 限额内一个不删（老文件也留）",
    resA.removed === 0 && wsLeft().length === 62, JSON.stringify(resA));

  // B. 超过数量上限 → 收敛到上限，删的是最旧的
  wipeCache();
  for (let i = 0; i < WS_MAX_FILES + 17; i++) touch(`ws-b-${String(i).padStart(4, "0")}.json`, nowMs - i * 1000);
  const resB = pruneWsCache();
  check("pruneWsCache 超限后收敛到上限", wsLeft().length === WS_MAX_FILES, `剩 ${wsLeft().length}`);
  check("pruneWsCache 删的是最旧的",
    wsLeft().includes("ws-b-0000.json") && !wsLeft().includes(`ws-b-0${WS_MAX_FILES + 16}.json`), "");
  check("pruneWsCache 报告删除数", resB.removed === 17, JSON.stringify(resB));

  // C. 没有时间上限：极旧的文件在限额内同样不动
  wipeCache();
  touch("ws-c-ancient.json", nowMs - 400 * 24 * 60 * 60 * 1000);
  pruneWsCache();
  check("pruneWsCache 没有时间上限（400 天前的文件也不删）",
    wsLeft().length === 1 && wsLeft()[0] === "ws-c-ancient.json", wsLeft().join(","));

  // D. 旁文件不能被误伤（cache/ 里还有 messages-*.json、folders-*.json）
  const bystander = path.join(cacheDir, "messages-keepme.json");
  fs.writeFileSync(bystander, "{}");
  pruneWsCache();
  check("pruneWsCache 不碰非 ws- 文件", fs.existsSync(bystander) && wsLeft().length === 1);

  fs.rmSync(cacheDir, { recursive: true, force: true });
}

// ── 8. 点击轮询自适应（原来是恒定 1 秒 = 卡片开着时每小时 3600 次请求） ──
// 1 秒的密度只在「通知刚发出的那两分钟」里有意义；平时点无可点。
// 历史同样只验形状（“有这段代码”）而没验行为，这次把两个方向都钉一下。
{
  const html = fs.readFileSync(path.join(ROOT, "ui", "mail.html"), "utf-8");
  check("点击轮询不再是恒定 1 秒 setInterval",
    !/setInterval\(async function \(\) \{[\s\S]{0,700}\},\s*1000\)/.test(html));
  check("点击轮询改成自适应（快窗口 + 慢间隔）",
    html.includes("_CLICK_FAST_WINDOW_MS") && html.includes("_CLICK_SLOW_MS")
    && /setTimeout\(clickPollTick/.test(html));
  check("通知入队时打开快轮询窗口", html.includes("noteClickWindow();"));
  check("卡片打开时立刻查一次（承接卡片关闭期间攒下的点击）",
    /function startClickPoll\(\)[\s\S]{0,240}clickPollTick\(\);/.test(html));
  check("过期的点击仍然被丢弃（隔夜打开不跳旧信）", html.includes("_CLICK_EXPIRE_MS"));
}

// ── 9. 轮询开销（2026-09-22：真账约 6000 封/小时，贵的不在频率、在单次数据量） ──
// 60 秒轮询 60×50=3000；3 分钟自动同步 20×(50+100)=3000（其中 filter-spam 自己拉 100）。
// 下面四条把那三个放大项钉住。
{
  const inboxSrc = fs.readFileSync(path.join(ROOT, "backend", "inbox.mjs"), "utf-8");
  const uiSrc = fs.readFileSync(path.join(ROOT, "http", "ui.js"), "utf-8");
  const htmlSrc = fs.readFileSync(path.join(ROOT, "ui", "mail.html"), "utf-8");
  const cwSrc = fs.readFileSync(path.join(ROOT, "backend", "clawemail-backend.mjs"), "utf-8");

  // filter-spam 曾经每 3 分钟把 100 封邮件全拉一遍，只为比对一张**本地**黑名单
  const scanMatch = /filterSpamMessages[\s\S]{0,900}?limit:\s*(\d+)/.exec(inboxSrc);
  check("filter-spam 扫描窗口已收紧（≤30）",
    scanMatch !== null && Number(scanMatch[1]) <= 30, `limit=${scanMatch ? scanMatch[1] : "?"}`);

  const autoMatch = /AUTO_SYNC_INTERVAL_MS = (\d+) \* 60 \* 1000/.exec(uiSrc);
  check("自动同步间隔 ≥5 分钟（原 3 分钟）",
    autoMatch !== null && Number(autoMatch[1]) >= 5, `${autoMatch ? autoMatch[1] : "?"} 分钟`);

  const statusMatch = /refreshNotiStatus, (\d+)\)/.exec(htmlSrc);
  check("notify-status 轮询 ≥60 秒（原 30 秒）",
    statusMatch !== null && Number(statusMatch[1]) >= 60000, `${statusMatch ? statusMatch[1] : "?"} ms`);

  // limit 得诚实：`list --limit=5` 不能再被 Math.max(numLimit, 50) 放大成 50 封真实抓取
  check("ClawEmail 列表不再无条件把 limit 放大到 50",
    !/queryParams = \{ fid, limit: Math\.max\(numLimit, 50\) \}/.test(cwSrc) && cwSrc.includes("hasPostFilter"));

  // `since` / `before` 会被 SDK 静默丢弃（打包产物里是硬编码参数白名单）——
  // 它不是“已支持但没人用”，是“看着能用、实际什么都不做”。留条 tripwire。
  check("★ since/before 失效这件事在源码里有警告（SDK 静默丢弃）",
    cwSrc.includes("传下去是**无效的**"));

  // ★ 列表必须**显式**要倒序。
  //   order/desc 在 SDK 的参数名单里、是透传的；不给就是 undefined，
  //   服务端按默认序（升序）返回，而 limit 截掉的是**最新**那头 ——
  //   “最新 50 封”于是变成“最旧 50 封”，新邮件永远不会出现。
  //   2026-09-22 用真实账号实测：不传 → 05-04~05-14；传 → 09-22~08-06。
  check("★ ClawEmail 列表显式要求按日期倒序（否则拿到的是最旧的 50 封）",
    /order:\s*"date"/.test(cwSrc) && /desc:\s*true/.test(cwSrc));

  // ★ 依赖清单只能有一份，而且不能手写。
  //   手写的会烂：0.6.0 把 imap 换成 imapflow 时，http/ui.js 里两份硬编码探针
  //   没跟着改，于是一条“IMAP 依赖未安装”把 QQ 邮箱的同步整条挡住——而依赖其实齐着。
  check("★ 后端依赖判定不硬编码包名（imap→imapflow 那次就是这样烂的）",
    !/node_modules"\s*,\s*"imap"/.test(uiSrc));
  check("★ AppHost 侧与运行时共用同一份依赖判定",
    /missingBackendDeps/.test(uiSrc) && /missingBackendDeps/.test(svcSrc));

  // ★ 声明了却从不赋值 —— 这种烂法编译器和 node --check 都看不见。
  //   _profile 被 serviceProfile() 读走，而卡片的降级提示靠它判是否显示。
  check("★ 实际生效的 profile 会写回 _profile（否则降级提示永远不显示）",
    /_profile\s*=\s*rec\?\.profile\s*\|\|\s*profile/.test(rtHost));

  // ★ 服务进程死掉后要能自愈。
  //   以前 `_state` 只在 doStart() 内部被写，进程死时没人改它，
  //   于是 doStart 的 `if (_state === "ready") return true` 永远短路，
  //   而 fetch 报错也不改 _state —— 每 60 秒重复一句 poll fail，永远。
  check("★ 服务已不在时会作废就绪状态并就地补一次（callService 自愈）",
    /isRuntimeGoneError/.test(rtHost) && /markRuntimeGone/.test(rtHost)
    && /if \(!\(await doStart\(\)\)\) return \{ ok: false, error: msg \}/.test(rtHost));

  // 死代码哨兵：合并后曾留下一个没人调用的 startWith
  check("★ 没有 orphan 的 startWith 启动包装",
    !/const startWith = \(profile\)/.test(rtHost));
}

dispose();
fs.rmSync(home, { recursive: true, force: true });

const mailHtml = fs.readFileSync(path.join(ROOT, "ui", "mail.html"), "utf-8");
// 403 的 body 是 {error:"forbidden",reason:"missing_credential"}，没有 ok 字段，
// 旧的 `d.ok === false` 判据抓不住它，于是被当「暂无账号」渲染。
check("卡片把 HTTP 错误转成可读 rejection", mailHtml.includes("function apiExpectingOk"));
check("卡片校验 data 必须是数组（而非 d.data || []）", mailHtml.includes("Array.isArray(d.data)"));
// 卡片凭据：宿主把 sessionToken 放在自己 URL 的路径里（/ui/_surface/<token>/），
// 只取 ?token= 会永远拿到 null → 所有调用 403 → 静默成「暂无账号」。
check("卡片从自己 URL 路径提取 surface session token",
  mailHtml.includes("ui\\/_surface\\/"));
check("卡片把 token 放进 X-Hana-App-Surface-Session 头", mailHtml.includes("X-Hana-App-Surface-Session"));
check("附件/图片代理 URL 改走 appSurfaceSession 查参数", mailHtml.includes("appSurfaceSession="));

// ── 跳转链接与通知回跳（2026-10-02）─────────────────
// 正文 iframe 的 sandbox 只有 allow-popups：没有 allow-top-navigation 就没人拦得到外链，
// <a> 不补 target 就会在正文框【内部】导航，把邮件本体换成目标网页。
check("★ 正文链接由 rewriteLinks 补 target，且真的被调用",
  /function rewriteLinks\(/.test(mailHtml) && mailHtml.includes("rewriteLinks(rewriteImages("));
// openDetail 以前只声明 messageId，两个调用点却传了三个参数，accountId 被静默丢弃——
// 多账号下停在 A 点 B 的通知，就会拿 A 的身份去取 B 的邮件。
check("★ openDetail 声明并用上了 accountId / folderId",
  /function openDetail\(messageId, accountId, folderId\)/.test(mailHtml) &&
  mailHtml.includes("encodeURIComponent(aid)"));
// 正文框底色写死 #fff：srcdoc 的 body 只铺到内容高度，内容短时底部露白，深色主题下更明显。
check("★ 正文 iframe 不硬编码白底",
  !/\.mail-body-frame\s*\{[^}]*background:\s*#fff/.test(mailHtml));
// 纯文本正文以前 textContent 直出，裸 URL 不可点（验证码、激活链接一概如此）。
check("★ 纯文本正文做 linkify", mailHtml.includes("linkifyTextInto(box.querySelector"));
// folder 必须一路带到点击回跳：卡片轮询的是用户当前浏览的文件夹，不恒为 INBOX。
const notifySvc = fs.readFileSync(path.join(ROOT, "runtime", "service.mjs"), "utf-8");
const notifyDrain = fs.readFileSync(path.join(ROOT, "lib", "notify-drain.mjs"), "utf-8");
const notifyUi = fs.readFileSync(path.join(ROOT, "http", "ui.js"), "utf-8");
check("★ folder 从卡片透传进通知队列",
  notifyUi.includes("folder: body.folder") && notifySvc.includes("folder: payload.folder"));
check("★ folder 进 arm meta 并写进点击记录",
  notifySvc.includes("folder: body.folder") &&
  notifySvc.includes('folder: meta?.folder || "INBOX"'));
check("★ 派发器 arm 时带上 folder", notifyDrain.includes("folder: one.folder"));
check("★ 卡片回跳优先用点击记录里的 folder，不拿当前浏览的顶替",
  /d\.data\.folder \|\| ['"]INBOX['"]/.test(mailHtml));

// ── AI 走宿主契约（v0.6.13）─────────────────────────
// 旧路径（读 provider-catalog + bus 取凭据 + 借服务代发 HTTP + 自己分两种协议拼请求）
// 整块删了：app/models.infer 的语义就是「凭据由宿主保管」，插件侧不该再有那一套。
// 这组断言守的是「别把旧路径改回来」。
const modelHost = fs.readFileSync(path.join(ROOT, "lib", "model-host.mjs"), "utf-8");
const llmSrc = fs.readFileSync(path.join(ROOT, "backend", "llm.mjs"), "utf-8");
const manifestCaps = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf-8")).capabilities || [];

check("★ 模型列表只来自宿主契约，旧数据源一个字不剩",
  notifyUi.includes("listHostModels()") &&
    !/getProviderCatalog|resolveLlmConfig|listChatModels|provider-catalog|PROVIDER_PRESETS/.test(codeOnly(notifyUi)));
check("★ 推理只有一个入口 inferText（门一直连只是它的兜底分支，不是另一套调用链）",
  /async function runAi/.test(notifyUi) && notifyUi.includes("llm.pingPrompt") &&
    !/chatCompletion|net-child|summarizeMail\(|translateMail\(/.test(codeOnly(notifyUi)) &&
    !/inferDirect/.test(codeOnly(notifyUi)));
check("★ backend/llm.mjs 只剩提示词，碰不到 baseUrl / apiKey / 网络",
  !/postJson|fetch\(|baseUrl|apiKey|hostConfig|net-child/.test(codeOnly(llmSrc)) &&
    llmSrc.includes("summarizePrompt") && llmSrc.includes("translatePrompt"));
check("★ 标识符规则只用于标注，不拿它删用户自己加的模型",
  /normalizedModels/.test(modelHost) && /hostIdOk/.test(modelHost) &&
    !/sendableModels/.test(codeOnly(modelHost)) &&
    !/不满足宿主标识符要求[\s\S]{0,80}return/.test(codeOnly(modelHost)));
check("★ 推理不做本地预检，能不能用由宿主说了算",
  !/if \(!isSendable\(\{ provider, id: model \}\)\)/.test(codeOnly(modelHost)));
check("★ 宿主模型层静默挂住这条，有超时 + cancel 兜着",
  /内没有响应/.test(modelHost) && /models\.cancel\(requestId\)/.test(modelHost));
check("★ 空返回要说出来，不能长得像成功",
  modelHost.includes("模型没有返回正文"));
check("★ 三条模型相关能力位全要（门一不收的名字由门二兜）",
  manifestCaps.includes("app/models.infer") &&
    manifestCaps.includes("app/models.read") &&
    manifestCaps.includes("app/provider.credentials.read"));

// ── 门二：直连兜底（v0.6.15）──────────────────────
// 实测事实：宿主 ctx.models 对 provider 做 ASCII 校验（bundle 里的 tg()），
// 而 bus 的 provider:credentials 只把 providerId 当查表键 —— 中文名在门一进不去、
// 在门二能用。只要门一，用户自己加的「中文provider」这类供应商就永远用不了。
const llmDirect = fs.readFileSync(path.join(ROOT, "backend", "llm-direct.mjs"), "utf-8");
check("★ 门二存在且拿凭据只走 bus，不去读 HANA_HOME 里的目录",
  /async function fetchCredentials/.test(llmDirect) &&
    llmDirect.includes('"provider:credentials"') &&
    !/provider-catalog|getProviderCatalog|readFileSync/.test(codeOnly(llmDirect)));
check("★ 门二的出站借受管服务（AppHost 本身没有网）",
  llmDirect.includes('callService("/http"'));
check("★ 凭据取到后不出模块边界（fetchCredentials 不导出，ui.js 调不到它）",
  !/export async function fetchCredentials/.test(llmDirect) &&
    !/fetchCredentials/.test(codeOnly(notifyUi)));
check("★ LLM 相关响应不回 apiKey（邮箱账号自己的 apiKey 不算，那走另一套加密）",
  !/ok: true[^\n]*apiKey/.test(codeOnly(notifyUi)));
check("★ 门一失败回落门二，但超时不回落（重试等于两次请求两份钱）",
  /if \(!timedOut && _ctx\)/.test(modelHost));
check("★ 门一失败回落门二，但超时不回落（重试等于两次请求两份钱）",
  /bus-after-gate1-fail/.test(modelHost) && /if \(!timedOut && _ctx\)/.test(modelHost));
check("★ 列表是两扇门合流，不再只报「过滤了多少」",
  notifyUi.includes("fromContract") && notifyUi.includes("fromBus") &&
    !/suspectIds/.test(codeOnly(notifyUi)));
check("★ 推理不做本地硬拒，名字不合规则就换门而不是报错",
  /if \(!hostAccepts\(provider, model\)\)/.test(modelHost) &&
    !/不满足宿主标识符要求.*return \{\s*ok: false/.test(codeOnly(modelHost)));
check("★ 旧模块确实已从包里移除",
  !fs.existsSync(path.join(ROOT, "backend", "hana-llm.mjs")) &&
    !fs.existsSync(path.join(ROOT, "backend", "net-child.mjs")));

console.log(`\nsmoke-load: ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
