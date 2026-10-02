# 贡献指南

面向要改这个 App 的人。使用者看的请看 [README](README.md);逐版变更与踩坑记录看
[CHANGELOG](CHANGELOG.md) —— 那里是历史,这里是**现在必须遵守的约定**。

## 开发环境

```bash
cd backend && npm install          # 仅开发机;发布包必须自带依赖,见「发布」

# 语法校验。注意这只覆盖 .js/.mjs,卡片内联的 <script> 看不见
for f in backend/*.mjs http/ui.js tools/*.js helper/*.cjs index.js; do node --check "$f"; done

node scripts/smoke-load.mjs        # 装载自检:不依赖宿主
node scripts/smoke-bridge.mjs      # 转发层 + 通知链路
node scripts/smoke-notify.mjs      # 桌面通知端到端
```

`_dev/` 下还有三个只在改特定文件时才需要的检查,各自守什么见 `_dev/README.md`。

## 架构:两个进程

AppHost 在 Node 权限模型内运行 —— **没有出站网络,也读不到安装目录与 app-data 之外的
任何文件**,而邮件后端离开网络就不存在。所以拆成两半:

```
AppHost(hanako-server.exe + app-host-entry.js)     受管服务(runtime/service.mjs,独立进程)
  · ctx.tools.register()   五个邮件工具              · ClawEmail WebSocket + IMAP IDLE 监听
  · ctx.routes.register()  卡片后端路由(http/ui.js)   · inbox 命令表(list/read/send/reply/转发/附件)
  · 把要干活的请求转发给服务 ──────────────────▶      · 出站 HTTP(供应商端点)、图片代理
  · 通知派发(每 5 秒取队列 + 拉起 toast)  ◀────      · 通知入队、依赖自愈、v1 数据迁移
```

服务的能力来自 `profile: local-machine` + `network: external`,是**真实的权限放大**:
以当前系统用户权限运行、可读该用户可读的文件,Windows 上 `enforcement` 为 `partial`
(不提供完整文件隔离)。安装审批会单独列出这几条能力位。

### 两条已实测的前提

- **权限模型会传给子进程,且不走环境变量**。父进程用 argv 传 `--permission` 时,
  子进程的 `NODE_OPTIONS` 是空的也照样被拒;剥环境变量无效。
- **AppHost 的 env 是宿主白名单**,只有 `PATH` / `HOME` / `TMPDIR` / `LANG`。
  `USERPROFILE` / `HANA_HOME` 在那里面不保证存在。

因此路径的来源被钉死成两处:

- `runtimeDataDir()` 优先读 `HANAKO_PLUGIN_DATA`(`apply()` 里从 `ctx.dataDir` 写入)
- `legacyDataDir()` 从数据目录**反推** HANA_HOME(取两层 dirname),**不读环境变量**

### 目录职责

```
index.js        v2 入口:钉死数据目录 → bindModels → 注册工具与路由 → 起服务 → 起通知派发
http/ui.js      卡片后端的全部路由(不能叫 routes/,见「装载陷阱」)
runtime/service.mjs   受管服务:监听 127.0.0.1:43179,命令表 + 出站 HTTP + 代理 + 通知入队
backend/        引擎层。inbox.mjs 是命令表唯一入口;三个后端全部进程内调用
lib/            v2 装配层:env / legacy-ctx 投影 / 工具与路由注册 / 服务句柄 / 通知派发 / 模型句柄
sdk/app-contract/     宿主给的流式解码器,别自己 split("\n")
tools/ helper/ scripts/ ui/
```

## 边界:改代码前先过一遍

### 1. AppHost 读不了 HANA_HOME

宿主给 AppHost 的 fs 白名单实测只有三条(从运行中进程的 argv 取到):

```
--allow-fs-read=<HANA_HOME>/apps/hanako-mail
--allow-fs-read=<HANA_HOME>/app-data/hanako-mail
--allow-fs-read=<bundle>/desktop/src/locales
```

凡是 `http/ui.js` 里用 `fs` 直读 HANA_HOME 其它位置的代码,**不会报错,只会静默拿到空**
—— `readFileSync` 被拒,`catch` 吞一下,下游看到的就是「没有数据」。它长得跟
「用户什么都没配」一模一样,这是最难查的一类失败。

要读 HANA_HOME 只有两条正路:走宿主契约,或者把读取搬到受管服务。
加新路由时先问一句:**这个文件在不在上面三条白名单里。**

> 顺带一条容易误判的:用户目录下的 `.hanako` 常常是指向真实 HANA_HOME 的**符号链接**,
> 所以换一种写法指向同一个文件,绕不过权限门,只会让人以为已经修好了。

### 2. 模型有两条通路,校验力度不同

