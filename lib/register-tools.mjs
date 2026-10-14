/**
 * lib/register-tools.mjs — 把 v1 形状的工具模块注册进 v2 工具表。
 *
 * v2 与 v1 的三处工具契约差异都在这里一次抹平，工具模块本身不用改：
 *   1) v1 靠 manifest 的 contributes.tools[] 声明；v2 必须编程式 ctx.tools.register()。
 *   2) v1 工具导出 `execute(input, ctx)` 双参；v2 只调一次，参数里带
 *      `context: { sessionPath, messageId, messageText, callToken }`。
 *   3) v1 宿主直接渲染工具的返回对象；v2 契约是 MCP 形状
 *      `{ content: [{ type: "text", text }], isError? }`，裸对象没有 content
 *      字段，宿主渲染成空 → 结果不回显（issue #2 Bug 1）。
 *
 *   → 注册时把 v2 的单参 payload 拆成 v1 的 (input, ctx) 再转发，
 *     返回值就地包成 MCP 形状（工具模块仍只管返回业务对象）。
 */

import * as accounts from "../tools/accounts.js";
import * as folders from "../tools/folders.js";
import * as messages from "../tools/messages.js";
import * as send from "../tools/send.js";
import * as sync from "../tools/sync.js";

const MODULES = [accounts, folders, messages, send, sync];

/**
 * @param {object} ctx v2 App ctx
 * @param {object} lctx lib/legacy-ctx 投影出的 v1 形状 ctx
 * @returns {() => void} disposer
 */
export function registerTools(ctx, lctx) {
  const offs = [];

  for (const mod of MODULES) {
    const tool = {
      name: mod.name,
      description: mod.description,
      parameters: mod.parameters,
      // v2 单参调用 → 还原成 v1 的 (input, ctx)；返回值包成 MCP 形状
      async execute(payload = {}) {
        const { context, ...input } = payload || {};
        const r = await mod.execute(input, lctx);
        const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
        return { content: [{ type: "text", text }], isError: !!(r && r.ok === false) };
      },
    };
    try {
      const off = ctx.tools.register(tool);
      if (typeof off === "function") offs.push(off);
    } catch (e) {
      lctx.log.error(`工具注册失败: ${mod.name}`, { error: e.message });
    }
  }

  return () => {
    for (const off of offs) {
      try { off(); } catch { /* fiber teardown */ }
    }
  };
}
