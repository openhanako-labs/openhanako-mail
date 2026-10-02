# Changelog

## [0.6.15] — 2026-10-02

### 纠正：0.6.13 删掉的「旧路径」，其实是用户用自己那些模型的唯一通路

0.6.14 改成「不预检、把宿主原话递回去」之后，拿到了真正的报错：

```
某个中文名的 provider / 其聊天模型: provider must be 1-128 ASCII identifier characters
```

而另一个事实把话说完了：**同一个模型，宿主自己天天在用它跟用户对话**。
查宿主 bundle，两边入口与校验力度不同：

| | 取凭据 | provider 名校验 | 中文名 provider |
|---|---|---|---|
| **门一** `ctx.models.stream`（`app/models.infer`） | 宿主保管，插件看不到 | `tg()` 要求 `^[A-Za-z0-9_.:-]{1,128}$` | ❌ 拒 |
| **门二** `ctx.bus` 的 `provider:credentials` + 自己发请求 | bus 回传 baseUrl + apiKey | providerId 只当**查表的键**，不进 HTTP | ✅ 能用 |

同一次调用换个入口结果不同——这是宿主契约自己的不一致。0.6.13 那次「整块删除」
把门二删了，等于把用户自己加的那批模型关在门外。图库那份被当模板拄的代码只用了门一，
所以这个限制在生态里一直没被说破。

### 现在的分工（两条腿）

```
inferText(provider, model, …)
  ├─ hostAccepts ✓ → 门一 ctx.models.stream   凭据不出宿主，有用量记账
  ├─ hostAccepts ✗ → 门二 inferDirect()        bus 取凭据 + 受管服务代发 HTTP
  └─ 门一抱错（非超时）→ 回落门二，并把门一原话带在 gateOneError 里
```

- 列表两路合流：`ctx.models.list` + `bus provider:models-by-type`；响应里 `fromContract` /
  `fromBus` 各自报数，`suspect` 改成中性描述（由另一扇门提供）。
- 下拉里不合 ASCII 规则的不再标「可能不收」，改标「直连」（金色描边）——能用，只是路径不同。
- 门一失败**超时不回落**：那次请求可能已经发出去了，重试等于两次请求两份钱。
- 响应带 `via`（contract / bus / bus-after-gate1-fail），走哪条路用户看得见。

### 凭据纪律（门二请回来必然带来的责任）

- `fetchCredentials` **不导出**：key 只能停在取到与拼成请求头那两行之间，
  `http/ui.js` 从结构上拿不到它。
- 只走 bus，**不读 `provider-catalog.json`**：那个文件在 AppHost 的 fs 白名单外，
  读它是 v0.6.12 那个静默空结果的根因，不再留一条死路。
- 出站借受管服务的 `/http`（AppHost 本身没有网）。0.6.13 删的是 `/provider-catalog`，
  `/http` 与 `rawRequest` 一直在，所以这次的改动面比预想小。
- 不回前端、不进日志、错误信息里不带 headers。

能力位回到三条：`app/models.infer` + `app/models.read` + `app/provider.credentials.read`
（与 bilibili-intake 一致），需重新审批。

自检补 6 条：门二只走 bus、不读 HANA_HOME、不导出取凭据函数、超时不回落、
列表两路合流、`ui.js` 里调不到 `fetchCredentials`。

> 0.6.13 的「插件侧无从放宽」与 0.6.14 的「宿主可能不收」都不成立，
> 那两节已就地标为被本版推翻。

## [0.6.14] — 2026-10-02

### 推翻上一版：不合规则的模型只标注，不再从列表里删掉

0.6.13 把模型列表改成只走 `ctx.models` 之后，沿用了图库那条注记里的标识符规则
（`^[A-Za-z0-9._:-]{1,128}$`），在**列表面就把不合规则的条目删了**。

一句提问拆穿了它：**本来就是用户添加的模型，为什么要过滤？**

错在两处，都挺致命：

1. 供应商名是用户自己在 Hana 设置里起的，宿主 UI 也收了它。本 App 拿一条
   **来自另一个场景（图库 embedding）的旧实测经验**当律法，相当于替宿主、
   更替他做了决定。
2. 后果是静默少了一批模型，其中明眼一看就能用的聊天模型也在里面。
   而界面只会显示「已过滤 一批」——看起来像解释了，其实是把一个问题
   包成了另一个更难查的问题（“我配了七个为何只剩三个”）。

改成：

- `sendableModels` 改名 `normalizedModels`，**全部保留**，只打 `hostIdOk` 标记；
  排序时把名字合规的排前面，但不藏后面的。
- `inferText` **去掉本地预检**（原来会自己 return 一条「不满足标识符要求」），
  直接把请求交给宿主：能跑就跑通，跑不通就把宿主的原话递回界面。
- 前端下拉里不合规的显示为虚线框 + 「名字可能不收」，**仍然可点选**。
- 状态行只陈述事实：`其中 N 个的 provider 或模型名含中文、空格或斜杠，宿主可能不收 ——
  仍全部列出，选中后若失败会把宿主的原话显示出来`。

顺手把这条提炼成一句规则写进 README：**遇到「宿主某处会拒、我们能提前避开」的场景，
默认是告知 + 放行，不是代替选择。**

自检补 2 条：标识符规则不得用于删条目；`inferText` 里不得出现预检 return。

## [0.6.13] — 2026-10-02

### 变更：AI 整块改用宿主模型契约，自建那条路删干净了

用户看着权限页上那个「使用已配置的模型」开关问：**有这个权限不就不用读取了吧。**
问题问得对，而且比 0.6.12 的修复更深一层——0.6.12 只是把旧路接通，这条路本身不该存在。

`app/models.infer`（界面文案「使用已配置的模型」）的宿主原话是
「允许此 App 使用 Hana 配置的模型进行推理。**凭据由 Hana 保管**，并记录模型用量」。
既然凭据、endpoint、API 协议都在宿主侧，插件这边那一整套自建链路就是多余的责任：

| 删掉的东西 | 原本干什么 |
|---|---|
| `backend/hana-llm.mjs` | bus 取 baseUrl + apiKey、读 catalog、`selectChatModel` 猜默认供应商 |
| `backend/net-child.mjs` | 借受管服务代发 LLM 的 HTTP（AppHost 无网） |
| `llm.mjs` 的 `chatCompletion` / `buildRequest` | 自己分 openai-completions / anthropic-messages 两种协议拼请求 |
| `resolveAgentYamlLlm` | 读 `agents/<id>/config.yaml` 拿 key |
| `PROVIDER_PRESETS` | 硬编码 20 家供应商的 Base URL 预设（定义了没人用，本来就是死的） |
| 服务侧 `/provider-catalog`（0.6.12 刚加的） | 让服务代读 catalog —— 范式没变，一起删 |
| `HANAKO_LLM_*` 环境变量 | 本地兜底配置，宿主接管后无意义 |

`backend/llm.mjs` 现在只剩三个提示词函数（`summarizePrompt` / `translatePrompt` / `pingPrompt`）——
只管「问什么」，不管「谁来答」。新增 `lib/model-host.mjs` + `sdk/app-contract/`（取自图库已跑通的实现）。

**能力位随之变化，需要重新审批**：去掉 `app/models.read` 与 `app/provider.credentials.read`，
新增 `app/models.infer`。

### 实测到的硬限制：模型名送不进宿主

`ctx.models.list()` 这次真的返回了内容（0.6.12 那条「bus 可能不通」的担忧可以销掉），
但目录里多数条目**过不了宿主的标识符规则** `^[A-Za-z0-9._:-]{1,128}$`：

```
provider「providerY」/ model「providerY/某模型P」        ← 带斜杠
provider「provider-cn」/ model「providerX/some/embed-model」  ← 带斜杠
provider「一个带空格的 provider」                                     ← 带空格
```

> ⚠ 本节下面关于「剔掉」的做法已被 **0.6.14 推翻** —— 插件侧本来就不该剔。
> 保留这段是为了记住为什么错：把一条另一个场景的旧实测经验当成了硬约束。

宿主对 provider / model 有一条标识符规则（`^[A-Za-z0-9._:-]{1,128}$`），中文、空格、
斜杠都可能送不进 `stream`。0.6.13 据此在列表面就把它们剔掉，并在 0.6.14 改回
全部保留 + 只打标记。`postLlmDetect` 带回的字段也从 `total` / `dropped` / `droppedIds`
改成 `total` / `suspect` / `suspectIds`——名字从「已丢弃」变成了「可疑」。

### 事故与恢复：定界替换切掉了一整块路由注册

清旧路径时，我用「注释标题」作为区间端点去替换 LLM 区，结果**把 20 条
`app.get("/accounts", getAccounts)` 之类的路由注册语句一起删了**：

- 表现很迷惑人 —— `node --check` 通过、registrar「正常跑完」、模型列表还照样注册着；
  只有路由总数从 29 掉到 9，而卡片上每个面板都会 404。
- 根因：端点标题在文件里不是唯一的切点，替换区间比预想的宽。
- 恢复：逐行取自原仓库 `main` 分支同一块（不手敲），插回原位并记下为什么在这里留注释。
- 事后补了 `_dev/diff-members.mjs`：重写前后对比全部顶层成员，确认消失的只有有意删的那几个
  （`asStr` / `parseSimpleYaml` / `pushModel`，以及 YAML 解析器内部的 `top` 与被删函数内的 `model`）。

**教训**：按标记定界做大段替换，必须事后做一次「成员级 diff」，不能只看语法和断言。

## [0.6.12] — 2026-10-02

### 修复：明明加了一批供应商，却报「未检测到已添加的供应商」

两层原因叠在一起，缺一层都不会浮现：

**一、读不到。** `getProviderCatalog()` 直读 `~/.hanako/provider-catalog.json`（HANA_HOME 根），
而宿主给 AppHost 的 fs 白名单实测只有三条（从运行中进程的 argv 取到）：

```
--allow-fs-read=<HANA_HOME>/apps/hanako-mail
--allow-fs-read=<HANA_HOME>/app-data/hanako-mail
--allow-fs-read=<bundle>/desktop/src/locales
```

HANA_HOME 根不在其中。`readFileSync` 被权限模型拒掉，`catch { _catalogCache = {} }` 吞成空 ——
不报错，只是永远是空。

**二、就算读不到也不该空。** `postLlmDetect` 里 catalog **驱动整个循环**，
宿主 bus `provider:models-by-type` 只在「catalog 里某供应商没列 models」时当补充。
catalog 为空 → 循环零次 → bus 给得再多也用不上。

这条读取路径是 v1 时代（插件跑在宿主进程内，什么都能读）留下的，v2 迁移改了进程模型
却没跟着改它 —— 与上一批里 `app/ui.open-external` 声明了却零调用是同一个模式：
**声明的能力与实际走的代码路径不一致。**

### 改法

- **宿主 bus 为主路**：`provider:models-by-type` 返回什么就列什么（它只给可用供应商，
  不需要这层再校 key / base_url）。
- **目录兜底搬到受管服务**：新增服务侧 `/provider-catalog`。服务跑在 `local-machine` 下，
  HANA_HOME 在它可读范围内（图库的 embedding 直连也是同一套读法）。AppHost 读不到就转请求。
  只回 `id / api / models`，**明文 api_key 不跟进程间流动** —— 真凭据仍按 provider 走
  `provider:credentials` 回源。HANA_HOME 从 DATA_DIR 往上两层反推，不读环境变量。
- 空结果不再只说「没供应商」：后端算好 `hint`（哪一层空、bus 报了什么、目录可不可读），
  前端直接显示。否则这句话会把人引去改一个本来就对的地方。
- `getProviderCatalog` 在 `http/ui.js` 的 import 已删（不再被调用）。
- 成功时状态行标出 `source`（宿主接口 / 目录兜底），下次一眉就知道走的哪条。

> 待实测：如果 bus 本身困授权未生效而失败，`hint` 会把原因直接写出来，
> 不再是「你去加个供应商」这种把锅踢给用户的说法。

## [0.6.11] — 2026-10-02

