/**
 * llm-direct.mjs — 门二：直接向供应商发推理请求（宿主契约用不了时的通路）
 *
 * 为什么需要它（v0.6.15，实测出来的）
 * ─────────────────────────────────────────────────────────────
 * 宿主有两条通往模型的门，校验力度不一样：
 *
 *   门一  ctx.models（能力位 app/models.infer）
 *         凭据、endpoint 全留宿主，还有用量记账 —— 更安全。
 *         但它对入参做 ASCII 校验，宿主 bundle 里的原文：
 *
 *           function tg(t, e) {
 *             if (typeof t != "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(t))
 *               throw new Br("APP_MODEL_INVALID_REQUEST",
 *                 `${e} must be 1-128 ASCII identifier characters.`);
 *
 *   门二  ctx.bus 的 provider:credentials + provider:models-by-type
 *         （能力位 app/models.read + app/provider.credentials.read）
 *         providerId 在这里只是**查表的键**，不会出现在发出去的 HTTP 里，
 *         所以中文名、「一个带空格的 provider」这种带空格的 id 都照样能用。
 *
 * 于是「中文provider / 中文providerB」这类供应商在门一用不了、在门二能用 —— 这不是插件在屏蔽，
 * 是同一次调用换个入口结果不同。bilibili-intake 那套三条能力位全要，走的正是门二。
 *
 * 分工（顺序不可反）
 * ─────────────────────────────────────────────────────────────
 * 能用门一就用门一：凭据不进本 App，风险面最小。
 * 只有 provider / model 名字不合门一规矩、或门一本身不可用时，才落到这里。
 *
 * 凭据纪律
 * ─────────────────────────────────────────────────────────────
 * key 只在这两个函数之间流转（宿主 → 本模块 → 受管服务的 /http），
 * 不出现在任何返回值、日志、前端里。
 * 发请求必须借受管服务：AppHost 及其子进程都在 Node 权限模型内，没有出站网络。
 */

import { callService } from "../lib/runtime-host.mjs";

/** 宿主对 provider / model 的标识符要求（抄宿主 bundle 里那条正则，别自创）。 */
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function hostAccepts(provider, model) {
  return ID_RE.test(String(provider ?? "")) && ID_RE.test(String(model ?? ""));
}

/** 协议归一：门二要自己拼请求体，得知道是 OpenAI 兼容还是 Anthropic。 */
function normalizeApi(api) {
  const v = String(api || "openai-completions").toLowerCase();
  if (v.startsWith("anthropic")) return "anthropic-messages";
  if (v === "openai-responses") return "openai-responses";
  return "openai-completions";
}

/**
 * 向宿主取某个供应商的凭据。**不导出** —— 这个决定是结构性的：
 * key 只能停在「取到」与「拼成请求头」那两行之间，
 * http/ui.js、卡片、日志都拿不到它。导出一个返回 apiKey 的函数，
 * 等于给以后的改动留一个「顺手把它放进响应」的入口。
 *
 * 只走 bus —— 不去读 provider-catalog.json：那个文件在 HANA_HOME 根，
 * AppHost 的 fs 白名单里没有它，读它会静默拿到空（v0.6.12 踩过，别再留一条死路）。
 */
async function fetchCredentials(ctx, providerId) {
  if (!ctx?.bus?.request) {
    return { ok: false, error: "宿主 bus 不可用（ctx.bus 缺失），门二无法取凭据" };
  }
  let cred;
  try {
    cred = await ctx.bus.request("provider:credentials", { providerId });
  } catch (e) {
    return { ok: false, error: `provider:credentials 调用失败：${String(e?.message || e)}` };
  }
  if (!cred || cred.error) {
    return { ok: false, error: `宿主没返回「${providerId}」的凭据${cred?.error ? `：${cred.error}` : ""}` };
  }
  if (!cred.baseUrl || !cred.apiKey) {
    return { ok: false, error: `「${providerId}」的 baseUrl 或 API Key 为空，请先在 Hana 设置里补全` };
  }
  return { ok: true, baseUrl: cred.baseUrl, apiKey: cred.apiKey, api: normalizeApi(cred.api) };
}

