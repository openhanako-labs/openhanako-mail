/**
 * lib/runtime-host.mjs — 受管邮件服务的宿主侧句柄。
 *
 * AppHost 里没有网络、也读不到安装目录之外的任何文件（见 runtime/service.mjs 顶部
 * 的长注释）。所以 AppHost 只做三件事：注册工具、挂路由、把要干活的请求转发给
 * 那个受管 native 服务。这个文件就是「转发」那一半。
 *
 * 持有 module-level 的单例 ctx，是为了让 tools/*.js、http/ui.js 这些**拿不到 ctx**
 * 的老代码能直接 call() —— 与 backend/cred-crypto.mjs 的 setCryptoDataDir 同一套路数。
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { APP_ID, PLUGIN_ROOT } from "./env.mjs";

/** 服务监听端口。换值要同时确认没有别的 App 占用。 */
export const SERVICE_PORT = Number(process.env.HANA_MAIL_SERVICE_PORT) || 43179;
export const READY_MARKER = "HANA_MAIL_SERVICE_READY";

/**
 * 把路径解析成不含符号链接的真实路径。
 *
 * 背景：宿主 native-identity 创建受管沙箱时会对路径做 realpath，路径上只要有
 * reparse point（例如 %USERPROFILE%\.hanako 本身是个 symlink），就会报
 * "[native-identity] reparse root is not supported (Win32 0)" 并拒绝启动。
 * 这里把传给 runtime.start 的 entry / cwd / args 都解成真实路径。
 *
 * 注意：经实测这**并不能**绕过上面的报错——宿主另有一处自己解析的路径
 * （App 注册根 / HANA_HOME），应用侧碰不到。保留它是因为：能传真实路径就传，
 * 至少不把 reparse 风险往下游推。解析失败时原样返回，保持原有行为。
 */
function realpath(p) {
  if (!p || typeof p !== "string") return p;
  try {
    const r = fs.realpathSync(p);
    return r && r !== p ? r : p;
  } catch {
    return p;
  }
}

/**
 * 按错误类型给排查提示。
 *
 * 此前无论什么错都提示「缺 app/runtime.* 授权」，而实测最常见的失败是宿主
 * 侧的路径问题（native-identity 遇 reparse point），两者完全无关——按那个
 * hint 查会查错方向。
 */
function hintFor(err) {
  const s = String(err || "");
  if (/native-identity|reparse root/i.test(s)) {
    return "宿主创建受管沙箱身份失败：HANA_HOME 上存在符号链接/重解析点，"
      + "sandbox helper 直接拒绝。应用已尝试降级到 local-machine profile（无沙箱）——"
      + "若那条也失败，通常是缺 app/runtime.local-machine 授权。"
      + "彻底修复要在宿主侧改 native-identity 的 realpath，"
      + "或把 %USERPROFILE%\\.hanako 换成非 reparse 的实际目录。";
  }
  if (/EADDRINUSE/i.test(s)) {
    return "端口被占用：127.0.0.1:" + SERVICE_PORT + " 已被其他进程监听，换个端口或关掉占用者。";
  }
  if (/EACCES|EPERM|denied/i.test(s)) {
    return "沙箱权限不足：确认 app/runtime.execute + app/runtime.native + app/runtime.network 三项授权已授予。";
  }
  return "需要 app/runtime.execute + app/runtime.native + app/runtime.network 三项授权；缺任一项都会在这里被拒。";
}

/** 受管服务入口文件的绝对真实路径；解析不到时退回原来的相对路径。 */
const ENTRY_PATH = (() => {
  const abs = path.join(realpath(PLUGIN_ROOT), "runtime", "service.mjs");
  try {
    return fs.existsSync(abs) ? fs.realpathSync(abs) : "runtime/service.mjs";
  } catch {
    return "runtime/service.mjs";
  }
})();