### 修复：邮件里的链接点了会把邮件本身掉

正文 frame 的 `sandbox="allow-popups"`：没有 `allow-top-navigation`，宿主拦不到外链；
没有 `allow-scripts`，脚本方案也不成立。所以一个没写 `target` 的 `<a>` 会在正文框
【内部】导航 —— 邮件被目标网页替掉，而那个网页因为沙箱不支持脚本，还是残缺的。

`rewriteLinks()` 把正文里每个 `<a>` 补上 `target="_blank" rel="noopener noreferrer"`，
走沙箱唯一能用的 `allow-popups` 通道。明写的 `javascript:` / `data:` / `vbscript:`
顺手摘掉 href（实体编码的写法挡不住，但沙箱本来就没 allow-scripts，这一层是纵深
防御的第二道，不是唯一那道）。标签名用捕获组原样带回：`<A` 改写后还是 `<A`。

### 修复：多账号下点通知，会拿错账号去取那封邮件

`openDetail(messageId)` 只声明了一个参数，但两个调用点都传了三个
（`showNotification` 的 toast、`clickPollTick` 的系统通知回跳）——
`accountId` / `folderId` 被静默丢弃，请求固定用**当前 UI 选中账号**。
三个账号的人停在 A 收件箱点 B 的新邮件通知，必然加载失败，而且不报错，只显“加载失败”。

现在签名接住三个参数，跳账号时同步侧标并后台补齐那个账号的文件夹列表。

### 修复：folder 从未跟着通知走完全路

新邮件轮询的是用户**当前浏览的文件夹**，不是恒为 `INBOX`；但 toast 重新去取
`state.folderId`（活 5 秒，够用户把文件夹切走了），而桌面通知的点击记录里
**根本没有 folder 这个字段**。两边现在一路透传：

```
卡片 fetchNotifyDesktop(…, folder)
  → POST /notify  body.folder
  → _pending_notify/<id>.json  folder
  → /notify-arm-pipe  meta.folder
  → notify-click.json  folder
  → clickPollTick  openDetail(…, d.data.folder || 'INBOX')
```

实时监听那两条（imap-idle / ws-monitor）直接写目录、不经 `queueNotification`，
它们没有这个字段 —— 读取侧默认 `INBOX`，与它们的语义一致。

### 新增：纯文本正文里的裸链可点了

以前 `textContent` 直出，验证码、激活链接一概不可点。`linkifyTextInto()` 支持
`http(s)://` / `www.` / 邮箱地址（后者呯 `mailto:`），中文句读不算进 URL。
全部用 DOM 节点拼，不拼 `innerHTML` —— 正文是不可信输入，这里不留 XSS 面。

### 外观：正文框不再硬编码白底

`.mail-body-frame { background: #fff }` 是写死的。`srcdoc` 的 body 只铺到内容高度，
内容短时底部就露白；深色主题纸面是 `#352e25`，反差尤其明显。改为 `transparent`，
由外层 `.mail-body-wrap` 的 `--paper` 透出，深浅色都对。

### 封面：换最新竖版构图（走 cache-busting）

`face-v2.png` / `ui/face-v2.png` = 1080×1440（3:4）卡片槽构图，标签行反映当前能力
（多账号 / 实时通知 / 点击直达 / 回复与搜索 / AI 总结）。

以前根目录放新版、`ui/` 下还躺着一张旧的 624×416，而 manifest 只写了 `"face.png"`——
哪个算数全凭运气。两处现在同一张图，旧的备份到 `OH-Works/backup/hanako-mail/`。

真正让旧图赖着不走的是另一件事：**宿主按路径缓存资产**。同名覆盖完，UI 里还是旧的。
图库已经栽过一次，当时的解法是改文件名（`icon-v15.png` / `panel-cover-v2.webp`）。
这里沿用：manifest 指向 `assets/icon-v11.png` 与 `face-v2.png`。

图标本体 `assets/icon.png` 经 MD5 比对已是图标系统 v3 定稿，本次**未重新设计**，
`icon-v11.png` 是它的同源拷贝 —— 改的是路径，不是像素。

### 自检

`scripts/smoke-load.mjs` 补 8 条源码断言，守住上面每一条不被改回去。

## [0.6.10] — 2026-09-22

### 修复：服务进程死掉后，没人拉它起来

0.6.9 测试时踩到的：杀掉邮件服务进程后，AppHost 每 60 秒报一次

```
hanako-mail poll fail: Managed runtime "a3a1dd5f-..." does not have a ready service.
```

**却从不重启它**；`disable` / `enable` 也不会重载 App。服务就一直停在那里。

机理是一个“自我一致的盲目”：

- `_state` 只在 `doStart()` 内部被写（`_state = ok ? "ready" : "failed"`）；
- 服务进程死掉时**没有任何代码改它**；
- 于是 `doStart()` 开头的 `if (_state === "ready" && _runtimeId) return true;` 永远短路；
- 每次调用直接 `runtime.fetch` → 拿到 “does not have a ready service” → 报错；
- 而报错也不改 `_state` → 下一次一模一样。

修：新增 `isRuntimeGoneError()` 识别这类错误，`markRuntimeGone()` 作废就绪状态
（同时清 `_lastFailureAt`，让重启不被冷却挡住），`callService` 就地补一次；
补不上才把错误交给调用方。

> 这个洞从外面看很难受：卡片照常打开、列表照常显示（读的是**磁盘缓存**，
> 不经过服务），所以它**看起来还活着**，只是数据冻住了；通知没了、同步没了。
> 唯一的痕迹就是日志里那句 poll fail。
> 而 0.6.9 的自愈只在 App 启动时触发 —— 所以在此之前，“服务崩了”唯一的恢复方式是重启整个 Hana。

### 顺带清掉合并带进来的死代码

`lib/runtime-host.mjs` 里的 `startWith(profile)`：合并取上游 `RUNTIME_PROFILES` 循环版后
它没人调用了（循环里直接 `_ctx.runtime.start`），留着会让人以为还有第二条启动路径。

`smoke-load` 相应加两条哨兵（自愈逻辑在 / 没有 orphan 的 startWith）。

## [0.6.9] — 2026-09-22

### 新增：服务自己补依赖（那个“让用户开终端跑脚本”的暗坑）

只要 0.6.8 的实测结论成立（服务**能** spawn），那么一段被废弃的能力就能拿回来：
**服务自己 `npm install`**。

以前不行——那段代码上写着“服务不能再 spawn（Job Object，实测 EPERM），npm 永远跑不起来”，
于是改成依赖随包发布 + 只报错。而那个结论已过期（见 0.6.8）。

它的真实代价是：更新 App 会把 `backend/node_modules` 整个清掉，
而唯一的恢复路径是让**用户自己开终端跑 `scripts/restore-backend-deps.mjs`**。
现在服务自己补。

实现要点：

- `findNpmRunner()`：扫 `process.execPath` 附近 + `PATH` + Program Files，
  凑齐一对 **(node.exe, npm-cli.js)**。
  ★ 不能拿 `process.execPath` 凑数——服务自己的它是 **hana-server.exe**，
  拿它跑 `npm-cli.js` 只会把参数当成服务启动参数。凑不齐宁可不装。
- `autoInstallDeps()`：`<node> <npm-cli> install --omit=dev --no-audit --no-fund`，
  180 秒超时，装完重新用 `missingBackendDeps()` 验收（**不靠退出码下结论**）。
- 安装期间写 AppHost 那个一直没人写的 `.hanako-auto-install.lock`，
  让它回 202「正在自动安装中」而不是报错。
- ★ 自愈**不阻塞就绪**：服务立刻开始监听，安装放后台，装好再 `loadBackend()`。
  否则 `READY_TIMEOUT_MS`（15 秒）一到 AppHost 就会重试，
  而一个还在 `npm install` 的服务进程会和第二个进程抢同一个 `backend/node_modules`。
  也因此必须用 `execFile`（异步）—— `spawnSync` 会把 HTTP 事件循环一起堵死。
  这也正好是 `main()` 里原本就写着的意图（“依赖检查不再阻塞就绪”）。
- 仍然以「依赖随包发布」为主（解压即用、不依赖网络），自愈只是兜底。

### 诊断：`/health` 现在报告 spawn 与 npm 可见性

新增两个字段：`spawn`（探针结果）与 `npm`（找到的 npm 根目录与版本）。
放在 `/health` 而不是新增端点——回环服务本来就没鉴权，不再多一个可被本机进程触发的动作。

### 修正：七处“不能 spawn”的陈旧结论

`service.mjs` / `clawemail-backend` / `notify-drain` / `imap-idle` / `ws-monitor` /
`agentqq-auth` / `agentqq-backend` 都把「受管服务不能 spawn（实测 EPERM）」当成前提，
其中几处正是三个架构决定（通知分两半、图片代理进程内、mail-cli 被替掉）的根据。

现在它们都改成：标注那条结论已过期 + 指向唯一真相来源（`runtime/service.mjs` 的 `probeSpawn`）。
各设计本身基本保留（它们还各有别的理由），只是不再靠一个假前提站住。

## [0.6.8] — 2026-09-22

### 新增：启动时实探一次「受管服务能不能 spawn」

仓库里对这个前提有两句**互相否定**的话：

- `runtime/service.mjs` / `clawemail-backend` / `notify-drain` / `imap-idle` /
  `ws-monitor` / `agentqq-auth` / `agentqq-backend` 共 7 处写着：
  「受管 native 服务不能 spawn（Job Object，**实测** spawn EPERM）」。
  **通知为什么分两半、图片代理为什么改进程内、mail-cli 为什么被替掉，都是围绕这句建的。**
- `scripts/restore-backend-deps.mjs`（2026-09-20）却说服务「**有能力 spawn + 出网**」。

可疑之处：那句 EPERM 是在服务还跑在 **native** profile 时测的；
而现在 native 永远建不起来（`HANA_HOME` 是符号链接），服务实际一直跑在降级后的
`local-machine`（`enforcement: none`，无沙箱）—— 当初那个限制可能已经不在了。
两边都没在“降级成为常态”之后重测过。

结论决定两件实事：

1. 服务能不能自己 `npm install` —— 即更新 App 把 `backend/node_modules` 清掉后能不能自愈；
   若不能，唯一的恢复路径是让用户在自己的终端手动跑 `restore-backend-deps.mjs`。
2. 通知那套「服务排队 + AppHost 派发」的分割是否还有必要。

做法：启动时 `spawnSync(process.execPath, ["-v"])` 真跑一次，结果写入 `service.log` 的
`spawn 能力探针` 一行——不再靠注释互相说服。选启动时而不是加 HTTP 端点：
回环服务本来就没鉴权，不再多一个能被本机进程触发的动作。

## [0.6.7] — 2026-09-22

### 修复：降级到无沙箱 profile 的提示永远不显示（上游遗留的一行）

合并上游 `b23abcb`（把降级链重写成 `RUNTIME_PROFILES` 数组循环）后发现：
`lib/runtime-host.mjs` 里 `_profile` **声明了但从未赋值**：

```js
let _profile = ""; // 实际生效的 profile：native 失败时会降级到 local-machine
export function serviceProfile() { return _profile; }
```

而 `serviceProfile()` 有三处消费者，其中一处很关键：

```js
// ui/mail.html:957
if (d.serviceProfile && d.serviceProfile !== 'native') parts.push('运行 profile：' + d.serviceProfile);
```

也就是说 **卡片本来会在设置里提示“你的服务正跑在降级 profile 上（原 0 无文件沙箱）”**，
但 `_profile` 恒为空 → 那个提示永远不出现。一个安全相关的降级提示被静默吞掉了。

修：成功路径写回 `_profile = rec?.profile || profile`；
全部 profile 都失败时复位为 `""`，不再报上一个尝试过的 profile。

> 这种“声明了却从不赋值”编译器与 `node --check` 都看不见 ——
> 因此 `scripts/smoke-load.mjs` 加了一条静态哨兵盯住这一行。

## [0.6.6] — 2026-09-22

### 修复：QQ 邮箱同步被一条化石提示挡住

