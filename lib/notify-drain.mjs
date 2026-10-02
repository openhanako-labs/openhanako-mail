/**
 * lib/notify-drain.mjs — 把服务排队的桌面通知派发出去。
 *
 * 为什么需要这一层：**这个理由已经被实测推翻了，但这一层暂时留着。**
 *
 * 原来的说法是：Windows 通知必须拉起一个进程，而受管 native 服务不能 spawn
 * （Job Object，实测 spawn EPERM）—— 能 spawn 的 AppHost 收不到邮件事件，
 * 收得到事件的服务又不能 spawn，所以只好用一个磁盘队列把两边接起来。
 *
 * ⚠ 那句 EPERM 是在服务跑 native profile 时测的。现在 native 永远建不起来
 *（HANA_HOME 是符号链接），服务实际跑在降级后的 local-machine（enforcement: none），
 * 2026-09-22 实探**可以** spawn（唯一真相来源：runtime/service.mjs 的 probeSpawn）。
 *
 * 也就是说：服务完全可以自己拉起 mail-toast.cjs，不需要队列、不需要 5 秒轮询、
 * 不需要投递确认往返。这件事没做，只因为**现在这条链路是端到端验证过的**
 *（真弹出过窗口、真记录了点击），重写要把它整个重验一遍 ——
 * 它属于「简化机会」，不属于「修复」。哪天真要动通知，这里就是该合并的地方。
 *
 * 现状（暂时保留的两半）：
 *   服务（收得到邮件）→ 把要发的通知写进 `<dataDir>/_pending_notify/`
 *   AppHost（能 spawn）→ 定时向服务取队列并拉起 mail-toast.cjs
 *
 * 5 秒一轮，所以通知延迟最多 5 秒 —— 比 60 秒的轮询兜底更快，
 * 也避免了「实时监听秒级、通知却慢一分钟」的割裂。
 *
 * ── 两处踩过的坑，这次的改法都在这份文件里 ──
 *
 * 1) **队列不能「取走即删」。** 原来 `/pending-notify` 读完就 unlink，而删除发生在
 *    toast 被拉起**之前**，于是只要发送失败，这条通知就永久消失，只在日志留一行 warn。
 *    实测两次失败（09-20 23:15、09-21 19:06）都是这么丢的。
 *    现在改为：读取不删 → 发完确认 → `/notify-ack` 才删。
 *
 * 2) **不能靠退出码判断有没有发出去。** 实测 SnoreToast 在通知已经弹出的情况下
 *    仍返回 -1（0/1/2/3 与 -1 的边界不可靠）。所以判断依据换成助手自己写下的
 *    投递记录 `<dataDir>/notify-last-result.json`（见 helper/mail-toast.cjs 的
 *    markAttempt）：本次 spawn 之后出现过 attempted 记录，才算投递已尝试。
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { callService } from "./runtime-host.mjs";
import { PLUGIN_ROOT, runtimeDataDir } from "./env.mjs";

const POLL_MS = 5000;
// 等「投递记录出现」的窗口；超过就交给硬上限判负。
// 不直接等子进程退出 —— 带点击回调的助手弹出通知后还要活着等管道事件（可能十几秒）。
const RESULT_WAIT_MS = 4000;
const HARD_WAIT_MS = 9000;
// 一轮派发超过这个时长就认为是卡住了。
// 为什么要这个：callService 的 timeoutMs 上限是 30 秒，而轮询周期 5 秒——
// 服务挂起时 draining 会长时间为真，后续轮次全被跳过且不留任何痕迹。
const STUCK_MS = 45000;
const TOAST_SCRIPT = path.join(PLUGIN_ROOT, "helper", "mail-toast.cjs");
const TOAST_NODE_PATH = path.join(PLUGIN_ROOT, "backend", "node_modules");

let timer = null;
let draining = false;
let drainingSince = 0;

/** 最近一轮的派发结果，供 notificationStatus() 与 /notify-status 读取。 */
const last = { at: 0, ok: 0, failed: 0, error: "", snoreError: "" };

function resultFile() {
  return path.join(runtimeDataDir(), "notify-last-result.json");
}

function readAttempt() {
  try {
    return JSON.parse(fs.readFileSync(resultFile(), "utf-8"));
  } catch {
    return null;
  }
}

