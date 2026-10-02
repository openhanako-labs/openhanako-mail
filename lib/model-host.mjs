/**
 * lib/model-host.mjs — AppHost 侧的「宿主模型」句柄（邮件 App）。
 *
 * 为什么走这条路：`app/models.infer`（界面文案「使用已配置的模型」）的语义是
 * **凭据由 Hana 保管** —— provider 的密钥、endpoint、header 全留在宿主里，
 * 插件侧看不到也不需要知道。
 *
 * 这替掉了此前一整条自建链路：
 *   读 provider-catalog.json（AppHost 无 HANA_HOME 读权，恒空）
 *   → bus provider:credentials 取 baseUrl + apiKey
 *   → backend/net-child.mjs 借受管服务代发 HTTP
 *   → 自己分 openai-completions / anthropic-messages 两种协议拼请求
 * 换掉之后这四层都不存在了：协议差异、鉴权、用量记账归宿主。
 *
 * 三条来自图库实测的契约脾气（同一份宿主代码，照抄以免重踩）：
 *   1. 目录条目里模型标识在 `id`，**不是** `model`；provider 是 `provider`。
 *      形状：{ id, name, provider, input, reasoning, contextWindow, maxTokens }
 *   2. provider / model 都要求 ^[A-Za-z0-9._:-]{1,128}$。
 *      目录里合法存在、但送进 stream 必被拒的实例：provider「另一个中文名的 provider」
 *      （中文）、model「some/embed-model」（带斜杠）。**所以列出来之前必须先过滤** ——
 *      否则用户选中一个送不进去的模型，只在点「总结」那一刻才炸。
 *   3. 宿主模型层异常时**静默挂住**（图库实测两个 provider 都超 60s 无返回）。
 *      所以每次调用自带超时 + cancel，绝不裸等。
 */

import { readAppModelStream } from "../sdk/app-contract/model-stream.js";
import { inferDirect, hostAccepts, listViaBus } from "../backend/llm-direct.mjs";

let _ctx = null;

/** 由 index.js 在 apply() 里调用，把 v2 ctx 交给这一层。 */
export function bindModels(ctx) {
  _ctx = ctx;
}

/** 宿主到底给没给模型能力（没给 = app/models.infer 未授权，或宿主版本不支持）。 */
export function modelsAvailable() {
  return !!(_ctx && _ctx.models && typeof _ctx.models.list === "function");
}

/**
 * provider / model 名字能不能进宿主的标识符规则。
 *
 * ⚠ 这条规则的来历：图库 `lib/model-host.mjs` 的实测注记（当时嵌入了中文 provider
 * 与带斜杠的 embedding 模型名被 stream 拒）。那是一条**经验，不是契约文档**，
 * 而且来自另一个场景。v0.6.14 起它只用来做**标注**，不再用来删条目 ——
 * 供应商是用户自己在 Hana 里添加的，宿主 UI 接受了那个名字，
 * 本 App 没资格替宿主把它藏起来。
 */
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function pickIds(info) {
  if (!info || typeof info !== "object") return null;
  const provider = info.provider ?? info.providerId ?? info.provider_id;
  const model = info.id ?? info.model ?? info.modelId ?? info.model_id;
  if (typeof provider !== "string" || !provider) return null;
  if (typeof model !== "string" || !model) return null;
  return { provider, model };
}

export function isSendable(info) {
  const ids = pickIds(info);
  return !!ids && ID_RE.test(ids.provider) && ID_RE.test(ids.model);
}

/**
 * 归一化宿主目录。**全部保留**，只打上 hostIdOk 标记。
 * 不删任何东西 —— 能不能用由宿主的 stream 说了算，不由这里猜。
 */
export function normalizedModels(models) {
  const out = [];
  const suspect = [];
  for (const m of Array.isArray(models) ? models : []) {
    const ids = pickIds(m);
    if (!ids) continue;                                  // 连 provider/model 都读不到，那不是条目
    if (out.some((x) => x.provider === ids.provider && x.id === ids.model)) continue; // 目录里会重复
    const hostIdOk = ID_RE.test(ids.provider) && ID_RE.test(ids.model);
    out.push({
      id: ids.model,
      name: String(m.name ?? ids.model),
      provider: ids.provider,
      reasoning: !!m.reasoning,
      contextWindow: m.contextWindow ?? null,
      maxTokens: m.maxTokens ?? null,
      hostIdOk,
    });
    if (!hostIdOk && suspect.length < 6) suspect.push(`${ids.provider}/${ids.model}`);
  }
  out.sort((a, b) => Number(b.hostIdOk) - Number(a.hostIdOk) // 名字觊规的排前面，但不藏后面的
    || (a.provider || "").localeCompare(b.provider || "") || a.id.localeCompare(b.id));
  return { models: out, suspect: out.length - out.filter((x) => x.hostIdOk).length, suspectIds: suspect };
}

/** 宿主模型目录。 */
/**
 * 可用模型列表：门一 + 门二 合流。
 *
 * 为什么必须合：门一（ctx.models）受 ASCII 校验限制，中文 / 带空格的 provider 进不去；
 * 门二（bus provider:models-by-type）不受。只要门一，用户的「某个中文名的 provider」「新强幻城」
 * 就永远列不出来 —— 而宿主自己每天都在用它们跟用户说话。
 * 合流后 hostIdOk 只决定走哪条路，不再决定能不能出现。
 */