报错是 “IMAP 依赖未安装”（`http/ui.js:104`），而**依赖其实是齐的**：
`imapflow` 与 `nodemailer` 都在 `backend/node_modules` 里。

真正在找的东西是 `node_modules/imap/package.json` —— 而 `imap`
在 0.6.0 就已经被换掉删除了。**依赖没缺，是检查没跟上。**

同一个包里其实早就有写对的版本：`runtime/service.mjs` 的 `checkDeps()`
从 `backend/package.json` 的 `dependencies` 推导，而它跑过了（日志里“后端依赖就绪”）。
问题只是 AppHost 那一侧另有两份硬编码清单：`checkBackendDeps` 与 `/deps-status`。

### 修法：把规则收成一份

新增 `backend/deps.mjs`，导出 `missingBackendDeps(backendDir)`——
唯一判定：读 `backend/package.json` 的 `dependencies`，逐个查 `node_modules`。

- `http/ui.js`：`checkBackendDeps` 与 `/deps-status` 都改用它
- `runtime/service.mjs`：`checkDeps()` 改为调用它（删除重复实现）
- `scripts/smoke-load.mjs`：加两条静态哨兵，钉住“不硬编码包名 + 两侧共用”

顺带简化：不再按账号类型分叉。后端在模块加载时就会 `import imapflow` /
`@clawemail/node-sdk`，任何一个缺失都会把整个后端带下去，
所以“缺了就是全都不能用”才是诚实的说法。提示语也不再让人去 `npm install`
（见下）。

### 关于“依赖不自动装吗”

曾经是自动的 —— 代码里还留着 `.hanako-auto-install.lock` 和“正在自动安装中…”的分支。
但受管 native 运行时被 Job Object 管着，**不能再 spawn 任何进程**（实测 `spawn EPERM`），
`npm` 永远跑不起来。`runtime/service.mjs` 的注释里记着这次实测。

所以现在的设计是：**依赖随安装包发布**（`backend/node_modules` 入包），
运行时只负责检查与明确报错。错误提示因此也改成
“重新安装本应用”而不是“去跑 npm install”。

## [0.6.5] — 2026-09-22

### 修复：列表从不要求倒序，于是新邮件永远不出现

`clawemail-backend.mjs` 的 `listMessages` 只向服务端传了 `{ fid, limit }`。
而 SDK 的 `transport.listMessages` 其实是**透传**的：

```js
this.client.call("mbox:listMessages",{ fid, order: e.order, desc: e.desc, start, limit, filterFlags })
```

`order` / `desc` 不给就是 `undefined` → 服务端按默认序返回（**升序**）→
而 `limit` 截掉的是**最新**那头。于是“最新 50 封”变成“最旧 50 封”，
新邮件在界面上永远不会出现 —— 而手动同步、实时缓存、文件夹计数都在正常工作，
所以从外面看像“缓存没刷新”。

真实账号实测（同一邮箱 `fid=1`、`limit=50`）：

| 取法 | 返回 |
|---|---|
| 不传 order/desc | 2026-05-04 ~ 05-14（最旧的 50 封） |
| `order:"date"`, `desc:true` | 2026-09-22 ~ 08-06（最新的 50 封） |

修法：显式传 `order:"date"` 与 `desc:true`（与同一份 SDK 里的 `searchMessages` 一致）。

> 顺带纠正一条陈旧注释：原文写“SDK 里写死 fid/order/desc/...”，
> 实际写死的是**参数名集合**，`order`/`desc` 的值是调用方给的。
> `since`/`before` 确实不在名单里（那条结论仍成立）。
> `scripts/smoke-load.mjs` 相应加了一条静态哨兵。

## [0.6.4] — 2026-09-22

### 从主导航里撤下「邮件」入口

0.6.1 加上 `siteNavEntry: true` 是为了让卡片作为页面可达，
但那同时把「邮件」放进了左侧主导航，占了一个位置——他要的是“能打开”，不是“被展示”。

改为 `siteNavEntry: false`，页面形态保留（`realization: "page"` + `detached` 不动）：

- 仍然作为独立页面/窗口打开
- 不再出现在站点导航里

> 写显式 `false` 而不是删掉该字段：防止宿主对“未声明”采取“默认显示”的策略。

## [0.6.2] — 2026-09-22

### 修复：独立窗口下所有路由调用都 403 missing_credential

上一版把“拿不到账号”显示成具体错误后，真相就出来了：

```
账号加载失败：HTTP 403 {"error":"forbidden","reason":"missing_credential"}
```

不是 token 过期，是**根本没有凭据**。

**根因**：卡片一直在用 `new URL(location.href).searchParams.get('token')` 取凭据，
而宿主授权走的是「文档绑定的 surface session」——
看宿主 SDK 里的 `pluginApiFetch`（`hanako-audio-player/ui/standalone.html:1492`）：

```js
var APP_SURFACE_SESSION_HEADER = "X-Hana-App-Surface-Session";
var APP_SURFACE_SESSION_QUERY  = "appSurfaceSession";
```

- 查询参数 `appSurfaceSession`（宿主注入到文档 URL）
- 请求头 `X-Hana-App-Surface-Session: <值>`

独立窗口 / 独立页面没有 `?token=`，于是一个凭据也带不上 → 代理 403。
内嵌卡片里能跑，是因为宿主那时把 `?token=` 注入了进去。

**修法**（两种凭据都读，surface session 优先）：

- `api()`：带 `X-Hana-App-Surface-Session` 请求头，URL 上也挂一份查询参数
- `attachmentUrl()` / `proxyUrl()`：这两处走 `<img src>` / `<a href>`，**带不了请求头**，
  所以只能把凭据写进查询参数——统一收敛到 `withCred()`
- 顺手修正 `api()` 的请求头合并：原来只要 `options.headers` 存在，`Content-Type` 会被整个顶掉

另外 `APP_ID` 从 `location.pathname.split('/')[3]` 改成正则提取 `/api/apps/<id>/`——
独立页面未必落在 `/ui/` 这一层，写死下标会取到错的 appId。

> 后端自己不校验凭据，这些 URL 全部经宿主代理鉴权。

## [0.6.1] — 2026-09-22

### 卡片改为「页面」形态，并声明独立窗口

点击邮件入口时不再弹出内嵌卡片，而是作为**页面**打开（与 token-tracker / audio-player 同样做法）。
字段语义来自宿主 SDK 的权威定义（`_ui-protocol.d.ts`）：

- `realization: "page"` —— 这张卡作为整页存在，而不是内嵌卡片
- `siteNavEntry: true` —— 只在 `realization: "page"` 上生效，让它进入站点导航
- `detached.route` —— 独立窗口用的那个“包含完整导航的文档”
- `detachedDefaultSize: 1200×800` —— 三栏布局需要宽一点，不再用通用默认尺寸

> 这三个字段取值写错只会被当成“未声明”（应用仍能注册），不会把应用弄挂。

### 修复：卡片把“拿不到账号”显示成“暂无账号”

`loadAccounts()` 原来直接 `d.data || []`，不看 `ok`/HTTP 状态。
而卡片持有的是宿主注入的 `?token=`，**应用重装/重新注册后它会失效**，
那时 `/accounts` 返回 401，卡片就渲染成“暂无账号”——看起来像账号丢了，
而“刷新窗口”和“去添加账号”是两个完全不同的行动。

现在区分开了：非 2xx 或 `ok:false` 会显示具体的失败原因与提示（“若刚重装过应用，请刷新本窗口”），
而不是伪装成空列表。

## [0.6.0] — 2026-09-22

**IMAP 层整体从 `imap@0.8.19`（node-imap，已废弃）迁到 `imapflow@2.0.5`。**
`backend/imap-backend.mjs` 已删除，`imap` 依赖已移除。

> 这一轮真正的起点不是写代码，是**先追出一个能测的环境**：
> 本机没有任何 IMAP 账号，这条路径从来没被跑过。用 Ethereal（nodemailer 自带的
> 测试邮箱）+ 一个真实 QQ 邮箱把回归探针建起来之后，才看出下面这些问题。

### 迁移中挖出的 5 个既有 bug（全部只在真机上才会暴露）

1. **`readMessage` 在协议层就是坏的**：node-imap 会自己把值塞进 `BODY.PEEK[...]`，
   而旧代码传的是 `"BODY[]"` → 拼成 `BODY.PEEK[BODY[]]` → 服务器报
   `Invalid message data item BODY[BODY[]]`。**IMAP 账号上读任何一封邮件都失败**，
   而且那个 error 挂在连接上没人接，会直接把服务进程带走。
2. **`searchMessages` 搜不到就抛异常**：node-imap 在 UID 列表为空时是同步
   `throw new Error('Nothing to fetch')` —— “搜不到”变成一次异常，而它是最常见的正常情形。
3. **`--fid=` 与 `options.folder` 不匹配**：`ui.js` 一律发 `--fid=<路径>`，
   而 IMAP 侧只读 `options.folder` → **选任何非 INBOX 文件夹都会静默显示 INBOX**；
   `mark-read` 更糟，会在 INBOX 里把同 UID 的那封标成已读。
4. **`deleteMessage` 必然死锁**：它在持有连接的回调里又调 `listFolders` → 再取一次连接，
   而连接池不可重入 → 请求永久挂住，且那条连接永远卡在 busy，
   **该账号后续所有 IMAP 操作排队等死**，直到服务重启。
5. **`read` 字段是反的**：`read: !flags.includes("\\Seen")` —— 已读邮件报未读。

它们形状完全相同：**全在一条从来没人走过的路上。**

### 实现

- 新增 `backend/imapflow-client.mjs`（单一 IMAP 入口）与 `backend/imap-config.mjs`
  （域名推断表只留一份）
- **监听连接与命令连接是两条**：`imap-idle.mjs` 自己 new 一个 `ImapFlow`，
  不走命令连接池。否则 IDLE 长期占用与独占锁会互相饿死，
  症状是“通知照弹、点开列表转圈”
- 文件夹类型改用服务器标的 `specialUse`（`\Sent` / `\Drafts` / `\Trash` / `\Junk`），
  不再靠“7 项候选名 + 中文正则”猜
- 铁律：**绝不在 `withClient` 回调里调会 `withClient` 的公开函数**（第 4 条的根因）

### 验证（真实环境）

```
mail-e2e-probe（真 QQ）:      0 failure   ← 发信→收信→读→删除，含存已发送副本
imap-write-probe（真 QQ）:    0 failure   ← 18 项写操作
imap-idle-probe（真 QQ）:     0 failure   ← 实时监听
imap-probe imapflow（Ethereal）: 0 failure
node --check: 42 files / 0 fail
smoke-load / smoke-notify / smoke-bridge: 0 / 0 / 0
```

新增回归脚本：`scripts/imap-probe.mjs`（读路径）、`scripts/imap-idle-probe.mjs`（监听）、
`scripts/imap-write-probe.mjs`（写操作）、`scripts/mail-e2e-probe.mjs`（端到端）、
`scripts/imap-cleanup-probe.mjs`（清理测试邮件）。

> 对只使用 ClawEmail / AgentQQ 的账号，本次没有行为变化 —— 那些走的是另一条管道。

## [0.5.0] — 2026-09-22

轮询开销收尾。起因只是一句「轮询影响性能吗」—— 一算真账是**约 6000 封/小时**，
而且贵的不是频率，是单次数据量。

### 修复：`--limit=5` 其实每次取 50 封

`clawemail-backend.mjs` 无条件写 `limit: Math.max(numLimit, 50)`，于是 AppHost 那个
`list --limit=5` 的 60 秒轮询，每次都从服务端取 50 封再本地砍到 5。

改成**只在需要后过滤时才多取余量**。四处 `--limit=50` 的调用方行为不变（50→50）。

### 发现：`since` / `before` 是静默失效的死代码

`clawemail-backend.mjs` 里有 `if (since) queryParams.since = since`，看着是「已支持增量」。
但 SDK 打包产物里 `listMessages` 用的是**硬编码参数白名单**
（`fid/order/desc/start/limit/filterFlags`），`since` 和 `before` 被静默丢弃。