/** 拉起一次 toast 助手。返回 { ok, attempted, method, error }。 */
function spawnToast(item, pipeName) {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(TOAST_SCRIPT)) {
        resolve({ ok: false, attempted: false, method: "", error: "mail-toast.cjs missing" });
        return;
      }
      const workDir = runtimeDataDir();
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const argsFile = path.join(workDir, `notify-args-${id}.json`);
      fs.writeFileSync(argsFile, JSON.stringify(item), "utf-8");

      const startedAt = Date.now();
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        try { fs.unlinkSync(argsFile); } catch { /* ignore */ }
        resolve(r);
      };

      // 只认这次 spawn 自己的记录。
      //
      // 结果文件是全局共享的（一个固定文件名），而 `sendTestNotification` 不走
      // draining 标志 —— 两个 helper 并发时后写的会覆盖先写的，于是：
      //   · 测试记录的时间戳晚于某一轮 drainOnce → 被判成“这一轮成功” → 误 ack 删掉真通知；
      //   · 反之 → 真投递被判失败 → 不 ack → 5 秒后重发 → 重复弹。
      // --result-id 把两种情形都堵死。
      const ourRecord = () => {
        const rec = readAttempt();
        return rec && rec.resultId === id ? rec : null;
      };

      const toastArgv = [TOAST_SCRIPT, "--args-file", argsFile, `--work-dir=${workDir}`, `--result-id=${id}`];
      // 点击管道的名字由服务给（AppHost 子进程没有 net 权限，建不了管道），
      // 这里只把它转交给助手，让它填进 SnoreToast 的 -pipeName。
      if (pipeName) toastArgv.push(`--pipe-name=${pipeName}`);

      const child = execFile(process.execPath, toastArgv, {
        cwd: PLUGIN_ROOT,
        windowsHide: true,
        // 比助手的 MAX_LIFE_MS（25 秒）大：带点击回调时它要活着等管道事件，
        // 这里把 timeout 设小就等于把点击掐掉。
        timeout: 40000,
        // AppHost 本身在权限模型里，本进程只允许 spawn（--allow-child-process）。
        // 子进程要读 mail-toast.cjs 与 node-notifier，那条路径在只读白名单内；
        // 它要写的一切都落在 --work-dir（app-data），同样在写白名单内。
        env: { ...process.env, NODE_PATH: TOAST_NODE_PATH },
      }, (err) => {
        const rec = ourRecord();
        finish({
          ok: !!rec || !err,
          attempted: !!rec,
          method: rec?.method || "",
          snoreError: rec?.snoreToastError || "",
          error: err ? String(err.message).split("\n")[0] : "",
        });
      });
      child.unref?.();

      // 只要（本次的）投递记录出现就算本轮已投递，不等子进程退出。
      const waitRecord = () => {
        if (done) return;
        const rec = ourRecord();
        if (rec) {
          finish({ ok: true, attempted: true, method: rec.method || "", snoreError: rec.snoreToastError || "", error: "" });
          return;
        }
        if (Date.now() - startedAt < RESULT_WAIT_MS) setTimeout(waitRecord, 150);
      };
      setTimeout(waitRecord, 150);

      // 硬上限：任何情况下都不能把这一轮卡住。
      const guard = setTimeout(() => {
        finish({ ok: false, attempted: false, method: "", error: "未在期限内看到投递记录" });
      }, HARD_WAIT_MS);
      guard.unref?.();
    } catch (e) {
      resolve({ ok: false, attempted: false, method: "", error: e.message });
    }
  });
}

async function ack(ids, log) {
  if (!ids.length) return;
  const res = await callService("/notify-ack", { ids });
  if (!res?.ok) {
    log.warn("桌面通知确认失败（下轮会重发）", { error: res?.error, count: ids.length });
  }
}

