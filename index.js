/**
 * hanako-mail — v2 App 入口。
 *
 * 架构（v0.3.0 起）：
 *
 *   ┌─ AppHost（宿主进程，Node 权限模型内）────────────────────────┐
 *   │  · ctx.tools.register()  五个邮件工具                        │
 *   │  · ctx.routes.register() 卡片要调的后端路由（http/ui.js）     │
 *   │  · 把要干活的请求转发给下面的服务                             │
 *   │  ✗ 没有出站网络   ✗ 读不到安装目录 / app-data 之外的文件       │
 *   └────────────────────┬───────────────────────────────────────┘
 *                        │ ctx.runtime.fetch(runtimeId, ...)
 *   ┌────────────────────▼───────────────────────────────────────┐
 *   │  受管 native 服务（runtime/service.mjs，独立进程）            │
 *   │  · ClawEmail WebSocket 监听 + IMAP IDLE 监听                 │
 *   │  · inbox 命令表（list/read/send/reply/转发/附件…）            │
 *   │  · 出站 HTTP（LLM 端点）、图片代理、桌面通知                    │
 *   │  · npm install、v1 数据迁移                                   │
 *   └────────────────────────────────────────────────────────────┘
 *
 * 为什么必须拆成两个进程：AppHost 及**其一切子进程**都在 Node 权限模型里，没有网络、
 * 也读不到白名单外的文件（Node 是在进程内部把权限模型传给子进程的，剥环境变量没用
 * —— 都实测过）。而邮件后端离开网络就不存在。平台为此准备了受管运行时，
 * 只有 native profile 允许「读当前用户可读的文件 + 外网」。见 runtime/service.mjs。
 */

import fs from "node:fs";

import { APP_ID, runtimeDataDir, legacyDataDir } from "./lib/env.mjs";
import { legacyCtx } from "./lib/legacy-ctx.mjs";
import { registerTools } from "./lib/register-tools.mjs";
import { registerRoutes } from "./lib/register-routes.mjs";
import { startService, stopService, serviceRuntimeId, serviceProxyPrefix, serviceProfile } from "./lib/runtime-host.mjs";
import { bindModels } from "./lib/model-host.mjs";
import { startNotificationDrain, stopNotificationDrain } from "./lib/notify-drain.mjs";

export const name = APP_ID;

export async function apply(ctx) {
  // ── 1. 先把数据目录钉死 ──
  // 必须早于任何依赖它的读取：lib/env.mjs、backend/*.mjs、受管服务都按
  // HANAKO_PLUGIN_DATA 解析目录，这里写一次，整条链路就对齐了。
  if (ctx.dataDir) process.env.HANAKO_PLUGIN_DATA = ctx.dataDir;
  const lctx = legacyCtx(ctx);
  const log = lctx.log;
  const dataDir = runtimeDataDir();
  const legacyDir = legacyDataDir();

  log.info(`${APP_ID} v2 loaded`, { appId: APP_ID, dataDir, legacyDir });

  // ── 1.5 把 ctx 交给模型层 ──
  // http/ui.js 的默认导出只收 (app, ctx)，而它拿到的是 legacyCtx 投影；
  // ctx.models 是 v2 真身成员，投影里没有也必须能用 —— 跟 runtime-host 一个套路，
  // 用 module-level 变量转一手，谁想用谁 import。
  bindModels(ctx);

  try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* ignore */ }

  // ── 2. 工具与路由先上线 ──
  // 它们不依赖服务；服务慢一点起来也不该让应用整体 failed。
  const disposers = [];

  try {
    disposers.push(registerTools(ctx, lctx));
  } catch (e) {
    log.error("工具注册整体失败", { error: e.message });
  }

  try {
    const offRoutes = await registerRoutes(ctx, lctx);
    if (typeof offRoutes === "function") disposers.push(offRoutes);
  } catch (e) {
    log.error("路由注册失败", { error: e.message });
  }

  // ── 3. 起受管服务 ──
  // 服务会自己完成 v1 数据迁移与依赖安装（它读得到 plugin-data、也出得了网；
  // AppHost 两样都不行）。
  //
  // 注意这里不把失败当终态：装载与权限记账之间有窗口（实测 apply 跑在
  // 23:58:44.097，而 app/runtime.execute 写进账本是 23:58:44.287），
  // 首次装载很可能被拒。lib/runtime-host.mjs 会在第一次真调用时自愈重试。
  const ready = await startService(ctx, { dataDir, legacyDir, log });

  // 通知派发**无条件**启动，不再挂在服务就绪分支里。
  //
  // 它本来就是「服务不可用时的探针」：内部每轮调 callService，服务没起来时
  // 自然返回 ok:false，下一轮再试。而 runtime-host 的惰性自愈只等「第一次真调用」，
  // 唯一会周期性发起真调用的消费者就是这个派发器 —— 把它关在 ready 里，
  // 等于让两条路互相等。实测：重装后服务起不来的那一次，通知也一起没了。
  try { startNotificationDrain(log); }
  catch (e) { log.warn("启动通知派发失败", { error: e.message }); }

  if (ready) {
    log.info(`${APP_ID} v2 ready`, {
      runtimeId: serviceRuntimeId(),
      profile: serviceProfile(),
      proxyPrefix: serviceProxyPrefix(),
    });
  } else {
    log.warn(`${APP_ID} 已加载，邮件后端暂不可用 —— 将在首次收发时自动重试`, {
      hint: "先看上一条 [ERROR] 的 error/hint 字段（已按错误类型分类）：授权不足、"
        + "端口占用、宿主路径 reparse 三种情况各不相同，不要一律按授权排查。"
        + "实测最常见的是安装目录或 HANA_HOME 带符号链接（native-identity 直接拒绝），与授权无关。"
        + "另外必须能监听 127.0.0.1:43179。工具与卡片仍可用。",
    });
  }

  return () => {
    try { stopNotificationDrain(); } catch { /* ignore */ }
    for (const off of disposers) {
      try { off(); } catch { /* fiber teardown */ }
    }
    // 受管服务的进程生命周期归宿主管，但显式停一次更干净（reload 时不留孤儿）。
    stopService().catch(() => {});
  };
}

export default { name, apply };