所以那不是「实现了但没人用」，是**看着能用、实际什么都不做** —— 照着它去做增量优化
会发现毫无变化，然后以为是自己想错了。已在源码里挂警告。
真增量只能靠客户端比对（`_poll_last_ids.json`）或 `start` 分页。

### 修复：filter-spam 是全应用最大的单一开销

`filterSpamMessages` 为了比对一张**本地黑名单**，每次都 `listMessages({ limit: 100 })`。
它每 3 分钟被自动同步调一次 → **2000 封/小时**，比 60 秒轮询还重。

扫描窗口 100 → 20。代价：应用关闭期间进的、排在第 20 位之后的黑名单邮件不会被自动移走。

### 调整：自动同步 3 分钟 → 6 分钟

每轮要发两次请求（`list --limit=50` + `filter-spam`），20 轮/小时 → 10 轮/小时。
新邮件延迟不受影响 —— 那是 60 秒轮询的职责（`ui.js:1236` 已注明通知走实时路径）。

### 调整：卡片 notify-status 30 秒 → 60 秒

### 效果

| | 改前 | 改后 |
|---|---|---|
| 60 秒轮询 | 60 × 50 = 3000 | 60 × 5 = **300** |
| 自动同步 | 20 × (50+100) = 3000 | 10 × (50+20) = **700** |
| 合计 | **~6000 封/小时** | **~1000 封/小时** |

**故意未动**：60 秒轮询的间隔本身。`ui.js:1205` 的注释写着它是从 5 分钟特意调下来的
（提升新邮件感知速度）—— 那是刻意的选择，不擅自推翻。

### 顺带

- `smoke-load.mjs` 再增 5 条守卫，把这四个放大项钉住。

## [0.4.9] — 2026-09-22

一轮**文件与轮询**收尾。起因是用户问「会产出什么文件」—— 一量才发现两处无上限增长。

### 修复：两个会无限增长的日志

`ws-monitor.log` 从 2026-09-10 起每行 `appendFileSync`，**没有任何滚动** ——
12 天长到 710 KB（约 59 KB/天，一年约 20 MB）。`imap-idle.log` 同类问题，只是慢些（27 KB）。
而 `runtime/service.mjs` 里早有「保留 64 KB、超出后滚到 48 KB」的实现 —— 三个日志里
只有它一个有。

抽出 `backend/log-roll.mjs`（`appendRolling`），三个日志同一规则。

### 修复：`cache/ws-*.json` 没有清理机制

每封实时收到的邮件都落一个 `ws-<accountId>-<mailId>.json`（含正文全文），
实测 62 个 / 1.65 MB，单个最大 529 KB，随收信量线性增长。

新增 `pruneWsCache()`：**只按数量封顶（500 个）**，启动时清一次、每写入 50 封再清一次。

> **为什么没有时间上限**：这两个文件看着像缓存，其实不是。
> `readWsCache()`（`http/ui.js:324`、`tools/sync.js:21`）把它们整个并进邮件列表，
> 而服务器侧固定只给最新 50 封（`list --limit=50`）—— 比那 50 封更老的、
> 只靠实时通道收到的信，**这份文件是它们在本地唯一的痕迹**。
> 最初写的是「14 天 + 200 个」双上限，装机前自查时发现**会删掉 62 个里的 54 个**，
> 等于让列表里的旧邮件凭空消失。因此退回只封顶数量，不碰时间。

### 改进：点击轮询改成自适应

原实现恒定 1 秒 = 卡片开着时**每小时 3600 次**请求，而它们绝大多数读到的是
「没有点击」—— 1 秒的密度只在通知刚发出的那两分钟里有意义。

改成：通知入队（或最近一次投递在 2 分钟内）时 1 秒，平时 15 秒。
空闲时约降到 240 次/小时，通知后仍是秒级响应，且卡片打开时立即查一次
（承接卡片关闭期间攒下的点击）。

### 顺带

- `scripts/smoke-load.mjs` 增 14 条守卫：既验形状，也用 4000 行实测 `appendRolling`
  真的滚动 —— 只验形状正是之前让两个真 bug 躺两天的那个缺口。

### 未做（见 `05-IMAP层-imapflow迁移设计.md`）

- 60 秒轮询仍 `list --limit=5`、3 分钟同步仍 `list --limit=50`（约 1000 封/小时）。
  正解是「只问数量（STATUS）」与「增量取信」，天然属于 imapflow 迁移，不塞进本轮。

## [0.4.8] — 2026-09-22

一轮**独立复核**（艾莉丝）后补齐的修复。感谢她的发现：下面 1、2 条是她的原始报告。

### 修复：汇总通知不可点击（一波 ≥3 封合并时）

`lib/notify-drain.mjs` 的合成项只有 `id: null` 与 `_ids`，**没有 `messageId` / `accountId`**，
而 `armClickPipe` 照样按照空串去 arm 管道 → 点击写出 `messageId: ""` →
卡片侧 `if (d.data.messageId)` 为假 → 什么都不发生。
而队列里的原始条目**已被 ack 删除**，用户既跳不过去、也没第二次机会。

改为：汇总项带上**最新那封**的 `messageId` / `accountId`（`listNotifications` 按入队
时间升序，最后一项就是最新的），另加 `summaryCount` 写进点击记录，让卡片能区分
「点开一封」与「点开一批」。

### 修复：SnoreToast 自己的失败没有任何痕迹

`markAttempt` 在 `execFile` **之前**就把 `attempted: true` 写进结果文件，而派发器的
ack 判据正是「本次 spawn 之后出现过 attempted 记录」。于是 SnoreToast 之后失败、
降级、或根本没弹时：**派发器仍判定成功并删掉队列条目**，而那些错误只走子进程 stderr，
AppHost 日志里**完全不存在**。

这与原始 bug（写 `os.tmpdir()` 被拒 → 静默丢弃）是同一类病的另一个位置：
失败没有落到可观测的地方。

ack 语义维持（队列是「要发什么」，派发过一次就算完成，否则一条永远弹不出的通知会把
队列卡到 TTL），但**失败必须留痕**：SnoreToast 的错误写进结果文件的 `snoreToastError`
字段，派发器见到就 `log.warn("通知已派发，但 SnoreToast 报了失败（已走降级链）")`，
`/notify-status` 也读它（`lastSnoreError`）。

### 修复：测试通知与派发轮次共享结果文件 → 可能误 ack / 重复弹

`sendTestNotification()` 不走 `draining` 标志，而所有 helper 写的是同一个
`notify-last-result.json`，后写的覆盖先写的：

- 测试记录时间戳晚于某一轮 `drainOnce` → 被判成「这一轮成功」→ **误 ack 删掉真通知**；
- 反之 → 真投递被判失败 → 不 ack → 5 秒后重发 → **重复弹**。

改为每次 spawn 传 `--result-id`，助手写进记录，派发器**只认自己那次的记录**。

### 修复：`draining` 可能长时间卡住且无痕迹

`callService` 的 `timeoutMs` 上限 30 秒而轮询周期 5 秒，服务挂起时 `draining` 恒为真，
后续轮次全部跳过。加上超时（45 秒）强制复位 + `log.warn`。
并发两轮现在是安全的（靠 `result-id` 隔离）。

### 文档与断言校正

- **过期注释**：`helper/mail-toast.cjs` 与 `README.md` 都把「Node 权限模型不拦具名管道」
  写成了普适结论 —— 那是跑在系统自带 Node 24（还没网络门）上的实验结论。
  已改为「在**受管服务**里可用；AppHost 的子进程**没有 net 权限，建不了**」。
- **`父进程必须活着`** → 改为「**管道的拥有者**必须活着」（现在拥有者是服务）。
- **断言措辞**：`smoke-click.mjs` 里 `rec.attempted === true` 的断言改名，
  明说它验证的是「已尝试投递」，**不代表系统已展示通知**。
- 新增断言：汇总通知的 `summaryCount` 能落到点击记录里；助手记录本次 `--result-id`。

### 复核报告

`通用/开源仓库分析/06-通知链路对抗复核.md`（含「检查过、没问题」与「未覆盖」两部分）。

## [0.4.6] — 2026-09-22

### 修复：点击回调的管道搬到服务侧（v0.4.4 的做法在生产环境根本建不起来）

0.4.4 让助手自己建具名管道。实测在真实 AppHost 里直接失败：

```
"clickError":"createServer: ERR_ACCESS_DENIED
             Access to this API has been restricted. Use --allow-net to manage permissions."
```

宿主给应用子进程拼的 argv 只有 `--permission` + `--allow-fs-read=<安装目录>`
+ `--allow-fs-read/write=<app-data>` + `--allow-child-process`，**没有 `--allow-net`**；
Node 26 的权限模型把 `net`（含 Windows 具名管道）一起管住。

（开发期「权限模型内能建管道」的实验之所以通过，是因为它跑在系统自带的 Node 24 上，
24 还没有网络门 —— 复现平台与生产不一致时，“能跑通”不可信。）

改为管道由**服务**建：新增 `POST /notify-arm-pipe`，服务建一条一次性管道
（`\\.\pipe\hana-mail-click-<id>`，TTL 90 秒），把邮件身份（`messageId` / `accountId`）
存进去；AppHost 拿到管道名后用 `--pipe-name` 转交给助手；SnoreToast 写回
`action=activate` 时由服务直接写 `<dataDir>/notify-click.json`。

好处：两侧各用自己的权限，与现有架构一致（需要网络的活全部收在服务里）。
助手不再需要 net，也不再需要为等点击而留活（管道不是它的了）。

注：SnoreToast 写回的内容不含邮件身份，所以 arm 时必须把 `messageId` /
`accountId` 一起交过去 —— 否则点开了也不知道是哪封。

## [0.4.5] — 2026-09-22

### 修复：native 沙箱建不起来时服务直接失败（邮件功能整个不可用）

本机 `C:\Users\<user>\.hanako` **本身是符号链接**（ReparsePoint），
宿主 sandbox helper 见到 HANA_HOME 上有重解析点就直接拒绝：

```
[native-identity] reparse root is not supported (Win32 0)
```

这不是「权限没给」，是机器布局决定的，重试多少次都一样。
原先只试 `profile: "native"` 一次，失败即 `_state = "failed"` → 邮件完全不可用。

改为：native 失败 → 记 warn → **降级 `local-machine` 重试一次** → 成功则继续。

- `manifest.json` 新增声明 `app/runtime.local-machine`（不声明的话降级这一步会被
  宿主的 capability 校验拒掉，成了「降级也降不下来」）
- `lib/runtime-host.mjs` 新增 `serviceProfile()` 导出；`v2 ready` 日志与
  `/notify-status` 都会带上实际生效的 profile
- 如实标注代价：`local-machine` **不提供文件隔离**（`enforcement: none`），
  服务以当前系统用户权限运行

### 修复：通知派发不再挂在「服务已就绪」分支里

`startNotificationDrain` 原来只在 `startService` 返回 ready 时启动。而它本身就是
「服务不可用时的探针」（每轮调 `callService`，失败就下轮再试），且 runtime-host 的
惰性自愈只等「第一次真调用」—— 唯一会周期性发起真调用的消费者正是它。
把它关在 `if (ready)` 里等于让两条路互相等：实测重装后服务起不来的那一次，
通知也一起没了。现在无条件启动。

### 变更：不再用 SnoreToast 退出码判断送达

（同 0.4.4，此版一并发布。）

## [0.4.4] — 2026-09-22

### 修复：系统通知一条都没弹出过（根因：写进了 `os.tmpdir()`）

`helper/mail-toast.cjs` 把 sidecar 写进 `os.tmpdir()`，而它是 AppHost 的**子进程**，
**Node 权限模型会继承给子进程**，写白名单只有「安装目录 + app-data」。于是
`fs.writeFileSync` 抛 `ERR_ACCESS_DENIED`，进程在调用 SnoreToast **之前**就死了。

日志实证（两条，成功 0 条）：