/**
 * 受管运行时的 profile 降级链。
 *
 * "native" 有沙箱（win32-restricted-token），但宿主建沙箱时把 HANA_HOME 当作
 * nativeIdentityHome 传给 Windows sandbox helper；HANA_HOME 上只要有符号链接 /
 * 重解析点（例如 %USERPROFILE%\.hanako 是指向别的盘的 symlink），helper 就直接报
 * "[native-identity] reparse root is not supported (Win32 0)" 并拒绝启动。
 * 那个 HANA_HOME 是宿主自己解析的，应用侧碰不到。
 *
 * "local-machine" 不走 nativeIdentityHome，用 normal-token Job + 当前桌面，
 * enforcement 为 none —— **没有文件系统沙箱**。
 *
 * 所以降级链是 native → local-machine：能上沙箱就上沙箱，上不了就换无沙箱，
 * 好过邮件功能整个不可用。降级发生时日志里必须说清安全含义。
 * manifest 需要同时声明 app/runtime.native 与 app/runtime.local-machine。
 */
const RUNTIME_PROFILES = ["native", "local-machine"];

/** 只有沙箱身份类错误才值得换 profile 重试；端口冲突之类换 profile 是白费。 */
function shouldFallThrough(msg) {
  return /native-identity|reparse root|sandbox/i.test(String(msg || ""));
}

/**
 * ctx.runtime.fetch 的 timeoutMs 上限。
 *
 * 宿主管得很死：必须是 1..30000 的整数，超出直接拒（实测报
 * "Runtime fetch timeoutMs must be an integer from 1 through 30000"）。
 * 传 120000 会被抛掉 —— 而这个接口是用来转发 email 命令的，一抛就是全链失败。
 */
const SERVICE_FETCH_TIMEOUT_MS = 30000;

/** ctx.runtime.fetch 的请求体上限是 1 MiB（UTF-8），留点余量。 */
const MAX_BODY_BYTES = 900 * 1024;

/** 启动失败后的冷却时间，避免失败时被轮询反复拉起进程。 */
const RETRY_COOLDOWN_MS = 30000;
const MAX_CONSECUTIVE_FAILURES = 3;  // 连续失败 3 次后进入休眠
const DORMANT_TIMEOUT_MS = 10 * 60 * 1000; // 休眠 10 分钟后再试
let _lastFailureAt = 0;
let _consecutiveFailures = 0;
let _dormantUntil = 0;

/**
 * 启动就绪的超时。
 *
 * 不再长等依赖安装：服务现在不等 npm 就绪就先打 ready（依赖装好后再起监听），
 * 所以这个值关系到的是进程能不能起来，不是 npm 快不快。15 秒足够。
 */
const READY_TIMEOUT_MS = 15000;

let _ctx = null;
let _runtimeId = null;
let _startArgs = null;      // { dataDir, legacyDir } —— 惰性重启要用
let _starting = null;       // in-flight promise，防并发重复拉起
// 日志用 v1 形状的 { info, warn, error }（由 lib/legacy-ctx.mjs 包装），不是单个函数。
let _log = { info: () => {}, warn: () => {}, error: () => {} };
let _state = "idle"; // idle | starting | ready | failed
let _profile = ""; // 实际生效的 profile：native 失败时会降级到 local-machine

function logInfo(msg, data) { try { _log.info(msg, data); } catch { /* ignore */ } }
function logWarn(msg, data) { try { _log.warn(msg, data); } catch { /* ignore */ } }
function logError(msg, data) { try { _log.error(msg, data); } catch { /* ignore */ } }

// 调用方密钥：每次拉起服务前在 doStart 里重新生成 randomBytes(32).hex，
// 经 argv 第 5 位传给服务、并在 callService 的 fetch 头里带上 X-Hanako-Service-Key。
// 受管运行时的 env 是宿主白名单，token 不能走环境变量。
let _serviceToken = "";

/**
 * 宿主说“运行时手里这个 runtimeId 已经没有就绪服务了” —— 也就是服务进程死了。
 * 宿主原话：`Managed runtime "<id>" does not have a ready service.`
 */
function isRuntimeGoneError(msg) {
  return /does not have a ready service|no ready service|runtime .{0,40}(not found|does not exist)|ECONNREFUSED|socket hang up/i
    .test(String(msg || ""));
}

