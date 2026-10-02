# `_dev/` — 开发期验证脚本

这些不是运行时依赖，也不会进 App 的功能路径。放在仓库里是因为它们守着「改回去就退化」的东西：

| 脚本 | 守什么 |
|---|---|
| `check-inline.mjs` | `node --check` 只看 `.js/.mjs`，看不到 HTML 内联的 `<script>`；卡片改坏时它是唯一能自动发现的层 |
| `test-links.mjs` | 正文链接改写与纯文本 linkify 的用例。**从 `ui/mail.html` 里抓真实函数源码跑**，不复制实现——复制出去的测试测的是另一份代码 |
| `probe-registrar.mjs` | 在宿主外跑 `http/ui.js` 的注册表，打印注册条数与中断位置。曾经靠它才发现一段定界替换把 20 条路由注册一起切掉了（语法与 `node --check` 全都正常） |
| `diff-members.mjs` | 大段改写前后对比 `http/ui.js` 的顶层成员，确认只有有意删的消失了。参数：`node diff-members.mjs <当前 ui.js> <对照 ui.js>` |

用法：都在仓库根执行，路径按 `../` 相对 App 根。它们只读代码，不写任何东西。