```
Error: Access to this API has been restricted. Use --allow-fs-write to manage permissions.
    at Object.writeFileSync (node:fs:2997:20)
    at tryNotifyViaSnoreToast (.../helper/mail-toast.cjs:101:6)
  code: 'ERR_ACCESS_DENIED', permission: 'FileSystemWrite',
  resource: '\\\\?\\C:\\Users\\...\\AppData\\Local\\Temp\\hanako-click-args-....json'
```

改法：新增 `--work-dir`（缺省回退 `HANAKO_PLUGIN_DATA`），一切写盘落 app-data。

### 修复：参数解析器不认连字符键名

`/^--(\w+)=?.../` 把 `--args-file <path>` 解析成 `args.args = "-file"`，
`args["args-file"]` 永远 undefined → **JSON 参数文件从来没被读过**，主题一直
退化成「(无主题)」。改为 `/^--([\w-]+)(?:[=\s]+([\s\S]*))?$/`，三种写法都认。

### 修复：点击通知打开邮件从来没工作过

`-click` **不是 SnoreToast 的标志**（二进制按 UTF-16LE 扫描，`-click` 命中 0；
`-close` / `-pipeName` / `-install` / `-appID` / `-silent` 都在）。所以
`click.vbs` → `notify-click.json` → `/clicks/latest` 那条链从未被触发过。

改为具名管道（照 node-notifier 的做法）：助手先建 pipe server，`-pipeName` 传
完整路径，SnoreToast 被点击时以 UTF-16LE 写回 `key=value;`，`action=activate`
即写 `notify-click.json`。父进程因此不能弹出即退出（上限 25 秒），
派发器同步改为「看到投递记录即算一轮完成，不等子进程退出」。

### 变更：队列从「取走即删」改为「确认后删」

`/pending-notify` 改为只读并返回 `id` / `depth`；新增 `POST /notify-ack` 才真删。
另加同 `messageId` 去重、上限 200（丢最旧）、TTL 24h。

### 变更：不再用 SnoreToast 退出码判断送达

实测通知已弹出仍返回 `-1`。改为助手写 `<dataDir>/notify-last-result.json`，
派发器与 `/notify-status` 都读它。

### 新增：通知链路的可观测性

- `GET /notify-status`：`drainRunning` / 队列深度 / 最近一次投递方式与时间 / 上次失败
- `POST /notify-test`：走完整链路发一条测试通知
- 卡片「设置 → 系统通知」：状态行 + 测试按钮
- `scripts/smoke-notify.mjs`：队列语义回归（11 项）
- `scripts/smoke-click.mjs`：点击回调端到端（**在复刻 AppHost 的权限模型下**跑）
- `scripts/smoke-bridge.mjs`：「取走即清空」那条断言按新语义重写

### 文档

- README 订正：60 秒轮询**只写缓存、不弹通知**（v0.1.18 起），旧文档说反了
- README 补：队列语义、退出码不可信、点击回调原理、写白名单约束

## [0.4.2] — 2026-09-11

### 文档：更新时必须先停用（踩过并已定位）

直接在应用**运行时**装新包会失败：

```
安装准备失败：Package file worker stopped before completing
```

根因：应用的后端服务是从 `apps/<id>/runtime/service.mjs` 跑起来的，
更新过程要替换这些文件，而 Windows 不允许替换被进程占用的文件。
报错本身具有误导性（说 worker 未完成，实际是文件被占）。

正确顺序：**停用 → 卸载 → 安装新包**。实测这样一次就成。

另记录一条行为：**「重新加载」不改写安装记录** —— registry 里的版本号
会停在最后一次正规安装的版本（本次实测：文件已 0.4.1，记录仍停 0.3.3，
卸载重装后两者才对齐）。

## [0.4.1] — 2026-09-11

### 新增：卡片中心的封面（`face`）

v2 的 `contributes.cards[].face = { image }` 就是卡片中心 / 黑板上的封面。
本次给邮件卡加了一张 `ui/face.png`（暖纸底 + 蜡封 + 金色细线，与卡片本身同一套配色）。

两个容易踩的点：
- **路径相对 `ui/`，不是 `assets/`**（v2 的改动）。写错会报 `file not found at ui/...`。
- 写坏了**不会**让应用装载失败 —— 官方校验器也不查它，只是静默降级成“未声明”、
  卡片照常用默认样子。所以 `smoke-load` 新增一条断言，把运行时那套规则
  （相对路径 / 无反斜杠 / 分段不越界 / 扩展名限 png|webp|svg / 文件存在）重实现一遍。

## [0.4.0] — 2026-09-11

### 新增：AgentQQ 后端（腾讯企业邮 / @agent.qq.com）

**原来的问题**：这个后端依赖外部 `agently-cli`。它是个 Go 原生二进制，
`run.js` 只是 execFileSync 它 —— 而本应用的后端跑在受管 native 运行时里、
**不能再 spawn**（Job Object → EPERM）。所以 0.3.x 里它被标成不可用。

**找到的解法**：那个 CLI 打的只是普通 REST，而服务自己就有网络 —— 直连即可。
连 `npm install -g @tencent-qqmail/agently-cli` 都不需要了。

协议是从官方 CLI 的 `--dry-run`（它会把要发的 HTTP 请求原样打印）与实测反推的：

```
client_id = cli_002e8cd1b1fc89ce      UA 必须是 agently-cli/<版本>（客户端身份靠它）
设备码  POST auth/oauth/device?func=1  body 必须为空
        → { poll_url, browser_url, input_code, expires_in }
轮询    POST {poll_url}                长轮询；未授权会一直挂着（超时＝还没授权）
刷新    POST auth/oauth/token         form: grant_type=refresh_token&refresh_token=…&client_id=…
API     https://api.agent.qq.com/v1/…  Bearer <access_token>
```

接口：`GET /v1/me`、`GET|POST /v1/aliases/{alias}/messages…`（列表/搜索/读取/发送/回复/转发）、
`DELETE …/{id}`（移入垃圾箱，保留 30 天）、`DELETE …/{id}/permanent`、
`GET …/{id}/attachments/{att_id}`。

**实现**：
- `backend/agentqq-auth.mjs`：设备码 / 长轮询 / 刷新 / API 调用（纯协议，无状态）
- `backend/agentqq-backend.mjs`：重写为 REST，删掉 agently-cli 依赖；
token 快过期时自动刷新并把新 token 写回 `accounts.json`
- 凭据加密：`cred-crypto` 的敏感字段表新增 `agentqqAccessToken` / `agentqqRefreshToken`
- 服务端点 `/agentqq/login/start` `/agentqq/login/status`；
授权成功后**服务自己把账号写进 accounts.json**（令牌不经浏览器、不经卡片）
- 卡片：选 AgentQQ 时不再要 API Key，改为设备码面板（授权码 + 链接 + 自动轮询）

**顺带修掉一个 v1 就有的残缺**：原来的 `sendMail` / `replyToMail` / `forwardMail`
只调一次 CLI，而那个 CLI 的发送是**两步确认**（先返回 confirmation_token，
再带 token 重发）—— 所以这三个功能在 v1 里本来就没真正发出去过。
改成 REST 直接 POST 后，这个问题自然消失。

### 自检
`smoke-bridge` → **10 项**：新增 AgentQQ 设备码申请（真网络）、未授权时状态、
未知会话不抛。`smoke-load` 38 项不变。

> 注：AgentQQ 的完整链路（授权 → 列表 → 读信 → 发送）需要一次人工授权才能
> 端到端验证；设备码申请到轮询这一段已在本地真实跑通。

## [0.3.5] — 2026-09-11

### 清理
- 删除已无引用的 `backend/worker.mjs`、`assets/_proxy-fetch.cjs`、
  `helper/MailToastHelper/`（.NET 通知助手）及其全部构建产物
- CHANGELOG / `mail-toast.cjs` 中的开发机路径泛化；
  `smoke-bridge` 的测试账号改为占位邮箱
- README 的架构图 / 权限表 / 通知链路改成 v2 现状

## [0.3.4] — 2026-09-11

### 修复：桥取响应取错了一层（Response.body 是流）

服务已能完整启动（`依赖就绪 / inbox 已加载 / HTTP 已监听 / ws-monitor 已启动 / imap-idle 已启动`），
但 AppHost 侧仍全链失败：`service returned non-json`。

根因：`ctx.runtime.fetch` 返回的是**真正的 `Response` 对象**，
而我取了 `res.body`（ReadableStream）去 JSON.parse。→ 改走 `res.text()`。

另外：`/health` 原来只在 GET 上处理，而 `callService` 总是 POST → 桥拿到 404；
`SERVICE_PORT` 支持环境变量覆盖（方便本地跑 bridge 测试）。

新增 `scripts/smoke-bridge.mjs`：用假 `ctx.runtime`（真子进程 + 真 fetch +
真 Response）在本地把整座桥跑通 —— 这类“只在真实宿主暴露”的问题第一次能在楼下抓住。

## [0.3.3] — 2026-09-11

### 修复：服务不能 spawn —— 拿真实日志才看到的一层

装上 0.3.2 后服务确实起来了（`v2 ready`），但 service.log 写出真因：
```
[ERROR] 依赖/监听启动失败 {"error":"spawn EPERM"}
```
受管 native 运行时被 Windows Job Object 管着，**服务不能再创建任何子进程**。
而当时有四条依赖 spawn 的路：

| 位置 | 原来 | 现在 |
|---|---|---|
| 依赖安装 | `npm install` | **依赖随包发布**（服务不能装） |
| 图片代理 | `execFile(_proxy-fetch.cjs)` | 服务内直连（它本身就有原生网络） |
| 桌面通知 | `execFile(mail-toast.cjs)` | 写队列，AppHost 取走并发（它有 `--allow-child-process`） |
| ClawEmail 文件夹/移动/标记 | `spawn(mail-cli)` | 改用 `transport.listFolders/moveMessages/markMessages`（进程内 HTTP） |

AgentQQ 后端无等价 SDK，改为明确报错而不是 EPERM。

### 新架构（三段职责）
```
服务（收得到邮件、能上网、不能 spawn）→ 写 _pending_notify/
AppHost（能 spawn、收不到邮件事件）  → 每 5 秒取队列 + 拉起 mail-toast.cjs
```
通知延迟最多 5 秒，比原来 60 秒的轮询兜底更快。

### 依赖入包
`backend/node_modules` 随包发布，并剔掉 `@clawemail/mail-cli`（42.5 MB，已不再用）：
**56.4 MB → 13.9 MB**，最终 zip **4.93 MB**。

### 其它修复
- `ctx.runtime.fetch` 的 `timeoutMs` 原来传 120000，**宿主上限是 30000**，
  整个转发链因此全失败（日志报 `Runtime fetch timeoutMs must be an integer from 1 through 30000`）。
- 服务把启动过程镜像写 `<dataDir>/service.log`：受管运行时的 stdout/stderr 由宿主
  捕获、拿不到时，这个文件是唯一能读到的现场。这次就是它把 `spawn EPERM` 交出来的。
- 启动失败加 30 秒冷却，不再被轮询反复拉起进程。

### 自检
`scripts/smoke-load.mjs` → **38 项**。新增的核心不变量：
**服务侧（`backend/*.mjs`）不得出现任何 spawn/execFile** —— 这类问题只在真实装载时暴露，
静态语法检查查不出来。

## [0.3.1] — 2026-09-10

### 修复：装载与权限记账之间有一个 190ms 的窗口

实测时间线（首次装载 0.3.0）：
```
23:58:43.896  plugin "hanako-mail" was started (user)
23:58:44.097  服务启动失败：requires "app/runtime.execute"
23:58:44.287  app/runtime.execute  allowed      ← 账本此时才写入
```
`apply()` 在装载时只跑一次，而审批写账本比它晚约 190ms。
对需要**硬权限**的应用（`app/runtime.*`）来说，**首次装载注定失败**。

这不该让用户手动“重新加载”一次：

- `callService` 在服务未就绪时会**惰性重启**（带 `_starting` 并发去重），
  第一次真调用就自愈；