/**
 * ★ 作废“服务就绪”这个信念。这是实测暴露的洞：
 *
 * `_state` 只在 `doStart()` 内部被写（`_state = ok ? "ready" : "failed"`）。
 * 服务进程死掉时**没有任何代码改它**，于是：
 *   · `doStart()` 开头的 `if (_state === "ready" && _runtimeId) return true;` 永远短路；
 *   · 每次调用都直接 `runtime.fetch` → 拿到 “does not have a ready service” → 报错；
 *   · 而报错也不改 `_state` → 下一次一模一样。
 *
 * 每 60 秒重复一遍，永远。唯一的恢复方式变成重启整个 Hana。
 * 而界面看起来“还活着”（列表读的是磁盘缓存，不经过服务），只有日志里那句 poll fail。
 */
function markRuntimeGone(reason) {
  if (_state === "ready") {
    logWarn("邮件后端服务已不在，作废就绪状态", { reason, willRestartOnNextCall: true });
  }
  _state = "failed";
  _runtimeId = null;
  // 冷却是用来防“启动一直失败被轮询反复拉起”的；这里是服务**死了**，不是启动失败，
  // 所以立刻允许重启。若重启再失败，doStart 自己会把 _lastFailureAt 记上，冷却照旧生效。
  _lastFailureAt = 0;
}

export function serviceState() {
  return _state;
}

/** 实际生效的 profile。native 建不起沙箱时会降级到 local-machine。 */
export function serviceProfile() {
  return _profile;
}

export function serviceRuntimeId() {
  return _runtimeId;
}

/** 暴露给前端用的路径前缀（浏览器直连服务时用；本应用目前只走 AppHost 转发）。 */
export function serviceProxyPrefix() {
  return _runtimeId ? `/api/apps/${APP_ID}/routes/_runtime/${_runtimeId}` : "";
}

/**
 * 启动受管服务并等它就绪。
 * @param {object} ctx v2 App ctx
 * @param {{dataDir:string, legacyDir:string, log:Function}} opts
 */
export async function startService(ctx, { dataDir, legacyDir, log }) {
  _ctx = ctx;
  if (log) _log = log;
  _startArgs = { dataDir, legacyDir };
  return await doStart();
}

/**
 * 真正拉一次服务。
 *
 * 为什么它可能失败、而之后又该能成功：**装载与权限记账之间有窗口**。实测
 * 首次装载时 `apply()` 跑在 `23:58:44.097`，而 `app/runtime.execute` 写进账本
 * 是 `23:58:44.287` —— 晚了约 190ms，于是第一次申请必然被拒，而 apply 只跑一次。
 * 所以失败不当作终态：记住启动参数，等第一次真调用时再试（见 callService）。
 */
