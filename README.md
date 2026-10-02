# Hanako Mail

Hana 原生的多邮箱聚合 App:ClawEmail、AgentQQ 官方 API,以及任意个人邮箱的 IMAP/SMTP,
收进一个收件箱。

![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)

## 功能

- **多账号**:不限数量,每个账号独立文件夹树与未读计数;可随时编辑,删除有二次确认
- **实时收件**:ClawEmail 走 WebSocket、IMAP 走 IDLE,新邮件秒级弹系统通知,**点通知直达那封邮件**
- **读信**:HTML 正文沙箱渲染,内嵌图与外网图自动走同源代理(避免被沙箱拦成裂图)
- **附件**:预览与下载,内嵌图与正文 `cid:` 自动对应
- **写信 / 回复 / 转发**:支持 CC / BCC / 附件;转发带原文引用
- **整理**:标记已读未读、垃圾邮件、批量删除、移动、保存草稿、黑/白名单
- **搜索**:发件人与主题,IMAP 侧为服务端检索
- **AI 总结与翻译**:提炼 3-5 条要点、正文翻译,模型取自 Hana 已配置的供应商

## 安装

1. 下载 release 里的 **`hanako-mail-<版本>-with-deps.zip`**,解压得到 `hanako-mail/`
   (不要用页面上的 Source code——后端依赖不随仓库发布,缺它装上去收发信不可用)
2. 放到 `<HANA_HOME>/apps/hanako-mail/`,目录名须与 `manifest.id` 一字不差
3. Hana → Market → Installed → 批准该应用

最低 Hana 版本:`0.946.2`。

**更新已安装的版本时,先停用 → 卸载 → 再装新包。**
直接覆盖会失败(`Package file worker stopped before completing`)——后端服务正占着
`runtime/` 下的文件,Windows 不允许替换。另外「重新加载」不会改写安装记录里的版本号。

## 添加账号

| 类型 | 域名 | 需要填 |
|---|---|---|
| ClawEmail | `@claw.163.com` | API Key |
| AgentQQ | `@agent.qq.com` | 只需扫码授权,**不填任何密钥** |
| 个人邮箱 | 其他 | IMAP/SMTP 授权码 |

QQ / Gmail / Outlook / 163 / Sina / Aliyun 等常见域名会自动补全服务器与端口。

AgentQQ 的授权流程:添加账号 → 提供商选 `AgentQQ` → 「开始授权」→ 在浏览器里确认
→ 授权完成后账号自动出现,地址由授权结果决定。令牌加密存储,过期自动刷新。

## 各后端支持的能力

不支持的操作会返回明确说明,不会静默失败。

| 能力 | ClawEmail | AgentQQ | 个人邮箱 |
|---|:--:|:--:|:--:|
| 列表 / 搜索 / 读正文 | ✅ | ✅ | ✅ |
| 发送 / 回复 / 转发(含附件) | ✅ | ✅ | ✅ |
| 附件下载与预览 | ✅ | ✅ | ✅ |
| 标记已读 | ✅ | ✅ | ✅ |
| 文件夹列表 | ✅ | ✅ | ✅ |
| 取消已读 | ✅ | ❌ | ✅ |
| 批量删除 | ✅ | ❌ | ✅ |
| 移动邮件 | ✅ | ❌ | ✅ |
| 保存草稿 | ❌ | ❌ | ✅ |

> AgentQQ 的「移动」等价于官方 REST 的软删除(进垃圾箱,保留 30 天);
> 官方接口没有取消已读与批量删除,后端会说明而不是假装成功。

## AI 总结 / 翻译

详情页两个按钮,结果落在正文下方的面板里。模型列表在卡片打开时自动拉取,
也可以在「设置 → AI 设置」里手动重拉、选择供应商与模型。

**不需要填 URL 或 API Key。**模型取自你在 Hana 里配置的供应商,凭据由 Hana 保管;
App 拿不到也不需要拿到明文密钥。走的是宿主的模型契约,还是取凭据直连供应商,
界面会标出来(下拉里标「直连」的那些,是供应商名含中文或空格、宿主契约不收的)。

仅处理有纯文本内容的邮件;纯图片或纯 HTML 且无可提取文本的会明确报错。

## 实时通知

| 邮箱类型 | 通道 |
|---|---|
| ClawEmail | WebSocket,秒级 |
| 个人邮箱 | IMAP IDLE 秒级;服务器不支持则降为 2 分钟周期检查 |

新邮件到达会弹 Windows 系统通知,**点击通知会直接打开那封邮件**——即使当时卡片没开,
下次打开卡片也会跳过去(超过 10 分钟的旧点击会丢弃,避免隔夜打开突然跳到一封旧信)。

排查通知不用翻日志:「设置 → 系统通知」有状态行(队列深度、最近一次是否真的投递出去、
投递方式与时间)和一个**测试通知**按钮。

## 安全

- 凭据(`apiKey` / `imapPass` / `smtpPass`)写入前 **AES-256-GCM** 加密;密钥由
  `scrypt(用户名 + 每次安装随机盐)` 派生,盐只存在本机数据目录。仅有 `accounts.json`
  无法离线推导,拷到别的机器也解不开
- HTML 正文在 `sandbox` 的 iframe 里渲染,邮件内脚本无法逃逸到卡片
- 正文里的外网图片改写成同源代理,逐跳校验 host 与解析后的 IP(屏蔽私网/回环、防 DNS
  rebinding)、限制响应 8MB
- 三个后端全部进程内调用,**不执行任何外部 CLI**;用户可控参数从不进入命令行
- 明文凭据不进前端、不进日志、不进 localStorage

## 环境变量(可选兜底)

账号凭据优先在界面里填。以下仅在未通过账号配置提供时生效(`backend/.env`):

`CLAWEMAIL_API_KEY` / `CLAWEMAIL_ADDRESS` · `IMAP_HOST` / `IMAP_PORT` / `IMAP_USER` /
`IMAP_PASS` · `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS`

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 加了账号但列表是空的 | 列表读的是本地缓存 | 「同步」页刷新当前文件夹,或在列表页触发同步 |
| `IMAP_PASS not set` / `CLAWEMAIL_API_KEY not set` | 凭据没填 | 账号配置里补上 |
| `@clawemail/node-sdk 未安装` | 装的是不含依赖的包 | 换 `-with-deps.zip` 重装 |
| 标记已读后远端没变 | 令牌过期或网络异常 | 检查账号授权状态 |
| 附件预览 404 | partId 不匹配 | 重新打开邮件,以最新 `read()` 返回的 id 为准 |
| 点通知没跳转 | 卡片当时没开且点击已过期 | 超过 10 分钟的旧点击会被丢弃,属预期 |
| 更新时安装失败 | 服务占着 `runtime/` | 停用 → 卸载 → 再装 |

## 开发

```bash
node scripts/smoke-load.mjs      # 不依赖宿主的装载自检:ctx 投影 / 路由 / 降级 / manifest 一致性
node scripts/smoke-bridge.mjs    # 转发层与通知链路
node scripts/smoke-notify.mjs    # 桌面通知端到端
```

架构说明、进程分工、必须知道的边界(AppHost 读不到 HANA_HOME、宿主按路径缓存资产等)、
发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 卸载

后端跑在受管服务里,停用 / 卸载 / 重载时宿主会回收它,不需要手动关进程。
只有宿主异常退出留下孤儿进程时用到 `node cleanup.cjs`(只杀进程,不删任何目录)。

## License

AGPL-3.0