| | 凭据 | provider 名校验 | 非 ASCII 的 provider 名 |
|---|---|---|---|
| `ctx.models`(`app/models.infer`) | 宿主保管,插件看不到,有用量记账 | 要求 `^[A-Za-z0-9_.:-]{1,128}$` | ❌ 拒 |
| `ctx.bus` 的 `provider:credentials` | bus 回传 baseUrl + apiKey | providerId 只当查表键,不进 HTTP | ✅ 能用 |

分工:`inferText()` 里按 `hostAccepts()` 分流 —— 名字合规走前者(凭据不出宿主),
不合规走后者直连;前者**报错**也回落一次后者,但**超时不回落**
(那次请求可能已经发出去了,重试等于两次请求两份钱)。

三条纪律:

- `fetchCredentials` **不导出**。key 只能停在「取到」与「拼成请求头」那两行之间。
- 直连那条**不读** `provider-catalog.json`(踩过第 1 条)。只走 bus。
- **不要拿标识符规则删用户的模型。**宿主 `list` 给出什么就列什么,`hostIdOk` 只做标注;
  能不能用由宿主的 `stream` 说了算。曾经在这里预筛,结果把用户自己加的供应商藏掉了。

### 3. 宿主按路径缓存卡片资产

同名覆盖 `face.png` / `icon.png`,**UI 里还是旧图**。换图必须起新文件名并改
`manifest.json`,别指望重载刷掉缓存。

`manifest` 里的 `face.image` 与 `icon` 相对哪里解析,无法从包内自证
(v1 时代封面住在 `ui/` 下)。所以根目录与 `ui/` **各放一份同一张图**,不再赌解析基准。
换图 = 起新名 + 两处都放 + 改 manifest。

### 4. 装载陷阱

- 顶级 `routes/` 目录是 v2 的另一条路由来源,与 `ctx.routes.register()` **互斥**,
  两边同时存在整个应用装载即 failed。所以后端路由文件叫 `http/ui.js`。
- `manifest.id` 必须与安装目录名一字不差。仓库名与 App id 不同,所以官方校验器直接对
  仓库根跑会报 `does not match its directory name` —— 这是命名约定差异,不是包的问题。
- `validate-app` 只保证 manifest 与静态资源自洽,路由来源互斥、能力清单、安装位置独占
  它一条都不查。**0 error 不等于能装载。**

### 5. 通知链路

`/pending-notify` 只读不删,派发成功后才 `notify-ack`。原先读完就 `unlink`,而删除发生在
toast 被拉起**之前**,只要发送失败这条通知就永久消失、只在日志留一行 warn。
队列另有同 `messageId` 去重、上限 200 条、TTL 24 小时。

**判断弹没弹出去不看退出码**:SnoreToast 在通知已经弹出的情况下仍返回 `-1`。
所以每次尝试都写 `<dataDir>/notify-last-result.json`,派发器与 `/notify-status` 都读它
—— 失败不能只存在于日志里。

点击回调走**具名管道**,且管道必须在**服务**侧建:AppHost 的 argv 里没有 `--allow-net`,
而 Node 的权限模型把 `net`(含 Windows 具名管道)一起管住。SnoreToast 写回的只有
`action=activate`,不含邮件身份,所以 `messageId` / `accountId` / `folder` 必须在 arm 时
交给服务,点击记录里带着,卡片才知道该跳哪一封。

> 复现环境与生产版本不一致时,「能跑通」不算证据。这条边界上曾有过一次相反结论,
> 起因是那次实验跑在没有网络门的旧版 Node 上。

## 代码约定

- 后端 ESM(`.mjs`),无构建步骤。
- **不使用 emoji 作功能图标**,统一用 `ui/mail.html` 里的 `svgIcon()` 内联描边 SVG。
- 新增敏感字段落盘前必须走 `backend/cred-crypto.mjs`;明文凭据禁止进日志、前端、localStorage。
- 子进程一律 `spawn(node, [entry, ...args], { shell: false })`,禁止 shell 拼接用户输入。
- 新增后端能力时同步更新 README 的能力矩阵与 CHANGELOG。
- 卡片不可信输入一律走 DOM 节点构造,不拼 `innerHTML`(正文是外部输入)。

## 发布

版本号 `x.y.z`,记进 `manifest.json` 与 CHANGELOG。

**依赖必须随包发布** —— 受管服务不能自己 `npm install`,缺依赖时服务只会报错。
所以 release 资产是 `hanako-mail-<版本>-with-deps.zip`,不是 GitHub 自动生成的
Source code(那个只含仓库跟踪的文件,`node_modules` 被 `.gitignore` 排除了)。

```bash
git archive --format=zip --prefix=hanako-mail/ <tag> -o src.zip     # 取干净源码
# 解出后补入 backend/node_modules,再打包;顶层必须是 hanako-mail/
```

发布前检查:依赖完整性用 `backend/deps.mjs` 的判定(它从 `backend/package.json` 推导,
不硬编码包名);确认 `accounts.json` / `.cred-salt` / `.env` / 通知运行数据不在包内;
文档与注释里不残留真实供应商名、模型名与本机路径。
