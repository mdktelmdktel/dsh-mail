# dsh-mail 📮

> 给你的 AI agent 一个**自己的电子邮箱** —— 零配置开通收件箱、自己收验证码、配好 SMTP 就能给真实的人发信。

[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-4ee1a0)](https://github.com/)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933)](https://nodejs.org)

---

## 这是什么

大多数 agent 都会在同一个地方卡住：**注册一个账号要验证码，它没有邮箱。**

`dsh-mail` 把这件事一次性解决：

- **收信**：基于 [mail.tm](https://mail.tm) 免费临时邮箱服务，第一次调用自动开通一个专属地址，永久保存。不需要注册、不需要 API key、不需要你去点任何东西。
- **等验证码**：`mail_wait` 直接轮询等信、自动从正文/HTML 里抠出 4~8 位数字验证码，agent 拿到的就是验证码本身，不用理解邮件。
- **发信**：`mail_smtp_config` 填一次自己的 SMTP（QQ / 163 / Gmail / 企业邮箱都行），之后 `mail_send` 就能以真实身份给任何人发邮件；没配 SMTP 时回退到临时域名通道（只能投递到 Guerrilla Mail 自己的域名，发往外部真实域名时服务端要求人机验证，插件会**如实报错**而不是假装发出去）。

一句话：**让 agent 有身份，而不是只能当旁观者。**

## 安装

### 方式一：直接放进插件目录（推荐）

```bash
git clone https://github.com/<你>/dsh-mail.git "$DSH_HOME/plugins/dsh-mail"
```

`DSH_HOME` 默认是 `~/.dsh`（Windows：`C:\Users\<你>\.dsh`）。

插件里的 `cordis.patch.yml` 是纯 `insert` 声明，**可以直接热挂载，不用重启 DSH**：

```yaml
- insert:
    - id: dsh-mail
      name: dsh-mail
```

### 方式二：手动挂载

把 `dsh-mail` 目录放到 `$DSH_HOME/plugins/` 下即可，DSH 启动时会自动扫描。

## 快速上手

装好之后，直接对 agent 说：

> 帮我注册个 xx 账号，用你自己的邮箱收验证码。

agent 就会自己跑完整条链路：

| 步骤 | 工具 | 发生的事 |
| --- | --- | --- |
| 1 | `mail_address` | 自动开通 `agent-xxxxxx@maxxspace.com`，写进本地配置 |
| 2 | `mail_wait` | 轮询等新邮件 → 正则提取验证码 → 直接返回数字 |
| 3 | 继续干活 | 注册成功 🎉 |

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `mail_address` | 查看或创建自己的专属邮箱地址（`create=true` 换新地址） |
| `mail_inbox` | 看收件箱（最新在前），返回发件人/主题/时间/未读/摘要 |
| `mail_read` | 按 id 读一封邮件的完整正文（纯文本优先，HTML 自动转文本） |
| `mail_wait` | **收验证码专用**：等一封新信，自动抓 4~8 位验证码；支持 `pattern`、`subjectIncludes`、`includeRecentSec` |
| `mail_send` | 用配置好的 SMTP 发信，支持中文主题/正文 + HTML 版本 |
| `mail_smtp_config` | 配置 / 查看 / 清除 SMTP 账号（不传参数=查看状态） |

## 配置 SMTP（发信到真实邮箱）

只有收信不需要任何配置；要给真人发信才需要，3 分钟搞定：

**QQ 邮箱**
1. 打开 <https://mail.qq.com> → 设置 → 账号 → 开启「POP3/SMTP 服务」
2. 按提示生成**授权码**
3. 让 agent 执行：`mail_smtp_config host=smtp.qq.com port=465 secure=true user=你的QQ邮箱 pass=授权码`

**163 邮箱**
1. 设置 → POP3/SMTP/IMAP → 开启 SMTP → 生成**客户端授权码**
2. `host=smtp.163.com port=465 secure=true`

**Gmail**
1. 开启两步验证 → 生成「应用专用密码」
2. `host=smtp.gmail.com port=465 secure=true`

> ⚠️ `pass` 填的是**授权码**，不是登录密码。填登录密码会认证失败。
> SMTP 是用 Node 原生 `net` / `tls` 手写的协议栈，**不依赖 nodemailer 这类第三方库**，插件本身零依赖。

## 数据与隐私

所有凭据只落在本机：

```
$DSH_HOME/storages/dsh-mail/config.json
```

写入时带 `mode 0o600`（Windows 上退化为目录权限），不上传、不外发。

## 设计取舍

- **为什么用 mail.tm**：免费、无需注册、有正规 HTTP API、域名池稳定。注册流程第一次调用就完成，对 agent 来说完全透明。
- **为什么自己写 SMTP**：装个 nodemailer 会引入一堆传递依赖；发信协议其实只有 `EHLO / AUTH LOGIN / MAIL FROM / RCPT TO / DATA` 五步，手写 200 行足够且可控，还能顺手把超时、TLS 升级、MIME 编码这些容易踩的坑一次踩平。
- **为什么发不出去就报错**：临时域名通道发往外部真实域名时服务端会返回 `needs_captcha`，API 层面无法自动绕过。假装发送成功是最糟的失败方式 —— 宁可让 agent 明确知道「这条没发出去，请配置 SMTP」。

## 环境要求

- DSH（DeepSeek Harness）任意近期版本
- Node.js **>= 22.13.0**（用到原生 `fetch`、`AbortSignal.timeout`）

## License

[MIT](./LICENSE)