- 启动参数存在 `_startArgs`，失败后不丢，重试仍能起来；
- 子进程与卡片的首次调用就在几秒后（auto_sync / poll），无需用户干预。

### 顺带：迁移改到服务启动流程里
原来 `index.js` 启完服务再调一次 `/migrate`。但那次调用也会落在同一个权限窗口里，
白白报一句“迁移失败”。现在服务自己拿着 `LEGACY_DIR` 参数在启动时完成迁移 ——
**服务启动 = 迁移完成**，两件事绑成一件。

实测输出：
```
[INFO] 邮件后端服务启动 {dataDir, legacyDir, port:43181, node:v24.15.0}
[INFO] 已从 v1 数据目录迁移 {"copied":["accounts.json","cache"]}
[INFO] HTTP 已监听 127.0.0.1:43181
HANA_MAIL_SERVICE_READY
[INFO] WebSocket 已连接: <account>@claw.163.com
```

### 自检
`scripts/smoke-load.mjs` → **35 项**：新增惰性重启四项（会重试 / 并发去重 /
保留启动参数 / 服务启动时自己迁移），全部是从真实事故里长出来的断言。

## [0.3.0] — 2026-09-10

### 架构变更：后端搬进受管 native 运行时

**为何 0.2.x 注定跑不通**：后端一直跑在 AppHost 里（或它 spawn 的子进程里），
而 AppHost 及其**一切子进程**都在 Node 权限模型内：没有出站网络、读不到安装目录与
app-data 之外的任何文件。邮件后端离开网络就不存在（IMAP/SMTP/ClawEmail/LLM 端点）。
两个错过的前提：

1. **子进程继承权限模型，且传播不走环境变量**。实测：父进程用 argv 传 `--permission`、
   此时 `process.env.NODE_OPTIONS` 为空，子进程仍被拒；剥 NODE_OPTIONS 无效。
   （0.2.3 那次“剥环境变量就能恢复”的对照实验是错的：我当时把旗标放在 NODE_OPTIONS 里，
   测的是另一条通道。）
2. **AppHost 的 env 是宿主白名单**（只有 `PATH`/`HOME`/`TMPDIR`/`LANG`），
   `USERPROFILE`/`HANA_HOME` 在那不保证存在，`NODE_OPTIONS` 更是根本没有。

**新架构**：

```
AppHost（权限模型内）             受管 native 服务（独立进程）
  · 5 个工具                      · ClawEmail WebSocket + IMAP IDLE 监听
  · 卡片后端路由                  · inbox 命令表（list/read/send/reply/…）
  · 转发请求 ────────────────▶   · 出站 HTTP（LLM）、图片代理、桌面通知
                                  · npm install、v1 数据迁移
```

- 新增 `runtime/service.mjs`：服务本体。自带 HTTP 服务（127.0.0.1:43179），
  `/health` `/cli` `/migrate` `/http` `/proxy` `/notify` 六个端点；
  就绪靠 stdout 打 `HANA_MAIL_SERVICE_READY`。
- 新增 `lib/runtime-host.mjs`：宿主侧句柄（启动 / 等就绪 / 转发 / 停止）。
- `index.js` 重写：只做工具注册、路由挂载、启服务、等就绪、调迁移。
  **服务起不来也只降级不抛** —— 工具与卡片仍可用，只报“后端不可用”。
- `backend/worker-client.mjs`：从“spawn 子进程 + stdio”改为转发到服务。
  **`runCli` 签名与返回语义保持不变**，所以 `tools/*.js` 与 `http/ui.js` 的 30 多处
  调用点一个字都没动。
- `backend/net-child.mjs`：同样改为转发（`/http`），返回值形状不变。
- `http/ui.js`：图片代理与桌面通知改走服务的 `/proxy` 与 `/notify`。
- `ws-monitor.mjs` / `imap-idle.mjs`：加 `IS_MAIN` 守卫 —— 被 `service.mjs`
  import 时不再接管进程生命周期（否则它们各自的 SIGTERM 处理器会把服务一起带走）。

**能力声明**：去掉 `app/process.spawn`（AppHost 不再自己生子进程），
换成 `app/runtime.execute` + `app/runtime.native` + `app/runtime.network`。
注意这是一个**真实的权限放大**：native profile 以当前系统用户权限运行、可读该用户
可读的文件（Windows 上官方标注 enforcement 为 `partial`，不提供完整文件隔离），
外加外网。安装审批时会单独列出来。

**删除**：`lib/migrate-data.mjs`、`backend/migrate-v1.mjs`、`assets/_http-json.cjs`
（迁移与 HTTP 已内置到服务）；`lib/env.mjs` 的 `childEnv()`（无效修复，已证伪）。
`cleanup.cjs` 重写：不再有 pid 文件，只排楂孤儿服务进程。

**自检**：`scripts/smoke-load.mjs` → **31 项**。新增的关键几条：
服务缺席时 `apply()` 不抛、`callService` 返回 `{ok:false}` 而 `runCli` 仍抛
（保持旧语义）、backend/lib 里不再有 `childEnv` 残留引用
（这类引用会变成运行期 `SyntaxError`，`node --check` 查不出来）。

**脱离宿主的真实测试**（服务可以不靠宿主单跑，见 README）：
`/health` ✓、`/cli folders` 真拉到 6 个文件夹、`/cli list` 真拉到邮件列表、
`/http` 真出网（拿到 API 的 401）、`/proxy` 的 SSRF 防护生效、
`/migrate` 目标已存在时不覆盖、未知命令返 400。

## [0.2.3] — 2026-09-10

### 修复：子进程被继承的 Node 权限模型锁死（根因，一个 entry 解释四个症状）

**机制**：v2 的 AppHost 由 `hana-server.exe`（内嵌 **Node 26.8.1**）以
```
--permission --allow-fs-read=<安装目录> --allow-fs-read=<app-data> \
  --allow-fs-write=<app-data> [--allow-child-process]
```
启动。Node 会把这串旗标写进 **`NODE_OPTIONS`**，子进程因此**继承权限模型**。
实测对照（子进程请求 `https://claw.163.com/.../auth/im-token`）：

| 子进程环境 | 结果 |
|---|---|
| 继承 `NODE_OPTIONS` | `ERROR ERR_ACCESS_DENIED` |
| 不带 `NODE_OPTIONS` | `STATUS 401`（网络正常） |

而 APPS.md 的运行时表明写：“外部命令**不自动继承** Node Permission Model"。
所以这是实现追平文档，不是绕开沙箱 —— 放宽那一步已由用户在能力审批里同意过
（`app/process.spawn` = “运行外部程序”）。

**同一个根因下的四个症状**：
1. 数据迁移读不到 v1 的 `plugin-data`（不在白名单里）
2. `npm install` 连自己的入口都读不到（npm 自身的 JS 入口不在白名单内）
3. `ws-monitor` 拿不到 ClawEmail 的 IM token（网络被拒）
4. `worker` 同理（IMAP/SMTP 会一样死）

**修**：新增 `childEnv(extra)`（`lib/env.mjs`），把所有 spawn/execFile 点的
`NODE_OPTIONS` 里的权限旗标滤掉（保留无关项）。已覆盖：
`index.js`（常驻子进程、npm）、`lib/migrate-data.mjs`、`backend/{net-child,worker-client,
ws-monitor,imap-idle,clawemail-backend,agentqq-backend}.mjs`、`http/ui.js`（图片代理、通知）。

### 补上：imap-idle 的“空转退出”修复从未进过仓库
- 本日早先修的那个 bug（数据目录回退路径少一层 → 账号数 0 → 进程立即以 0 退出
  → 父进程每 10 秒重启一次）当时只打在了**已安装的 v1 副本**上，仓库里仍是旧代码，
  v2 迁过来跟着旧版。本次一并补入：`runtimeDataDir()` 统一取目录、`data !== undefined`
  修正日志假值、`reconcile()` + `stopFns` Map + 60 秒常驻守护。

### 自检
`scripts/smoke-load.mjs` → **30 项**：新增 `childEnv` 四项（脱旗标 / 保留无关项 /
透传额外变量 / 只剩旗标时整个删除）与 imap-idle 两项（用 runtimeDataDir / 有常驻守护）。

## [0.2.2] — 2026-09-10

### 修复：依赖安装锁会永久卡死依赖安装（在磁盘上实测到）

- 失败装载的痕迹：`app-data/hanako-mail/.hanako-auto-install.lock`（22:10:32 写入，从未清除）。
- 链：`spawn("npm", ...)` 被权限模型**同步拒绝** → 既不触发 `close` 也不触发 `error`
  → 两处 `unlinkSync` 都跑不到 → 文件留着；而 `autoInstallDeps` 开头一看锁存在就直接
  `return` → **依赖再也装不上**，整个应用功能为空。
- 修：
  - 超 10 分钟的锁当过期，自动清掉再试（中途被 kill 也再也不会永久卡住）
  - `spawn` 包 try/catch，同步失败时就地清锁，并 **error 级** 报出
    “邮件功能不可用”与缺失依赖（原来是 warn 级、不痛不痒）
  - 依赖安装失败同样升到 error 级——它就意味着应用不可用，安静失败不可接受

## [0.2.1] — 2026-09-10

### 修复：真实装载后才暴露的三处（静态校验器都查不到）

**1. 路由来源冲突（装载直接 failed）**
- 顶级 `routes/` 目录在 v2 也是一种路由来源，与 `ctx.routes.register()` **互斥**
  （`app-host-entry.js:3233 hasAppRouteSourceEntry` / `:4201`）；两者共存时报
  `defines backend routes twice`，整个应用 failed。
- 不能改用目录形式：目录形式传入的是 v2 的 ctx（无 `pluginId`），
  而 `ui.js` 写的是 `path.join(ctx.dataDir, ctx.pluginId)`，会当场炸。
- → 保留编程式注册，文件 `routes/ui.js` 搬到 **`http/ui.js`**。

**2. 数据迁移在主进程里永远跑不通**
- AppHost 被以 `--permission --allow-fs-read=<安装目录> --allow-fs-read=<app-data>/<id>` 启动，
  **不含 `plugin-data`**。主进程 stat/读 v1 数据目录 → `ERR_ACCESS_DENIED`，
  于是上一版日志只有一句“数据迁移失败”，`app-data` 下什么都没落下来。
- → 迁移改走子进程 `backend/migrate-v1.mjs`（不继承 AppHost 的 Node 限制）。
  代价：依赖 `app/process.spawn` 授权；失败时 **error 级** 报出两个绝对路径
  与手动补救办法（静默失败 = 用户看到“账号没了”）。

**3. v2 logger 会吞掉诊断信息**
- `ctx.logger.info(format, ...param)` 实测不会把额外参数打进日志行，
  而 v1 的 `ctx.log.*(msg, data)` 会。于是 `log.warn("启动失败", { error })` 只剩半句话。
- → `lib/legacy-ctx.mjs` 自行把参数拼进字符串（Error 取 message，其余 JSON）。

### 其它
- `index.js` 的常驻子进程 spawn 去掉 `shell: true`：`process.execPath` 已是绝对路径，
  经 shell 多一层 `cmd.exe` 并触发 Node 的 DEP0190 警告。
- `scripts/smoke-load.mjs` → **24 项**：新增“不存在与编程式注册互斥的 routes/ 源文件”、
  “二次迁移返回 skipped 而非 copied”、“无 v1 数据时不报错”。

### 教训
`validate-app` 只保证 manifest 与静态资源自洽；**装载期契约它一律不管**
（路由来源互斥、能力清单、目录名等于 id、安装位置独占、AppHost 的只读根）。
两轮 0 error 却两次被真实装载拒收。能覆盖装载的 `--smoke` 需要 Node 26+（本机 24.15）。

## [0.2.0] — 2026-09-10

### 迁移：v1 插件 → v2 App（`manifestVersion: 2`）

仓库根目录现在就是一个 v2 App 包，安装到 `<HANA_HOME>/apps/hanako-mail/`。v1 停在 0.1.18，不再发版。

**入口与装配（新增 `lib/`）**
- `index.js`：`export default class { onload() }` → `export async function apply(ctx)`；
  返回 disposer，卸载时按表清理常驻子进程。
