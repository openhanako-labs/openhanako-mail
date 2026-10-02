// 定位 http/ui.js 的 registrar 在哪一条路由上中断。
process.env.HANAKO_PLUGIN_DATA = "C:/Users/Administrator/.hanako/app-data/hanako-mail";

const reg = [];
const routesStub = {
  get: (p) => reg.push(["GET", p]),
  post: (p) => reg.push(["POST", p]),
  put: (p) => reg.push(["PUT", p]),
  patch: (p) => reg.push(["PATCH", p]),
  delete: (p) => reg.push(["DELETE", p]),
  all: (p) => reg.push(["ALL", p]),
  use: () => {},
  on: () => {},
  onError: () => {},
};

const noop = () => {};
const ctx = {
  dataDir: "C:/Users/Administrator/.hanako/app-data/hanako-mail",
  pluginId: "hanako-mail",
  appId: "hanako-mail",
  log: { info: noop, warn: noop, error: noop, debug: noop },
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  bus: { request: async () => ({}) },
};

const mod = await import("file:///C:/Users/Administrator/.hanako/apps/hanako-mail/http/ui.js");
try {
  await mod.default(routesStub, ctx);
  console.log("registrar 正常跑完");
} catch (e) {
  console.log("REGISTRAR THREW:", e && e.constructor && e.constructor.name, "|", e.message);
  console.log((e.stack || "").split("\n").slice(1, 5).join("\n"));
}

console.log(`\n共注册 ${reg.length} 条：`);
reg.forEach(([m, p], i) => console.log(`  ${String(i + 1).padStart(2)}. ${m.padEnd(6)} ${p}`));

// 关键路由是否到位
const need = ["/llm-detect", "/llm-test", "/summarize", "/translate", "/accounts", "/send"];
const have = new Set(reg.map(([, p]) => p));
console.log("\n关键路由：");
for (const n of need) console.log(`  ${have.has(n) ? "✓" : "✗ 缺失"} ${n}`);

process.exit(0);