/** 取一轮队列并派发。返回本轮投递成功的条数。 */
async function drainOnce(log) {
  const res = await callService("/pending-notify", { limit: 20 });
  if (!res?.ok || !Array.isArray(res.items) || res.items.length === 0) return 0;

  const items = res.items;
  const newest = items[items.length - 1] || {};
  // 一波三封以上就不再连弹三个窗口，合并成一条汇总；确认删除仍按原始 id 逐条进行。
  //
  // **汇总必须带上身份**：listNotifications 按入队时间升序，最后一项就是最新的那封。
  // 不带的话 arm 出来的管道记不住是哪封，点开只写一个空 messageId，
  // 卡片侧 `if (d.data.messageId)` 为假 → 什么都不发生 —— 而原始条目已被 ack 删掉，
  // 用户既跳不过去也没第二次机会。
  const batch = items.length >= 3
    ? [{
        id: null,
        messageId: newest.messageId || "",
        accountId: newest.accountId || "",
        folder: newest.folder || "INBOX",
        summaryCount: items.length,
        subject: `你有 ${items.length} 封新邮件`,
        sender: items.slice(0, 3).map((i) => i.subject).filter(Boolean).join(" / "),
        _ids: items.map((i) => i.id),
      }]
    : items;

  let delivered = 0;
  const acked = [];
  for (const one of batch) {
    // 先向服务要一条一次性点击管道。拿不到（服务没起来 / net 不可用）时
    // 只降级为「这条通知不可点击」，不影响通知本身。
    let pipe = "";
    const armed = await callService("/notify-arm-pipe", {
      messageId: one.messageId || "",
      accountId: one.accountId || "",
      folder: one.folder || "INBOX",
      summaryCount: one.summaryCount || 0,
    });
    if (armed?.ok && armed.pipe) pipe = armed.pipe;
    else if (armed?.error) log.warn("点击管道未就绪，本条通知不可点击", { error: armed.error });

    const r = await spawnToast(one, pipe);
    if (r.attempted) {
      delivered++;
      acked.push(...(one._ids || [one.id]));
      // 关键：派发成功 ≠ 系统展示成功。
      // ack 判据是「这一轮派发过了」（不能因为是 SnoreToast 的错就让队列卡 24 小时），
      // 但失败**必须留下痕迹** —— 否则「通知没弹出来」又变成查不到的现象。
      if (r.snoreError) {
        last.snoreError = r.snoreError;
        log.warn("通知已派发，但 SnoreToast 报了失败（已走降级链）", {
          error: r.snoreError,
          subject: one.subject,
        });
      }
    } else {
      log.warn("桌面通知未送达", { error: r.error, subject: one.subject });
    }
  }

  if (acked.length) await ack(acked, log);

  last.at = Date.now();
  last.ok = delivered;
  last.failed = batch.length - delivered;
  last.error = delivered === batch.length ? "" : "见日志：桌面通知未送达";
  return delivered;
}

export function startNotificationDrain(log) {
  if (timer) return;
  timer = setInterval(() => {
    // 上一轮没跑完就跳过，避免慢发送叠出多批并行 spawn。
    // 但不能无条件跳：callService 最长 30 秒而轮询 5 秒，服务挂起时 draining
    // 会长时间为真，后续轮次全被跳过且不留痕。超时就强制复位——
    // 并发两轮是安全的，因为 spawnToast 只认 --result-id 匹配的那个记录。
    if (draining) {
      const stuckMs = Date.now() - drainingSince;
      if (stuckMs < STUCK_MS) return;
      log.warn("上一轮派发疑似卡住，强制复位", { stuckMs });
    }
    draining = true;
    drainingSince = Date.now();
    drainOnce(log)
      .catch(() => { /* 下一轮再试 */ })
      .finally(() => { draining = false; });
  }, POLL_MS);
  // 不要因为这个定时器把宿主进程吊住
  if (typeof timer.unref === "function") timer.unref();
  log.info("桌面通知派发已启动", { intervalMs: POLL_MS });
}

export function stopNotificationDrain() {
  if (timer) { clearInterval(timer); timer = null; }
}

/**
 * 通知链路当前状态（供 /notify-status 与卡片的设置区读取）。
 *
 * 这一项补的是「失败只存在于日志里」的观测缺口 —— 出错时用户自己能看见，
 * 不必去读 service.log。
 */
export function notificationStatus() {
  const rec = readAttempt();
  return {
    drainRunning: !!timer,
    intervalMs: POLL_MS,
    lastRoundAt: last.at ? new Date(last.at).toISOString() : null,
    lastDelivered: last.ok,
    lastFailed: last.failed,
    lastError: last.error,
    lastAttemptAt: rec?.at || null,
    lastMethod: rec?.method || "",
    lastAttempted: rec?.attempted === true,
    lastSubject: rec?.subject || "",
    // SnoreToast 自己报的错。派发成功≠展示成功，这条是两者的差。
    lastSnoreError: rec?.snoreToastError || last.snoreError || "",
    // 点击管道没 arm 起来的原因。不给它一个位置的话，`click:false`
    // 会同时指向「未 arm」与「arm 了但降级」两种情况，排查得重新推一遍。
    lastClickError: rec?.clickError || "",
    lastClickArmed: rec?.click === true,
  };
}

/** 供卡片「测试通知」按钮使用：走完整链路发一条，绕过邮件来源。 */
export async function sendTestNotification(log) {
  const r = await spawnToast({
    subject: "（测试）通知链路自检",
    sender: "Hanako Mail",
    messageId: "notify-self-test",
    accountId: "",
  });
  if (log) {
    if (r.attempted) log.info("测试通知已投递", { method: r.method });
    else log.warn("测试通知未送达", { error: r.error });
  }
  return { attempted: r.attempted, method: r.method, error: r.error };
}