export async function listHostModels() {
  if (!modelsAvailable()) {
    // 门一不可用不代表全不可用：门二还能走。别在这里就报错，往下试。
  }

  const merged = new Map();
  let gateOne = 0, gateTwo = 0, listError = "";

  if (modelsAvailable()) {
    try {
      const r = await _ctx.models.list();
      const raw = Array.isArray(r?.models) ? r.models : [];
      const { models } = normalizedModels(raw);
      gateOne = models.length;
      for (const m of models) merged.set(`${m.provider}:${m.id}`, m);
    } catch (e) {
      listError = `ctx.models.list 失败：${String(e?.message || e)}`;
    }
  } else {
    listError = "门一不可用（app/models.infer 未授权或宿主版本不支持）";
  }

  // 门二补位：把门一没给出的 provider 补上（它不受 ASCII 校验限制）
  const bus = await listViaBus(_ctx);
  if (bus.ok) {
    for (const m of bus.models) {
      const k = `${m.provider}:${m.id}`;
      if (merged.has(k)) continue;
      gateTwo++;
      merged.set(k, { ...m, contextWindow: null, maxTokens: null });
    }
  } else if (!gateOne) {
    return {
      ok: false,
      error: `${listError}；门二也没拿到（${bus.error}）`,
    };
  }

  const all = [...merged.values()];
  all.sort((a, b) => Number(b.hostIdOk !== false) - Number(a.hostIdOk !== false)
    || (a.provider || "").localeCompare(b.provider || "") || a.id.localeCompare(b.id));

  const offGate = all.filter((m) => m.hostIdOk === false).length;
  return {
    ok: true,
    models: all,
    total: all.length,
    fromContract: gateOne,
    fromBus: gateTwo,
    suspect: offGate,
    listError,
  };
}

const newRequestId = () =>
  `mail-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * 跑一次流式推理，把全文收起来返回。
 *
 * 超时不是「以防万一」，是必需 —— 宿主挂住时不会有任何事件回来，
 * 没有上限就是界面无限转圈。超时后必须 cancel，否则宿主那边一直挂着那次请求。
 *
 * @returns {Promise<{ok:boolean,text?:string,usage?:object,error?:string,timedOut?:boolean,requestId:string}>}
 */
export async function inferText({
  provider,
  model,
  messages,
  systemPrompt,
  maxTokens,
  temperature,
  timeoutMs = 90_000,
} = {}) {
  // 分流：名字合规则走门一（凭据不出宿主，还有用量记账）；
  // 不合规的走门二直连 —— 同一次调用，宿主两个入口的校验力度不同。
  if (!hostAccepts(provider, model)) {
    if (!_ctx) return { ok: false, error: "宿主 ctx 未绑定，两条门都走不了", requestId: "" };
    const via2 = await inferDirect(_ctx, { provider, model, messages, systemPrompt, maxTokens, temperature, timeoutMs });
    return { ...via2, requestId: "", gate: "bus" };
  }
  if (!modelsAvailable()) {
    // 门一本身不可用（未授权 / 宿主版本不支持）：直接走门二，不要把功能关掉。
    const via2 = await inferDirect(_ctx, { provider, model, messages, systemPrompt, maxTokens, temperature, timeoutMs });
    return { ...via2, requestId: "", gate: "bus" };
  }

  const requestId = newRequestId();
  let timer = null;
  let text = "";
  let usage = null;
  let streamError = null;

  try {
    const response = await Promise.race([
      _ctx.models.stream({ requestId, provider, model, messages, systemPrompt, maxTokens, temperature }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`模型 ${Math.round(timeoutMs / 1000)}s 内没有响应`)),
          timeoutMs,
        );
      }),
    ]);

    // readAppModelStream 是宿主给的解码器，管 UTF-8 分片与终止校验，别自己 split("\n")。
    for await (const ev of readAppModelStream(response)) {
      if (ev?.type === "text-delta") text += ev.delta || "";
      else if (ev?.type === "error") streamError = ev;
      else if (ev?.type === "done") usage = ev.usage ?? null;
    }
  } catch (e) {
    const msg = String(e?.message || e);
    const timedOut = /内没有响应/.test(msg);
    try { await _ctx.models.cancel(requestId); } catch { /* 取消失败不掩盖原错误 */ }
    // 门一抱错时再试一次门二 —— 但不包括超时：那次可能已经发出去了，
    // 重试就是两次请求两份钱。
    if (!timedOut && _ctx) {
      const via2 = await inferDirect(_ctx, { provider, model, messages, systemPrompt, maxTokens, temperature, timeoutMs });
      if (via2.ok) return { ...via2, requestId, gate: "bus-after-gate1-fail", gateOneError: msg };
      return { ok: false, requestId, timedOut, error: `${msg}（门二也不行：${via2.error}）` };
    }
    return { ok: false, error: msg, timedOut, requestId };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (streamError) {
    const msg = `${streamError.code || "stream-error"}: ${streamError.message || ""}`.trim();
    if (_ctx) {
      const via2 = await inferDirect(_ctx, { provider, model, messages, systemPrompt, maxTokens, temperature, timeoutMs });
      if (via2.ok) return { ...via2, requestId, gate: "bus-after-gate1-fail", gateOneError: msg };
      return { ok: false, error: msg, requestId };
    }
    return { ok: false, error: msg, requestId };
  }
  if (!text.trim()) {
    // 推理模型可能只吐 reasoning 不给 content；空返回要说出来，别让它长得像成功。
    return { ok: false, error: "模型没有返回正文（可能是只出思考过程的推理模型）", usage, requestId };
  }
  return { ok: true, text: text.trim(), usage, requestId };
}
