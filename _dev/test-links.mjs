// 从 mail.html 里抽出真实函数源码来测，不复制实现——复制出去的测试测的是另一份代码。
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync("C:/Users/Administrator/.hanako/apps/hanako-mail/ui/mail.html", "utf-8");

function grab(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`not found: ${name}`);
  // 这些函数都是顶层声明，闭合的 } 顶格写在第 0 列。
  // 不用括号计数：函数体里的正则字面量带 } (如 /[.,;)\]}'"]+$/)，会骗过计数。
  const rest = html.slice(start);
  const end = rest.search(/^\}/m);
  if (end < 0) throw new Error(`no top-level close for: ${name}`);
  return rest.slice(0, end + 1);
}

// 最小 DOM 桩：只提供被测函数用到的那两个 API
const doc = {
  createTextNode: (v) => ({ kind: "text", v }),
  createElement: (tag) => ({ kind: tag, set textContent(v) { this.v = v; }, get textContent() { return this.v; } }),
};
const src = [grab("rewriteLinks"), grab("decodeBasic"), grab("linkifyTextInto")].join("\n\n");
// LINKIFY_RE 是顶层 var，linkifyTextInto 依赖它，单独抽出来
const reLine = html.match(/var LINKIFY_RE = .*/);
if (!reLine) throw new Error("LINKIFY_RE not found");
const box = vm.createContext({ document: doc, console });
vm.runInContext(`"use strict";\n${reLine[0]}\n${src}`, box);

let fail = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  if (!ok) { fail++; console.log(`FAIL ${name}\n  got  ${got}\n  want ${want}`); }
  else console.log(`ok   ${name}`);
};

const R = (s) => vm.runInContext(`rewriteLinks(${JSON.stringify(s)})`, box);

eq("bare anchor gets target",
  R('<a href="https://x.com/a">go</a>'),
  '<a href="https://x.com/a" target="_blank" rel="noopener noreferrer">go</a>');
eq("existing target replaced, not duplicated",
  R('<a href="https://x.com" target="_self">g</a>'),
  '<a href="https://x.com" target="_blank" rel="noopener noreferrer">g</a>');
eq("existing rel replaced",
  R('<a href="https://x.com" rel="nofollow" target="_top">g</a>'),
  '<a href="https://x.com" target="_blank" rel="noopener noreferrer">g</a>');
eq("other attrs kept",
  R(`<a class="btn" id="z" href='https://x.com'>g</a>`),
  `<a class="btn" id="z" href='https://x.com' target="_blank" rel="noopener noreferrer">g</a>`);
eq("mailto kept",
  R('<a href="mailto:a@b.c">g</a>'),
  '<a href="mailto:a@b.c" target="_blank" rel="noopener noreferrer">g</a>');
eq("javascript: stripped, no target added",
  R('<a href="javascript:alert(1)">g</a>'),
  "<a>g</a>");
eq("uppercase tag survives as uppercase",
  R("<A HREF=https://x.com>g</A>"),
  '<A HREF=https://x.com target="_blank" rel="noopener noreferrer">g</A>');
eq("no-href anchor still gets target",
  R("<a name=\"top\">g</a>"),
  '<a name="top" target="_blank" rel="noopener noreferrer">g</a>');
eq("multiple anchors",
  R('<a href="https://a">1</a> and <a href="https://b">2</a>'),
  '<a href="https://a" target="_blank" rel="noopener noreferrer">1</a> and <a href="https://b" target="_blank" rel="noopener noreferrer">2</a>');

// linkify：验证走的是节点而不是字符串拼接（正文是不可信输入）
const result = vm.runInContext(`(function(){
  var kids = [];
  var el = { set textContent(v){ kids = []; }, appendChild(n){ kids.push(n); return n; } };
  linkifyTextInto(el, "看 https://example.com/x 或 a@b.com，裸www：www.c-d.org。结束");
  return kids.map(function(k){ return k.kind === 'text' ? ('text "'+k.v+'"') : ('a href='+k.href+' text='+k.v); });
})()`, box);
console.log("\nlinkify 产出：");
for (const r of result) console.log("  " + r);

console.log(fail ? `\n${fail} case(s) failed` : "\nall rewrite cases passed");
process.exit(fail ? 1 : 0);