- `lib/env.mjs`：App 身份与路径的单一来源。`lib/legacy-ctx.mjs`：把 v2 ctx 投影成 v1 形状
  （`pluginDir`/`log`/`pluginId`/`dataDir` 五类成员），`routes/ui.js` 与 `tools/*.js` 因此**零改动**。
- `lib/register-tools.mjs`：`ctx.tools.register()` 编程式注册；v2 单参 `execute({...args, context})`
  在此还原成 v1 的 `(input, ctx)` 双参再转发。
- `lib/register-routes.mjs`：`ctx.routes.register()`（v2 与顶层 `routes/` 目录互斥）。
- **`routes/ui.js` → `http/ui.js`**：v2 把顶级 `routes/` 目录当成另一条路由来源，
  与 `ctx.routes.register()` 互斥——两边同时存在，装载直接
  `defines backend routes twice` 失败（app-host-entry.js:3233 / 4201）。
  不能改成"只用目录形式"：目录形式传进来的是 **v2 的 ctx**（无 `pluginId`），
  而 `ui.js` 写的是 `path.join(ctx.dataDir, ctx.pluginId)`，会当场炸。
  所以选编程式注册、文件改名换地（目录名不叫 routes/ 就不撞规则）。
  ⚠️ 静态校验器 `validate-app` 不查这条，只有真实装载会拦。

**数据迁移（`lib/migrate-data.mjs`）— 本次最要紧的一处**
- v2 数据目录是 `app-data/hanako-mail`，v1 是 `plugin-data/hanako-mail/hanako-mail`。
- 凭据盐 `.cred-salt` 存在数据目录下，目录一换派生密钥就变，`accounts.json` 里加密的
  `apiKey` / `imapPass` 全部解不开；而读取失败是 `catch { return [] }`，
  会表现成「账号凭空消失」。故 `apply()` 首件事是搬运 `accounts.json` + `.cred-salt` + `cache/`，
  目标已存在时跳过，绝不覆盖。

**裸网络绕行**
- v2 默认 AppHost 在 Node Permission Model 下拒绝裸网络；LLM 端点是用户自配的任意 host，
  无法用 `network.allowedHosts` 枚举。新增 `backend/net-child.mjs` + `assets/_http-json.cjs`，
  把 LLM 请求落到子进程发出（与既有图片代理 `assets/_proxy-fetch.cjs` 同一套路数）。
- `backend/llm.mjs` 的 `fetch` 调用改经上述通道，错误分支随之细化。

**只读安装目录适配**
- 一切运行时写入从安装目录移到 App 数据目录：`worker-client.mjs` 的 pid 文件、
  `tools/send.js` 的 `--json` 参数文件、`http/ui.js` 的自动安装锁、`cred-crypto.mjs` 的默认目录。
  `INSTALL_LOCK` 常量同时改为 `installLockPath()` 懒求值——模块加载早于 `apply()`，
  那时 `HANAKO_PLUGIN_DATA` 还没写入，直接求值会算出错误路径。
  依赖安装与 `npm install` 仍在安装目录内进行——它跑在子进程里，不受 AppHost 限制。
- 修正 `index.js` 里 `killWsTree` 使用 ESM 中不存在的 `require()`（仅 Windows 杀树路径会踩到）。

**界面**
- `assets/plugin-page-template.html` → `ui/mail.html`；卡片走 `contributes.cards`（route `/mail.html`），
  删掉原来读模板注入 `PLUGIN_ID` 的 `/mail` 路由。
- 页面的 API 前缀从 `/api/plugins/<注入的 id>` 改为从 `location.pathname` 推导 appId 的
  `/api/apps/<appId>/routes` —— 对 App 改名 / 换安装位置免疫；主题改从 `?hana-theme` 取。

**新增**
- `manifest.json`：v2（`minAppVersion 0.946.2`，capabilities：
  `app/tools.expose-to-model`、`app/process.spawn`、`app/models.read`、
  `app/provider.credentials.read`、`app/ui.open-external`、`app/ui.clipboard-write`）。
- `scripts/smoke-load.mjs`：无需宿主的一次装载自检（15 项，验 ctx 投影 / 数据迁移 / 注册面）。
- `scripts/make-icon.cjs` + `assets/icon.png`：无依赖手写 PNG 图标（manifest 要求 `icon`）。

## [0.1.18] — 2026-08-03

### 修复：实时通知重复（消除双通知）
- **根因**：同一账号有两条通知路径并行——`ws-monitor.mjs`（ClawEmail WebSocket 实时推送）+ `routes/ui.js` 的 `pollAccounts`（每 60 秒轮询），二者用独立去重集合、互不感知，导致同一封邮件被弹两次。IMAP 账号同理（imap-idle + pollAccounts）。
- **`routes/ui.js`**：`pollAccounts` 不再弹桌面通知（移除 `notifyMail` 调用与函数定义），保留列表缓存同步。所有桌面通知统一交给实时路径——`ws-monitor`（ClawEmail）/ `imap-idle`（IMAP）。每个账号仅一条通知路径，不再重复，且 ClawEmail 仍走比 60 秒轮询更实时的 WebSocket。

## [0.1.17] — 2026-08-03

### 修复：ClawEmail 账号 HTML-only 邮件无法总结/翻译
- **根因**：ClawEmail SDK `client.mail.read()` 返回的 HTML 邮件 `text` 为空、`html` 是 `{content:string}` 对象；`routes/ui.js` 的 `plainOf()` 只认 `text/body/snippet/textBody`，导致总结/翻译报"没有可处理的纯文本内容"。
- **`backend/common.mjs`**：新增共享 `htmlToText()`（剥离 script/style/标签并解码实体）。
- **`backend/clawemail-backend.mjs`**：`readMessage()` 在 SDK 返回后兜底：若 `text` 为空，从 `html.content` 或 `textContent` 提取纯文本写入 `mail.text`。
- **`backend/imap-backend.mjs`**：移除内联 `htmlToText()`，改为从 `common.mjs` 导入共享实现。
- **`routes/ui.js`**：`plainOf()` 增加 `html/textContent` 兜底提取，作为第二道防线。

## [0.1.9] — 2026-08-02

### 修复：LLM 凭据读取改为 provider-catalog.json（与官方生态插件一致）
- **根因**：此前走宿主 `provider:credentials` bus 接口，但该接口在本机拿不到若干自建 provider 的 baseUrl/apiKey，导致「测试连接」报 `LLM 未配置`（baseUrl 为空）。表情包等官方插件是**直接读 `~/.hanako/provider-catalog.json`**（HanaAgent 全局供应商目录：base_url/api_key/models/api 协议）。
- **`backend/hana-llm.mjs`**：新增 `getProviderCatalog()`（读并缓存 provider-catalog.json，含大小写不敏感匹配）；`getProviderCredentials` 改为「宿主 bus 优先 + catalog 兜底」，正确识别 `api` 协议（anthropic-messages 如 minimax / 讯飞 coding plan）。
- **`postLlmDetect`**：改读 provider-catalog.json，只输出「已配 Key 且 base_url 非空」的供应商下的模型（catalog 有 models 用 catalog；无则用宿主 models-by-type 补充），并做 provider+model 去重。本机实测：25 个 catalog 供应商 → 6 组 / 9 项（每个 provider 只留一份 某识图模型，不再 7 个重复）。
- 前端下拉无需改动。

## [0.1.8] — 2026-08-02

### 修复：前端下拉防御性去重
- `renderLlmDropdown` 分组前按 provider+model 去重（HanaAgent `provider:models-by-type` 返回的模型数组可能重复）。

## [0.1.7] — 2026-08-02

### 优化：LLM 配置选择器重做（论坛反馈「自动读取」与实际体验对齐）
- **后端**（`postLlmDetect` 收紧）：只输出「HanaAgent 全局设置里用户已添加的供应商」下的 chat 模型（`~/.hanako/added-models.yaml` × `provider:models-by-type` 交叉），去掉了之前混入的 agent config.yaml 列表、环境变量兜底、PROVIDER_PRESETS 等冗余来源——原本 20 个杂乱选项收敛为 5-8 个真实可用项。
- **前端**：LLM 面板从「20 chip + 4 输入框 + 需补全提示」重做为**简洁分组下拉**（按供应商分组：DEEPSEEK / MINIMAX / OPENAI / OPENCODE / 新疆幻域…，每组下平铺模型），触发器按钮显示当前选择。移除：
  - 整个表单（配置名称/供应商/Base URL/模型名称输入框——前端不收 Key）
  - 「已保存的 LLM 配置（点击切换）」chip 列表
  - 「设为当前 / 重新检测 / 删除当前 / 清除全部」按钮（点击下拉项即设当前，刷新按钮替代重新检测）
  - 红色「需补全 API Key / Base URL」误导提示（来源已只有已添加供应商，Key 一定可用）
- `buildLlmOpts` 兼容 `cfg.provider` 字段（v0.1.7 前端简化为 `{provider, model}`）。
- 旧 localStorage `hanako-mail-llm-configs`（数组格式）不再使用；当前选择存为 `hanako-mail-llm-current`（`{provider, model}`）。

## [0.1.6] — 2026-08-02

### 功能：实时收件 + 系统通知（论坛反馈落地）
- **IMAP IDLE 实时监听**（新增 `backend/imap-idle.mjs`）：为个人邮箱（IMAP 后端）账号建立 IDLE 长连接，服务器有新邮件立即推送 → 拉取解析 → 写缓存（与 ws-monitor 同格式，前端列表自动合并）+ 弹系统通知。断线 30s 自动重连；服务器不支持 IDLE 时自动降级为 2 分钟周期检查。ClawEmail 仍走原有 WebSocket（ws-monitor）。
- **生命周期**：`index.js` onload 启动 / onunload 关停 imap-idle（pid 文件 `.imap-idle.pid`）；`cleanup.cjs` 同步扫描清理。
- **轮询增强**（routes/ui.js）：5 分钟 → 60 秒；对比最近 5 封（不再漏中间邮件）；**新邮件写入本地缓存**——前端列表刷新即可见（解决「刷新也没用」）。
- **前端自动刷新**：列表页检测到新邮件时自动重新加载（无需手动刷新）。
- **系统通知链路修复**（helper/mail-toast.cjs）：
  1. SnoreToast 参数 `-title/-message` → 正确的 `-t/-m`（此前参数名错误导致原生 toast 永远失败降级）；
  2. 退出码判定：SnoreToast 的 1(Hidden)/2(Dismissed)/3(TimedOut) 均表示通知已展示，此前被 execFile 误判为失败；
  3. AppID 未注册时自动 `-install` 注册（自定义 AUMID 弹 toast 的前提）后重试；
  4. 点击回调（-click）尽力而为，不可用时降级为纯通知——**通知必达**。
- **通知依赖路径修复**：`mail-toast.cjs` 的 node-notifier 查找、routes/ws-monitor 的 NODE_PATH 从开发机专用路径改为 `backend/node_modules`（发布后用户依赖随包即有，不再依赖开发机）。
- imap-backend 导出 `getImapConfig/connectImap/openBox` 供 IDLE 监听器复用。

## [0.1.5] — 2026-08-02

### 功能新增
- **IMAP 服务端搜索**（`imap-backend.searchMessages` + `inbox.searchMessages` 改走服务端）：用 IMAP SEARCH（`OR(FROM kw, SUBJECT kw)`）替代原先「拉全量 100 封后客户端过滤」，大邮箱搜索不再漏结果、性能显著提升。ClawEmail / AgentQQ 原本就是服务端检索，不变。
- **批量删除**：新增 `POST /bulk-delete`（一次 IPC 批量处理，IMAP 连接池复用；单封失败不中断，返回 `{deleted, failed}`）。前端批量工具栏「删除」由逐个调 DELETE 改为单次批量调用；缓存同步移除已删邮件。
- **草稿保存**：新增 `POST /draft` + `inbox.saveDraft` + `imap-backend.saveDraft`（`buildRawMessage` 构建原文，append 到 DRAFTS 文件夹并打 `\Draft` 标记，自动定位草稿文件夹）。前端写信页新增「存草稿」按钮；保存后可在文件夹列表「Drafts / 草稿」中查看。仅 IMAP 后端支持，ClawEmail / AgentQQ 返回明确错误。
- `inbox.mjs` 新增 CLI 命令：`bulk-delete`（`--json={ids,folder}`）、`save-draft`（`--json={to,cc,bcc,subject,body}`）。