/** 拼请求：两种协议的路径、头、body 都不一样 */
function buildRequest(api, baseUrl, apiKey, model, messages, systemPrompt, opts) {
  const base = String(baseUrl).replace(/\/+$/, "");
  if (api === "anthropic-messages") {
    const endpoint = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
    const sys = systemPrompt || messages.find((m) => m.role === "system")?.content || "";
    const rest = messages.filter((m) => m.role !== "system");
    return {
      endpoint,
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: { model, max_tokens: opts.maxTokens ?? 1500, temperature: opts.temperature ?? 0.3, system: sys, messages: rest },
    };
  }
  const all = systemPrompt ? [{ role: "system", content: systemPrompt }, ...messages] : messages;
  const endpoint = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  return {
    endpoint,
    headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: { model, messages: all, temperature: opts.temperature ?? 0.3, max_tokens: opts.maxTokens ?? 1500 },
  };
}

/**
 * 门二跑一次非流式推理。
 * @returns {Promise<{ok:boolean,text?:string,usage?:object,error?:string,via:string}>}
 */
export async function inferDirect(ctx, { provider, model, messages, systemPrompt, maxTokens, temperature, timeoutMs = 120_000 }) {
  const creds = await fetchCredentials(ctx, provider);
  if (!creds.ok) return { ok: false, error: creds.error, via: "bus" };

  const { endpoint, headers, body } = buildRequest(
    creds.api, creds.baseUrl, creds.apiKey, model,
    Array.isArray(messages) ? messages : [], systemPrompt,
    { maxTokens, temperature },
  );

  // 出站只能借受管服务：AppHost 没有网络。
  const res = await callService("/http", {
    url: endpoint, method: "POST", headers,
    body: JSON.stringify(body), timeoutMs,
  });

  if (!res?.ok) {
    // 服务把网络层错误放在 error 里；不要把 header 或 body 带回去（可能含 key）
    return { ok: false, error: `向供应商请求失败：${String(res?.error || "未知网络错误").slice(0, 200)}`, via: "direct" };
  }
  if (res.status && (res.status < 200 || res.status >= 300)) {
    return { ok: false, error: `供应商返回 ${res.status}`, via: "direct" };
  }

  const data = res.json;
  if (!data || typeof data !== "object") {
    return { ok: false, error: "供应商返回不是 JSON", via: "direct" };
  }
  // 推理模型可能只吐 reasoning_content，正文为空
  const msg = data?.choices?.[0]?.message;
  const text = msg?.content || msg?.reasoning_content || data?.content?.[0]?.text || "";
  if (!String(text).trim()) {
    return { ok: false, error: "供应商返回内容为空（可能是只出思考过程的推理模型）", via: "direct" };
  }
  return { ok: true, text: String(text).trim(), usage: data.usage ?? null, via: "direct" };
}

/**
 * 门二的模型列表：bus 的 provider:models-by-type。
 * 与门一的 list 合并用 —— 它不受 ASCII 校验限制，能覆盖中文 provider。
 */
export async function listViaBus(ctx) {
  if (!ctx?.bus?.request) return { ok: false, error: "hana_bus_unavailable", models: [] };
  try {
    const r = await ctx.bus.request("provider:models-by-type", { type: "chat" });
    const models = Array.isArray(r?.models) ? r.models : [];
    const out = [];
    const seen = new Set();
    for (const m of models) {
      const provider = String(m?.provider || "").trim();
      const id = String(m?.id || "").trim();
      if (!provider || !id) continue;
      const k = `${provider}:${id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ id, name: String(m?.name ?? id), provider, reasoning: !!m?.reasoning, hostIdOk: hostAccepts(provider, id) });
    }
    return { ok: true, models: out };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), models: [] };
  }
}
