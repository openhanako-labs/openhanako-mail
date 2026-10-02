// 提取 mail.html 里所有内联 <script> 做客户端语法检查。
// node --check 只保证服务端 .js/.mjs；内联在 HTML 里的那部分它看不见。
import fs from "node:fs";
import vm from "node:vm";

const file = process.argv[2];
const html = fs.readFileSync(file, "utf-8");
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m, i = 0, bad = 0;
while ((m = re.exec(html))) {
  if (/\bsrc\s*=/i.test(m[1])) continue;
  const type = (m[1].match(/\btype\s*=\s*["']([^"']+)["']/i) || [, ""])[1];
  if (type && !/javascript/i.test(type)) { i++; continue; }
  i++;
  const body = m[2];
  const line = html.slice(0, m.index).split(/\r?\n/).length;
  try {
    new vm.Script(body, { filename: `${file}@line${line}` });
    console.log(`ok   script #${i}  (starts line ${line}, ${body.length} chars)`);
  } catch (e) {
    bad++;
    console.log(`FAIL script #${i}  (starts line ${line})\n     ${e.message}`);
  }
}
console.log(`\n${i} inline script(s), ${bad} failed`);
process.exit(bad ? 1 : 0);