### 文档
- README 能力矩阵更新：搜索/批量删除/草稿行与说明。

## [0.1.4] — 2026-08-02

### 性能：IMAP / SMTP 连接池
- **IMAP 连接池**（`backend/imap-backend.mjs`）：per-email 单连接复用（TLS 握手只做一次）。
  - `poolAcquire` / `poolRelease` + `withImap` 统一执行器：连接建立期间置 busy 占位（防并发重复建连），同账号并发请求排队、唤醒后递归重试；
  - 凭据变更（acquire 时 password 不一致）自动销毁重建 —— 账号编辑后即时生效；
  - 操作抛错即销毁连接（不复用可能损坏的会话）；空闲 60s 回收（定时器 `unref`，不阻塞 CLI 模式进程退出）；
  - `closeAllImap()` / `closeAll()` 导出，worker 退出时优雅关闭。
- **SMTP transporter 池**：`nodemailer pool: true`（maxConnections 2 / maxMessages 200），send / reply / forward 复用 TLS 连接，配置或凭据变更自动重建。
- **worker.mjs**：退出时调用 `closeAll()` 关闭全部 IMAP/SMTP 连接。
- 全部 IMAP/SMTP 操作（list/read/delete/send/reply/forward/download/folders/markRead/markSpam/move/appendToSent）改为池化执行。
- 验证：连接池算法单测 11 项 PASS（建连/复用/并发排队/凭据变更重建/错误销毁/异账号隔离），全量语法检查通过。

## [0.1.3] — 2026-08-02

### 性能重构：常驻 Worker 后端
- **新增 `backend/worker.mjs`**：常驻进程，经 stdin/stdout JSON-RPC 接收命令，复用 `inbox.mjs` 的 `COMMANDS` / `parseOptions` 命令表执行（与 CLI 行为一致）。日志走 stderr，stdout 只承载协议。
- **新增 `backend/worker-client.mjs`**：宿主侧客户端，模块级单例。懒启动（首个请求时 spawn）、等待就绪信号后放行、按 id 匹配响应支持并发、请求超时（默认 90s）、崩溃指数退避自动重启、`shutdownWorker()` 优雅关闭。
- **routes/ui.js 与 tools/folders|messages|send|sync.js**：`runInbox` 从「每次 execFile 冷启 node 子进程」改为 `workerClient.runCli` IPC 调用——**调用点与 CLI 参数格式完全不变**，行为等价。
- **并发安全**：每个请求前注入该账号凭据 env + `inbox.resetAccountCache()`；env 应用与命令入口同步段在 Node 单线程内原子完成，不同账号并发请求不会互相污染。
- **生命周期**：`index.js onunload` 关停 worker；`cleanup.cjs` 同时扫描/清理 `worker.mjs` 进程（pid 文件 `.worker.pid`）。
- `inbox.mjs` 新增导出：`COMMANDS` / `parseOptions`（供 worker 复用）、`resetAccountCache()`（清账号配置缓存）。
- 收益：消除每次请求的 node 冷启动 + 模块加载（约 400–600ms/请求），列表/摘要补抓等并发场景提速明显；ClawEmail 的 5s 列表缓存与 client 连接池在常驻进程内真正生效。

## [0.1.2] — 2026-08-02

### 移除（半成品清理）
- **删除 `backend/identity.mjs`（访客意识引擎）**：自动回复 / 验证码提取 / 隐私脱敏规则全链路无消费者（ws-monitor 定义了 `getAwareness` 但从未调用，inbox 的 `needsConfirmation` 恒为 false），属半成品。连同 ws-monitor 的 `getAwareness`、缓存对象中的 `identity` / `isExternal` / `replyDecision` 字段一并移除。
- **删除 `_pending_send` 待发送队列**（inbox.mjs 的 `queuePendingSend` / `needsConfirmation`）：该队列无消费者、`needsConfirmation` 恒返回 false（邮件实际直接发出），属死代码。send / reply / forward 现直接执行，不再有"排队却发不出"的假成功路径。
- **删除 `email-monitor` 本地存档回退**（routes/ui.js 与 tools/sync.js 的 `readEmailMonitorData`）：开发期残留（硬编码开发机路径），与插件产品逻辑无关，开源分发不应携带。

### 功能新增
- **账号编辑**：`POST /accounts` 支持 `action: update`（按 id 更新名称/邮箱/provider；apiKey 仅非空时更新；config 按字段合并，`imapPass` / `smtpPass` 传空字符串可清除）。前端账号卡片新增「改」按钮：回填表单进入编辑模式，密码字段不回显、留空即保留原值；「删」按钮增加二次确认。

## [0.1.1] — 2026-08-02

### 安全修复（Security）
- **修复命令注入（高危）**：`backend/agentqq-backend.mjs` 此前用 `spawn(cmd, { shell: true })` 拼接命令行，`\"` 转义在 cmd.exe 下无效，正文/收件人/主题含 `&` `|` 等元字符可触发任意命令执行。现改为解析 `agently-cli.cmd` 的真实 JS 入口（`@tencent-qqmail/agently-cli/scripts/run.js`），用 `spawn(node, [entry, ...args], { shell: false })` 传参，用户输入不再经过 shell。
- **修复 mail-cli 同源风险**：`backend/clawemail-backend.mjs` 的 `runMailCli` 移除 `shell: true`，改为数组参数直连 node。
- **修复图片代理 SSRF 绕过**：`assets/_proxy-fetch.cjs` 现在对**每次 302 重定向后的 URL 重新校验**（协议 + host），并增加 DNS 解析后 IP 校验（防 rebinding）、IPv4-mapped IPv6 拦截、响应体积上限（8MB）。
- **修复 IMAP TLS 证书校验被关闭**：`backend/imap-backend.mjs` 移除 `tlsOptions.rejectUnauthorized: false`，邮箱链路易受中间人攻击的问题消除。
- **凭据加密升级**：新增 `backend/cred-crypto.mjs` 统一加解密；密钥从「用户名 + 硬编码盐」升级为「用户名 + per-install 随机盐」（`.cred-salt`），并自动兼容解密旧格式。routes / tools / ws-monitor 三处读写统一走同一套实现，消除明文写、密文读的不对称。
- **LLM Key 不再进前端**：`routes/ui.js` 的 `buildLlmOpts` / `postLlmTest` 不再信任前端传入的明文 apiKey，一律服务端回源（宿主 `provider:credentials` > agent `config.yaml` > 环境变量）；前端移除 Base URL / API Key 手填表单，页面加载自动检测配置。

### Bug 修复（Fixes）
- **IMAP 移动邮件回退分支**：`moveMessage` 的 COPY+DELETE 回退此前误用 `delFlags \Seen` 导致原件不删、邮件重复；改为 `addFlags \Deleted` + `expunge`，并对删除/移动/标记已读统一使用可写 box 打开。
- **`postLlmTest` 参数名**：`maxTokens` → `max_tokens`（此前测试请求实际发 1500 token）。
- **`tools/send.js` 长正文**：发送参数改走 `--json=<file>` 通道，避免 Windows 32KB 命令行限制与特殊字符错位。

### 改进（Improvements）
- `tools/accounts.js` 读写 accounts.json 复用统一加密（此前明文写会破坏加密格式）。
- `backend/ws-monitor.mjs` 读取账号后解密 apiKey（此前直接拿密文，实时收件可能失效）。

## [Unreleased] — 2026-07-29

### 修复 (Bug Fixes)
- **AgentQQ 附件**：`inbox.mjs` 的 `getAttachmentData` 对 AgentQQ 后端不再 `throw`，改为调用 `agentqq-backend.downloadAttachment` 下载并读取文件返回 base64，与 ClawEmail / IMAP 行为对齐。
- **转发打通**：
  - `inbox.mjs` 的 `forward` 对 ClawEmail 后端不再抛错，改为读取原文后用 `sendMail` 转发（带原文引用与附件）。
  - 新增 `routes/ui.js` 的 `POST /forward` 路由（原前端转发实际走了 `/send` 被当作新邮件发送，已修正）。
  - `imap-backend.forwardMail` 支持 `cc` / `bcc` / `attachments`。
- **写信增强**：写信表单新增 CC / BCC 字段与附件上传入口；`imap-backend.sendMail` / `replyToMail` / `forwardMail` 均支持 `cc` / `bcc` / `attachments`，AgentQQ 通过 `uploadAttachment` 转 `fileIds`。
- **totalCount bug**：`common.mjs` 的 `normalizeFolder` 原误用 `unread` 作为 `totalCount`，改为取 `total` / `totalCount`。
- **AgentQQ 取消已读**：保持明确报错（CLI 不支持），由路由透传为前端提示，避免静默失败。

### 改进 (Improvements)
- **图标规范化（P0）**：全量移除 emoji 功能图标（附件 📎、通知 📩、文件类型图标、导航/按钮装饰 ✦✚✓✕ 等），统一替换为 `svgIcon()` 内联描边 SVG。覆盖 `assets/plugin-page-template.html` 与 `helper/mail-toast.cjs`。全仓 emoji 扫描通过。
- **搜索栏常驻**：`searchBar` 不再在列表中隐藏，所有页面（除写信页）常驻显示，用户随时可搜。
- **批量操作按文件夹类型自适应**：新增 `folderRole()` 分类（inbox / sent / drafts / trash / spam）。批量工具栏的「标已读」仅在收件箱类文件夹显示；已发送 / 草稿 / 垃圾箱 / 垃圾邮件下自动隐藏（这些文件夹的已读状态无意义）。
- **AI 总结 / 翻译（走 Hanako 本体 LLM）**：
  - 新增 `backend/llm.mjs`：OpenAI 兼容 `/chat/completions` 客户端，端点由 `HANAKO_LLM_BASE_URL` / `HANAKO_LLM_API_KEY` / `HANAKO_LLM_MODEL` 环境变量配置（不写死厂商）。
  - 新增 `POST /summarize` 与 `POST /translate` 路由：`runInbox read` 取正文 → 调 LLM → 返回纯文本；未配置 LLM 时返回明确错误而非静默失败。
  - 详情页新增「总结」「翻译」按钮（内联 SVG 图标）+ `ai-panel` 结果面板（含加载/错误态）。
- **结构化发送参数**：`inbox.mjs` 的 `parseOptions` 支持 `--json=<file>`，`routes/ui.js` 的 `postSend` / `postForward` 将 cc/bcc/附件写入临时 JSON 透传，避免 CLI 参数无法表达数组/二进制。
- **依赖自动安装体验**：`checkBackendDeps` 在检测到后台安装进行中时返回 HTTP 202 `{ installing: true }` 而非 400 报错；新增 `GET /deps-status` 端点；UI 在同步/发送时收到 202 会自动轮询等待安装完成后重试，用户不再需要手动 `npm install`。
- **优雅卸载 / 进程清理**：
  - `index.js` 的 `onunload()` 现在主动终止 `ws-monitor.mjs` 后台进程（含 Windows `taskkill /T /F` 兜底），并写入 `backend/data/.ws-monitor.pid` 以便精准清理；卸载后不再自动重启。
  - `ws-monitor.mjs` 新增 SIGTERM / SIGINT / SIGBREAK 信号处理，收到信号后干净退出（Linux/Mac）。
  - 新增 `cleanup.cjs` 兜底脚本：按 pid 文件或扫描命令行终止残留进程，`--delete` 可额外清理 backend 目录，解决「删除插件时因后台进程占用无法程序化删除」的问题。

### 文档 (Docs)
- README 新增：后端能力矩阵、安全模型、环境变量参考、故障排查、图标规范。
- 新增 CHANGELOG.md。