async function doStart() {
  if (!_ctx || !_startArgs) return false;
  if (_state === "ready" && _runtimeId) return true;
  if (_starting) return await _starting;
  // 刚失败过就先歇一会儿：调用方多是定时轮询（auto_sync / poll），
  // 不加冷却会在失败时反复 spawn 进程、反复跑 npm install。
  if (_lastFailureAt && Date.now() - _lastFailureAt < RETRY_COOLDOWN_MS) {
    return false;
  }
  // 连续失败多次后进入休眠，避免权限缺失时持续消耗 CPU。
  // 权限问题不会自动修复，重试只是浪费资源。
  if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    if (Date.now() < _dormantUntil) {
      return false;
    }
    // 休眠时间到了，允许再试一次（万一用户中途补了授权）
    _consecutiveFailures = 0;
    logInfo("邮件后端服务休眠结束，尝试重新启动", { dormantForMs: DORMANT_TIMEOUT_MS });
  }

  const { dataDir, legacyDir } = _startArgs;
  _state = "starting";

  // 注：这里曾有一个 `startWith(profile)` 包装。合并取上游的 RUNTIME_PROFILES 循环版后
  // 它没人调用了（循环里直接 _ctx.runtime.start），本版删掉 ——
  // 留着会让人以为还有第二条启动路径。

  _starting = (async () => {
    const realDataDir = realpath(dataDir);
    const realLegacyDir = realpath(legacyDir || "");
    // 每次拉起服务前重新生成调用方密钥（重启即轮换）；与服务共享、面板/浏览器不需持有。
    _serviceToken = randomBytes(32).toString("hex");
    let lastErr = null;

    for (let i = 0; i < RUNTIME_PROFILES.length; i++) {
      const profile = RUNTIME_PROFILES[i];
      try {
        const rec = await _ctx.runtime.start({
          runtime: "node",
          // 绝对真实路径：解析失败时退回原相对路径。
          entry: ENTRY_PATH,
          // 参数走 args，不走 env —— 受管运行时的 env 也是宿主的白名单。
          // 末位追加调用方密钥（argv[5]），供服务做 G1 常时比较鉴权。
          args: [realDataDir, realLegacyDir, String(SERVICE_PORT), _serviceToken],
          profile,
          network: "external",
          cwd: realDataDir,
          service: { port: SERVICE_PORT, readyMarker: READY_MARKER },
        });
        _runtimeId = rec?.runtimeId ?? null;
        // serviceProfile() 读的就是 _profile，而卡片的降级提示依赖它：
        // mail.html 里 `if (d.serviceProfile && d.serviceProfile !== 'native')`
        // 才显示「运行 profile：…」。下降重写成数组循环时漏了这句赋值，
        // 于是 _profile 恒为空、那个提示永远不显示 ——
        // 一个安全相关的降级提示被静默吞掉了。
        _profile = rec?.profile || profile;
        if (profile === "native") {
          logInfo("邮件后端服务已启动", { runtimeId: _runtimeId, profile: rec?.profile, enforcement: rec?.enforcement, port: SERVICE_PORT });
        } else {
          // 降级必须说清代价，否则日志看起来像一切正常。
          logWarn("邮件后端已降级到无沙箱 profile 启动", {
            profile,
            enforcement: rec?.enforcement,
            port: SERVICE_PORT,
            reason: "native 沙箱身份创建失败（HANA_HOME 上有符号链接/重解析点）",
            tradeoff: "local-machine 的 enforcement 是 none：没有文件系统沙箱，"
              + "服务进程以当前用户权限运行，只受网络白名单约束。"
              + "换来的是邮件功能可用；宿主修好 native-identity 后可以改回只走 native。",
          });
        }

        // 就绪要等服务的 stdout 打出 marker，start() 本身是立即返回的。
        const ok = await waitReady(READY_TIMEOUT_MS);
        _state = ok ? "ready" : "failed";
        if (!ok) {
          // 沙箱已经建起来了，服务没起来是另一回事，换 profile 无意义。
          _lastFailureAt = Date.now();
          logError(`邮件后端服务未在 ${Math.round(READY_TIMEOUT_MS / 1000)} 秒内就绪，邮件功能不可用`, { runtimeId: _runtimeId, profile });
          return false;
        }
        _lastFailureAt = 0;
        _consecutiveFailures = 0;
        return true;
      } catch (e) {
        lastErr = e;
        const msg = e?.message || String(e);
        logError("邮件后端服务启动失败", { profile, error: msg, hint: hintFor(msg) });
        // 非沙箱类错误（端口占用、缺授权、参数非法）换 profile 也是同样的错，别再试。
        if (!shouldFallThrough(msg) || i === RUNTIME_PROFILES.length - 1) break;
        logWarn("沙箱 profile 不可用，尝试降级", {
          from: profile,
          to: RUNTIME_PROFILES[i + 1],
          error: msg,
        });
      }
    }

    _state = "failed";
    _runtimeId = null;
    _profile = ""; // 全部 profile 都没起来，别再报上一个尝试的 profile
    _lastFailureAt = Date.now();
    _consecutiveFailures++;
    const shouldDormant = _consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
    if (shouldDormant) {
      _dormantUntil = Date.now() + DORMANT_TIMEOUT_MS;
    }
    logError("邮件后端服务启动失败（邮件功能不可用）", {
      error: lastErr?.message || String(lastErr),
      consecutiveFailures: _consecutiveFailures,
      willDormant: shouldDormant,
      dormantForMs: shouldDormant ? DORMANT_TIMEOUT_MS : null,
      hint: hintFor(lastErr?.message),
    });
    return false;
  })().finally(() => { _starting = null; });

  return await _starting;
}

/** 服务是否可用（供 UI 显示状态）。 */
export function isServiceReady() {
  return _state === "ready";
}

