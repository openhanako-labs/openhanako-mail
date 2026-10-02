// 对比重写前后 http/ui.js 的顶层成员，确认「只有我有意删的那些不见了」。
// 依据：误删过一次路由注册块，说明定界替换的真实影响面不能靠目测。
import fs from "node:fs";

const CUR = "process.argv[2]";
const ORI = "process.argv[3]";

const names = (src) => {
  const out = new Set();
  // export default 之下的两层：模块级(2空格)与函数内(4空格)都收
  const re = /^ {2,4}(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)|^ {2,4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(src))) out.add(m[1] || m[2]);
  return out;
};

const a = names(fs.readFileSync(ORI, "utf-8"));
const b = names(fs.readFileSync(CUR, "utf-8"));

const gone = [...a].filter((n) => !b.has(n)).sort();
const added = [...b].filter((n) => !a.has(n)).sort();

console.log(`原 ${a.size} 个成员 → 现 ${b.size} 个`);
console.log(`\n消失的（${gone.length}）：`);
gone.forEach((n) => console.log("   - " + n));
console.log(`\n新增的（${added.length}）：`);
added.forEach((n) => console.log("   + " + n));

// 有意删除的清单：旧 LLM 凭据/网络路径。清单外的消失都要单独确认。
const intended = new Set([
  "resolveAgentYamlLlm", "buildLlmOpts", "asStr", "parseSimpleYaml",
  "PROVIDER_PRESETS", "catalog", "catalogIds", "catalogList", "catalogErr",
  "catalogById", "providerModels", "hostOk", "hostError", "hostIds",
  "detected", "pushModel", "seen", "source", "hint", "svc",
]);
const surprise = gone.filter((n) => !intended.has(n));
console.log(surprise.length
  ? `\n⚠ 意外消失 ${surprise.length} 个，需要逐个确认：\n   ` + surprise.join("\n   ")
  : "\n✓ 消失的都在预期清单内");