async function waitReady(timeoutMs) {
  if (!_runtimeId || !_ctx) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let rec = null;
    try { rec = await _ctx.runtime.get(_runtimeId); } catch { /* 继续重试 */ }
    if (rec?.state === "ready") return true;
    if (rec?.state === "failed" || rec?.state === "exited" || rec?.state === "stopped") {
      // 把宿主捕获的服务输出一起报出来 —— 否则这里只剩一句“未就绪”，
      // 而真正的错因（入口路径、缺失文件、启动期异常）全在 rec.log 里。
      logError("邮件后端服务提前退出", {
        runtimeId: _runtimeId,
        state: rec.state,
        exitCode: rec.exitCode,
        signal: rec.signal,
        enforcement: rec.enforcement,
        output: String(rec.log || "").slice(-1500) || "(宿主未捕获到输出)",
      });
      return false;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** 停掉受管服务（apply 的 disposer 里调用）。 */
export async function stopService() {
  if (!_runtimeId || !_ctx) return;
  try {
    await _ctx.runtime.stop(_runtimeId);
    logInfo("邮件后端服务已停止");
  } catch (e) {
    logWarn("停止邮件后端服务失败", { error: e?.message });
  }
  _runtimeId = null;
  _state = "idle";
}

/**
 * 调一次服务。
 * @param {string} route 形如 "/cli"
 * @param {object} payload JSON 负载
 * @returns {Promise<object>} 服务返回的 JSON；失败时返回 { ok:false, error }
 */
export async function callService(route, payload = {}) {
  if (!_ctx) return { ok: false, error: "mail service unavailable（apply 尚未运行）" };

  // 惰性自愈：首次装载时权限可能还没记账（实测差约 190ms），那时 startService 被拒。
  // 第一次真调用时补起，用户就不必手动“重新加载”应用。
  if (_state !== "ready" || !_runtimeId) {
    const ok = await doStart();
    if (!ok) return { ok: false, error: "mail service unavailable（启动未成功）" };
  }

  let body;
  try {
    body = JSON.stringify(payload);
    if (Buffer.byteLength(body, "utf-8") > MAX_BODY_BYTES) {
      // ponytail: 单次请求硬上限 1 MiB。超大邮件正文只截断送去总结/翻译，
      //          需要完整原文时按 messageId 分块取。
      return { ok: false, error: "payload too large for runtime bridge" };
    }
  } catch (e) {
    return { ok: false, error: "payload not serializable: " + e.message };
  }

  const once = async () => {
    const res = await _ctx.runtime.fetch(_runtimeId, route, {
      method: "POST",
      // 调用方密钥：服务侧做 timingSafeEqual 常时比较。token 缺失（旧版 AppHost 配新版服务）
      // 时服务 fail-closed 全部 403。
      headers: { "content-type": "application/json", "x-hanako-service-key": _serviceToken },
      body,
      timeoutMs: SERVICE_FETCH_TIMEOUT_MS,
    });

    // ctx.runtime.fetch 返回的是**真正的 Response 对象**（宿主内部 new Response(...)），
    // 不是字符串也不是 JSON。取 res.body 会拿到 ReadableStream —— JSON.parse 必败，
    // 实测报“service returned non-json”。必须走 res.text()/res.json()。
    let text;
    if (typeof res === "string") text = res;
    else if (typeof res?.text === "function") text = await res.text();
    else if (typeof res?.json === "function") text = JSON.stringify(await res.json());
    else text = String(res ?? "");

    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: "service returned non-json", raw: String(text).slice(0, 300) };
    }
  };

  try {
    return await once();
  } catch (e) {
    const msg = e?.message || String(e);
    if (!isRuntimeGoneError(msg)) return { ok: false, error: msg };

    // ★ 服务进程已经死了，而 _state 还停在 "ready"。作废那个信念，并**就地补一次**——
    //   否则这一次调用只是又一句 poll fail，而下一次（60 秒后）会一模一样地重复。
    markRuntimeGone(msg);
    if (!(await doStart())) return { ok: false, error: msg };
    try {
      return await once();
    } catch (e2) {
      return { ok: false, error: e2?.message || String(e2) };
    }
  }
}
