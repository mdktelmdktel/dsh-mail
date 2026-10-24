/**
 * dsh-mail — 给 agent 一个自己的电子邮箱。
 *
 * 收件：mail.tm 免费邮箱（自动开通，无需任何配置），支持等待验证码。
 * 发件：三条通道，按优先级回退
 *   1. 用户自填 SMTP 账号（QQ/163/Gmail/企业邮箱均可）—— 最可靠，优先；
 *   2. Guerrilla Mail 临时域名通道（零配置、无需 key）—— 实测现状：只能投递到
 *      Guerrilla 自己的临时域名；发往外部真实域名时服务端强制要求人机验证
 *      （返回 needs_captcha:true），API 无法自动完成，所以这条通道对真实收件人基本不可用，
 *      工具会如实报错而不是假装发出去了；
 *   3. 两条都不可用就明确报错。
 *
 * 数据都落在 $DSH_HOME/storages/dsh-mail/config.json。
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import net from 'node:net'
import tls from 'node:tls'
import { randomBytes } from 'node:crypto'
// 宿主注入的 defineTool（纯辅助函数，只在有包时用它，拿不到就退回原样返回）
let defineTool = (definition) => definition
try {
  const toolsMod = await import('@deepseek-ai/dsh-tools')
  if (typeof toolsMod.defineTool === 'function') defineTool = toolsMod.defineTool
} catch {
  // 独立于宿主运行时（或未注入）走兜底实现
}

export const name = 'dsh-mail'
export const inject = ['tools']

const API = 'https://api.mail.tm'
const MAILBOXES = 'https://api.mail.tm'

/* ------------------------------------------------------------------ */
/* 配置存取                                                            */
/* ------------------------------------------------------------------ */

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}
function dataDir() {
  return join(dshHome(), 'storages', 'dsh-mail')
}
function cfgPath() {
  return join(dataDir(), 'config.json')
}
function loadCfg() {
  try {
    return JSON.parse(readFileSync(cfgPath(), 'utf8'))
  } catch {
    return {}
  }
}
function saveCfg(cfg) {
  mkdirSync(dataDir(), { recursive: true })
  try { chmodSync(dataDir(), 0o700) } catch { /* windows 上无效 */ }
  writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 })
  try { chmodSync(cfgPath(), 0o600) } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* mail.tm 客户端                                                      */
/* ------------------------------------------------------------------ */

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let res
  try {
    res = await fetch(API + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    throw new Error('连不上 mail.tm（检查网络/代理）: ' + (error?.message || error))
  }

  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }

  if (!res.ok) {
    const detail = (data && (data.detail || data.message)) || (typeof data === 'string' ? data : '') || text
    const err = new Error(`mail.tm ${res.status}: ${String(detail).slice(0, 300)}`)
    err.status = res.status
    throw err
  }
  return data
}

function hydra(data) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data['hydra:member'])) return data['hydra:member']
  return []
}

function jwtExpMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString('utf8'))
    return payload.exp ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

async function session(cfg, { force = false } = {}) {
  if (!cfg.address || !cfg.password) {
    throw new Error('还没有自己的邮箱地址，先调用 mail_address 创建（create=true 或直接不带参数）')
  }
  if (!force && cfg.token && (cfg.tokenExp || 0) - 60_000 > Date.now()) return cfg.token
  const issued = await api('/token', {
    method: 'POST',
    body: { address: cfg.address, password: cfg.password },
  })
  cfg.token = issued.token
  cfg.tokenExp = jwtExpMs(issued.token) || Date.now() + 3600_000
  saveCfg(cfg)
  return cfg.token
}

/** 带 401 自动重登的调用 */
async function authed(cfg, fn) {
  let token = await session(cfg)
  try {
    return await fn(token)
  } catch (error) {
    if (error?.status === 401) {
      token = await session(cfg, { force: true })
      return await fn(token)
    }
    throw error
  }
}

async function createAddress(cfg, domain) {
  const domains = hydra(await api('/domains'))
  if (domains.length === 0) throw new Error('mail.tm 当前没有可用域名，稍后再试')
  const picked = domain
    ? domains.find((d) => String(d.domain).toLowerCase() === String(domain).toLowerCase())
    : domains[0]
  if (!picked) {
    throw new Error(`没有域名 ${domain}，可用：${domains.map((d) => d.domain).join('、')}`)
  }

  const local = 'agent-' + randomBytes(3).toString('hex')
  const address = `${local}@${picked.domain}`
  const password = randomBytes(18).toString('base64url')

  await api('/accounts', { method: 'POST', body: { address, password } })
  const issued = await api('/token', { method: 'POST', body: { address, password } })

  let accountId = ''
  try {
    const me = await api('/me', { token: issued.token })
    accountId = me?.id || ''
  } catch { /* /me 不可用不影响收发 */ }

  const next = {
    ...cfg,
    address,
    password,
    accountId,
    token: issued.token,
    tokenExp: jwtExpMs(issued.token) || Date.now() + 3600_000,
    createdAt: Date.now(),
  }
  saveCfg(next)
  Object.assign(cfg, next)
  return { address, accountId }
}

async function listMessages(cfg, { limit = 20 } = {}) {
  const pageSize = Math.min(Math.max(1, limit), 50)
  const data = await authed(cfg, (token) => api(`/messages?page=1`, { token }))
  return hydra(data).slice(0, pageSize)
}

async function readMessage(cfg, id) {
  const data = await authed(cfg, (token) => api(`/messages/${encodeURIComponent(id)}`, { token }))
  // 顺手标记已读；失败不影响读取
  authed(cfg, (token) =>
    api(`/messages/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      token,
      body: { seen: true },
    }),
  ).catch(() => {})
  return data
}

/* ------------------------------------------------------------------ */
/* 文本工具                                                            */
/* ------------------------------------------------------------------ */

function htmlToText(html) {
  if (!html) return ''
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

function mailBody(full) {
  const html = full?.html
  const plain = (typeof html === 'string' && Array.isArray(html) ? html.join('\n') : html)
  const text = full?.text && String(full.text).trim()
  if (text) return text.slice(0, 20_000)
  return htmlToText(plain).slice(0, 20_000)
}

function extractCode(text, pattern) {
  if (!text) return null
  if (pattern) {
    try {
      const m = new RegExp(pattern, 'i').exec(text)
      return m ? (m[1] || m[0]) : null
    } catch {
      /* 非法正则 -> 退回自动识别 */
    }
  }
  const near = /(验证码|校验码|动态码|verification code|verify code|security code|your code is|code is)[^0-9]{0,40}(\d{4,8})/i.exec(text)
  if (near) return near[2]
  const six = /(?:^|[^0-9])(\d{6})(?:[^0-9]|$)/.exec(text)
  if (six) return six[1]
  const any = /(?:^|[^0-9])(\d{4,8})(?:[^0-9]|$)/.exec(text)
  return any ? any[1] : null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fmtTime(value) {
  const d = new Date(value || Date.now())
  if (Number.isNaN(d.getTime())) return String(value || '')
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function senderOf(msg) {
  const from = msg?.from || {}
  const addr = from.address || ''
  const who = from.name ? `${from.name} <${addr}>` : addr
  return who || '(未知发件人)'
}

/* ------------------------------------------------------------------ */
/* SMTP 发信（零依赖实现）                                             */
/* ------------------------------------------------------------------ */

function b64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64')
}

function b64Block(value) {
  return Buffer.from(String(value ?? ''), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n')
}

function encodeHeader(value) {
  const clean = String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
  if (/^[\x20-\x7e]*$/.test(clean)) return clean
  return '=?UTF-8?B?' + b64(clean) + '?='
}

function addrOnly(value) {
  const s = String(value || '').trim()
  const m = /<([^>]+)>/.exec(s)
  return (m ? m[1] : s).trim()
}

function attachReader(sock) {
  const queue = []
  const waiters = []
  let buf = ''
  let lines = []
  let dead = null

  sock.setEncoding('utf8')
  sock.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      lines.push(line)
      const m = /^(\d{3})([ -])/.exec(line)
      if (m && m[2] === ' ') {
        const reply = { code: Number(m[1]), lines: lines.slice() }
        lines = []
        const waiter = waiters.shift()
        if (waiter) waiter.resolve(reply)
        else queue.push(reply)
      }
    }
  })

  const kill = (error) => {
    if (!dead) {
      dead = error instanceof Error ? error : new Error('SMTP 连接已关闭')
    }
    while (waiters.length) waiters.shift().reject(dead)
  }
  sock.on('error', kill)
  sock.on('close', () => kill())

  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift())
      if (dead) return Promise.reject(dead)
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
    },
  }
}

function connectTcp(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port })
    const onError = (error) => {
      sock.destroy()
      reject(error)
    }
    sock.once('error', onError)
    sock.once('connect', () => {
      sock.removeListener('error', onError)
      resolve(sock)
    })
    sock.setTimeout(timeoutMs, () => onError(new Error('SMTP 连接超时')))
  })
}

function connectTls(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host })
    const onError = (error) => {
      sock.destroy()
      reject(error)
    }
    sock.once('error', onError)
    sock.once('secureConnect', () => {
      sock.removeListener('error', onError)
      resolve(sock)
    })
    sock.setTimeout(timeoutMs, () => onError(new Error('SMTP 连接超时')))
  })
}

function upgradeTls(sock, host) {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket: sock, servername: host })
    secured.once('secureConnect', () => resolve(secured))
    secured.once('error', reject)
  })
}

function buildMessage({ from, to, subject, text, html }) {
  const headers = [
    `From: ${from}`,
    `To: ${Array.isArray(to) ? to.join(', ') : to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(8).toString('hex')}@dsh-mail>`,
    'MIME-Version: 1.0',
  ]
  if (html && String(html).trim()) {
    const boundary = 'b_' + randomBytes(8).toString('hex')
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    return (
      headers.join('\r\n') +
      '\r\n\r\n' +
      `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
      b64Block(text) +
      `\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
      b64Block(html) +
      `\r\n--${boundary}--\r\n`
    )
  }
  headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64')
  return headers.join('\r\n') + '\r\n\r\n' + b64Block(text) + '\r\n'
}

async function smtpSend({ host, port, secure, user, pass, from, to, subject, text, html, timeoutMs = 45000 }) {
  const recipients = (Array.isArray(to) ? to : String(to).split(/[,;]/)).map(addrOnly).filter(Boolean)
  if (recipients.length === 0) throw new Error('至少给一个收件人')
  const envelopeFrom = addrOnly(from)

  let sock = null
  let reader = null
  let timer = null
  const cleanup = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  try {
    timer = setTimeout(() => {
      try { sock && sock.destroy() } catch { /* ignore */ }
    }, timeoutMs + 5000)

    sock = secure ? await connectTls(host, port, timeoutMs) : await connectTcp(host, port, timeoutMs)
    reader = attachReader(sock)

    const send = async (line) => {
      sock.write(line + '\r\n')
      return reader.next()
    }

    let reply = await reader.next()
    if (reply.code !== 220) throw new Error('SMTP 握手失败: ' + reply.lines.join(' '))

    const helo = 'dsh-mail.local'
    reply = await send(`EHLO ${helo}`)
    if (reply.code !== 250) {
      reply = await send(`HELO ${helo}`)
      if (reply.code !== 250) throw new Error('SMTP EHLO/HELO 失败: ' + reply.lines.join(' '))
    }
    const capsText = (reply.lines || []).join('\n').toUpperCase()

    if (!secure && capsText.includes('STARTTLS')) {
      reply = await send('STARTTLS')
      if (reply.code !== 220) throw new Error('SMTP STARTTLS 失败: ' + reply.lines.join(' '))
      sock = await upgradeTls(sock, host)
      reader = attachReader(sock)
      reply = await reader.next()
      if (reply.code !== 220) throw new Error('SMTP STARTTLS 后握手失败')
      reply = await send(`EHLO ${helo}`)
      if (reply.code !== 250) throw new Error('SMTP STARTTLS 后 EHLO 失败')
    }

    if (user && pass) {
      const caps = (reply.lines || []).join('\n').toUpperCase()
      if (caps.includes('AUTH') && caps.includes('LOGIN')) {
        reply = await send('AUTH LOGIN')
        if (reply.code !== 334) throw new Error('SMTP AUTH LOGIN 被拒绝: ' + reply.lines.join(' '))
        reply = await send(b64(user))
        if (reply.code !== 334) throw new Error('SMTP 用户名被拒绝: ' + reply.lines.join(' '))
        reply = await send(b64(pass))
        if (reply.code !== 235) throw new Error('SMTP 认证失败（检查授权码/手机号）: ' + reply.lines.join(' '))
      } else if (caps.includes('AUTH') && caps.includes('PLAIN')) {
        reply = await send('AUTH PLAIN ' + b64('\u0000' + user + '\u0000' + pass))
        if (reply.code !== 235) throw new Error('SMTP 认证失败（检查授权码）: ' + reply.lines.join(' '))
      } else {
        throw new Error('SMTP 服务器不支持 AUTH LOGIN/PLAIN，请改用 465(SSL) 或 587(STARTTLS) 端口')
      }
    }

    reply = await send(`MAIL FROM:<${envelopeFrom}>`)
    if (reply.code !== 250) throw new Error('SMTP MAIL FROM 被拒绝: ' + reply.lines.join(' '))

    for (const rcpt of recipients) {
      reply = await send(`RCPT TO:<${rcpt}>`)
      if (reply.code !== 250 && reply.code !== 251) {
        throw new Error(`SMTP 收件人 ${rcpt} 被拒绝: ` + reply.lines.join(' '))
      }
    }

    reply = await send('DATA')
    if (reply.code !== 354) throw new Error('SMTP DATA 被拒绝: ' + reply.lines.join(' '))

    const message = buildMessage({ from, to: recipients, subject, text, html })
    sock.write(message + '\r\n.\r\n')
    reply = await reader.next()
    if (reply.code !== 250) throw new Error('邮件被服务器拒收: ' + reply.lines.join(' '))

    try {
      sock.write('QUIT\r\n')
      await reader.next()
    } catch { /* 关闭即可 */ }
    try { sock.end() } catch { /* ignore */ }
    return { accepted: recipients }
  } finally {
    cleanup()
  }
}

/* ------------------------------------------------------------------ */
/* Guerrilla Mail 临时通道（零配置发信，纯 fetch）                       */
/*                                                                     */
/* 实测契约（2026-10 验证）：                                            */
/*   GET  ajax.php?f=get_email_address&ip=&agent=                       */
/*        -> { email_addr, email_timestamp, alias, sid_token }          */
/*   GET  ajax.php?f=set_email_user&sid_token=&email_user=  （可选改名）  */
/*        -> { email_addr, sid_token, ... }                            */
/*   GET|POST ajax.php?f=send_email                                      */
/*        &sid_token=&from=&to=&subject=&body=                          */
/*        · 不带 from（或 from 不是本 session 的地址）                     */
/*          -> { valid:false, error:"Invalid from address", error_code:1 } */
/*        · 收件人是 Guerrilla 自己域名（内部投递）                        */
/*          -> { valid:true, mail_id, affected, queue_id, error:null }   */
/*        · 收件人是外部真实域名（gmail/qq/mail.tm…）                     */
/*          -> { captcha_html:"", needs_captcha:true, security_check_status:false } */
/*             = 需要人机验证，邮件根本没发出去，API 无解                   */
/*   频率：内部连发 5 封（间隔 1.2s）全部成功，未见限流。                     */
/*   HTML：无独立的 html 标志位，body 按纯文本收，别指望做成 HTML 邮件。       */
/* ------------------------------------------------------------------ */

const GM_BASE = 'https://api.guerrillamail.com/ajax.php'
const GM_AGENT = 'dsh-mail/0.1'
// Guerrilla 自家域名：只有这些收件人不需要人机验证
const GM_OWN_DOMAINS = [
  'guerrillamailblock.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamail.biz',
  'sharklasers.com',
  'grr.la',
  'spam4.me',
  'pokemail.net',
]
const GM_SESSION_TTL = 45 * 60_000 // 服务端会话约 1 小时有效，留出余量

async function gmCall(params, { method = 'GET' } = {}) {
  const url = `${GM_BASE}?` + new URLSearchParams({ ...params, ip: '127.0.0.1', agent: GM_AGENT })
  let res
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', 'User-Agent': GM_AGENT },
      signal: AbortSignal.timeout(25000),
    })
  } catch (error) {
    throw new Error('连不上 Guerrilla Mail（检查网络/代理）: ' + (error?.message || error))
  }
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) {
    throw new Error(`Guerrilla Mail ${res.status}: ${String(typeof data === 'string' ? data : text).slice(0, 200)}`)
  }
  if (typeof data !== 'object' || data === null) {
    throw new Error('Guerrilla Mail 返回了看不懂的内容: ' + String(text).slice(0, 200))
  }
  return data
}

/** 取（或复用）一个临时发信身份；地址缓存在 config.tempMail 里，省得每次新开 */
async function gmSession(cfg, { force = false } = {}) {
  const cached = cfg.tempMail
  if (!force && cached?.sidToken && cached?.address && (cached.exp || 0) > Date.now()) {
    return { sidToken: cached.sidToken, address: cached.address }
  }
  const data = await gmCall({ f: 'get_email_address' })
  const sidToken = data.sid_token || data.sidToken
  const address = data.email_addr || data.email_address
  if (!sidToken || !address) throw new Error('Guerrilla Mail 没给出行之有效的 sid_token/email_addr')

  const next = { ...cfg, tempMail: { sidToken, address, exp: Date.now() + GM_SESSION_TTL, createdAt: Date.now() } }
  try {
    saveCfg(next)
    Object.assign(cfg, next)
  } catch { /* 存不下也不影响这次发送 */ }
  return { sidToken, address }
}

function gmIsOwnDomain(address) {
  const domain = String(address || '').split('@').pop().toLowerCase()
  return GM_OWN_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))
}

/**
 * 用 Guerrilla 临时域名发一封信。
 * 成功返回 { accepted, from, mailId }；失败抛 Error（error.code 标明类型）。
 */
async function gmSend(cfg, { to, subject, text }) {
  const recipients = (Array.isArray(to) ? to : String(to).split(/[,;]/)).map(addrOnly).filter(Boolean)
  if (recipients.length === 0) throw new Error('至少给一个收件人')

  const { sidToken, address: from } = await gmSession(cfg)

  const data = await gmCall({
    f: 'send_email',
    sid_token: sidToken,
    from, // 必须带，否则服务端回 "Invalid from address"
    to: recipients.join(','),
    subject: String(subject || ''),
    body: String(text || ''),
  })

  if (data.valid === true) {
    return { accepted: recipients, from, mailId: data.mail_id ?? data.affected ?? null }
  }

  // 会话过期：换个新身份再来一次
  if (!data.valid && /session|sid/i.test(String(data.error || ''))) {
    const fresh = await gmSession(cfg, { force: true })
    const retry = await gmCall({
      f: 'send_email',
      sid_token: fresh.sidToken,
      from: fresh.address,
      to: recipients.join(','),
      subject: String(subject || ''),
      body: String(text || ''),
    })
    if (retry.valid === true) {
      return { accepted: recipients, from: fresh.address, mailId: retry.mail_id ?? retry.affected ?? null }
    }
    throw gmError(retry)
  }

  throw gmError(data)
}

/** 把 Guerrilla 的各种失败翻译成人话 */
function gmError(data) {
  const external = (data && data.needs_captcha === true && !data.valid)
  if (external) {
    const err = new Error(
      '临时域名通道发不出去：Guerrilla Mail 对「发往外部真实域名」的邮件要求人机验证（返回 needs_captcha=true），' +
      '公开 API 无法自动完成，所以这封信实际没有被投递。' +
      '临时通道只对 Guerrilla 自己的临时域名（@guerrillamailblock.com 等）有效。' +
      '要给真实邮箱发信，请用 mail_smtp_config 配置 SMTP（QQ/163 到网页版设置里开启 SMTP 并生成授权码，不是登录密码）。',
    )
    err.code = 'GM_CAPTCHA'
    return err
  }
  const detail = data?.error || (data?.error_code != null ? `error_code=${data.error_code}` : '') || JSON.stringify(data).slice(0, 200)
  const err = new Error('临时域名通道发信失败：' + String(detail))
  err.code = 'GM_REJECTED'
  if (data?.error_code === 1) {
    err.message += '（from 必须是本 session 的临时地址）'
  }
  return err
}

/* ------------------------------------------------------------------ */
/* 插件主体                                                            */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    try {
      const cfg = loadCfg()
      if (!cfg.address) return assembled
      const canSend = cfg.smtp && cfg.smtp.host
        ? '可发信'
        : '未配 SMTP：mail_send 会先自动尝试 Guerrilla 临时域名通道，但该通道对真实邮箱要求人机验证、多半发不出去（只对 @guerrillamailblock.com 等自家域名有效）'
      assembled.sections.push({
        name: 'dsh-mail:account',
        text: `你有一个自己的电子邮箱 ${cfg.address}（${canSend}）。需要收验证码用 mail_wait，看收件箱用 mail_inbox，读原文用 mail_read，发信用 mail_send。`,
      })
    } catch { /* 注入失败不影响会话 */ }
    return assembled
  })

  const guard = (fn) => async (args, exec) => {
    try {
      return await fn(args || {}, exec)
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  /* ---- 邮箱地址：查看 / 新建 ---- */
  ctx.tools.register(defineTool({
    name: 'mail_address',
    description:
      '查看或创建你自己的专属邮箱地址（零配置，基于 mail.tm 免费邮箱）。' +
      '第一次使用会自动开通一个地址并永久保存在本地。' +
      'create=true 时新建一个全新地址（旧的地址作废）。domain 可指定域名，一般不用传。',
    parameters: {
      create: { type: 'boolean', description: '是否新建一个地址（会替换当前地址）' },
      domain: { type: 'string', description: '可选，指定邮箱域名（不传用默认可用域名）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) =>
        value.ok
          ? [{ type: 'text', text: `${value.address}\nSMTP 发信：${value.smtpReady ? '已配置' : '未配置（用 mail_smtp_config 配置后可发信）'}` }]
          : [{ type: 'text', text: `✗ ${value.error}` }],
    },
    execute: guard(async (args) => {
      const cfg = loadCfg()
      if (!cfg.address || args.create === true) {
        await createAddress(cfg, args.domain)
      }
      const fresh = loadCfg()
      return {
        ok: true,
        address: fresh.address,
        accountId: fresh.accountId || '',
        smtpReady: Boolean(fresh.smtp && fresh.smtp.host),
        createdAt: fresh.createdAt ? fmtTime(fresh.createdAt) : '',
      }
    }),
  }))

  /* ---- 收件箱 ---- */
  ctx.tools.register(defineTool({
    name: 'mail_inbox',
    description:
      '查看自己邮箱的收件箱（最新在前）。返回每封的发件人、主题、时间、未读状态和摘要；' +
      '要看正文用 mail_read（传返回的 id）。收验证码请优先用 mail_wait。',
    parameters: {
      limit: { type: 'number', description: '返回条数，默认 20，最多 50' },
      unreadOnly: { type: 'boolean', description: '只看未读' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `✗ ${value.error}` }]
        if (value.messages.length === 0) return [{ type: 'text', text: `${value.address} 收件箱是空的` }]
        const lines = value.messages.map((m, i) =>
          `${i + 1}. ${m.seen ? '' : '[未读] '}${m.subject || '(无主题)'}\n   ${m.from} · ${m.receivedAt}\n   id: ${m.id}${m.intro ? '\n   ' + m.intro.slice(0, 120) : ''}`,
        )
        return [{ type: 'text', text: `${value.address} 收件箱（${value.total} 封）\n\n` + lines.join('\n\n') }]
      },
    },
    execute: guard(async (args) => {
      const cfg = loadCfg()
      const list = await listMessages(cfg, { limit: Number(args.limit) || 20 })
      const messages = (args.unreadOnly ? list.filter((m) => !m.seen) : list).map((m) => ({
        id: m.id,
        subject: m.subject || '',
        from: senderOf(m),
        receivedAt: fmtTime(m.createdAt),
        createdAt: m.createdAt,
        seen: Boolean(m.seen),
        intro: m.intro || '',
        attachments: Boolean(m.hasAttachments),
      }))
      return { ok: true, address: cfg.address, total: list.length, messages }
    }),
  }))

  /* ---- 读邮件 ---- */
  ctx.tools.register(defineTool({
    name: 'mail_read',
    description: '按 id 读取一封邮件的完整正文（纯文本优先，HTML 自动转文本）。id 从 mail_inbox / mail_wait 结果里拿。',
    parameters: {
      id: { type: 'string', required: true, description: '邮件 id' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) =>
        value.ok
          ? [{ type: 'text', text: `主题：${value.mail.subject || '(无主题)'}\n发件人：${value.mail.from}\n时间：${value.mail.receivedAt}\n\n${value.mail.body}` }]
          : [{ type: 'text', text: `✗ ${value.error}` }],
    },
    execute: guard(async (args) => {
      const cfg = loadCfg()
      const full = await readMessage(cfg, String(args.id).trim())
      return {
        ok: true,
        mail: {
          id: full.id,
          subject: full.subject || '',
          from: senderOf(full),
          to: (full.to || []).map((t) => t.address || t).join(', '),
          receivedAt: fmtTime(full.createdAt),
          body: mailBody(full),
          attachments: Boolean(full.hasAttachments),
        },
      }
    }),
  }))

  /* ---- 等验证码 ---- */
  ctx.tools.register(defineTool({
    name: 'mail_wait',
    description:
      '在自己邮箱里等一封新邮件并提取验证码（收验证码专用）。默认轮询 120 秒，' +
      '自动从正文中抓 4~8 位数字验证码；也可传 pattern 指定正则（第 1 个捕获组或整体）。' +
      '刚触发过发送验证码的站点，可以直接调用；includeRecentSec 可把最近已到的邮件也算进来。',
    parameters: {
      timeoutSec: { type: 'number', description: '最多等多少秒，默认 120，最大 300' },
      pattern: { type: 'string', description: '可选，抓验证码的正则，例如 "\\\\b(\\\\d{4,6})\\\\b"' },
      subjectIncludes: { type: 'string', description: '可选，只认主题包含该子串的邮件' },
      includeRecentSec: { type: 'number', description: '可选，把最近 N 秒内已到的邮件也纳入候选，默认 90' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `✗ ${value.error}` }]
        if (value.timeout) {
          return [{ type: 'text', text: `等了 ${value.waitedSec} 秒没收到新邮件（${value.address}）。可以让对方重发，或先用 mail_inbox 看看。` }]
        }
        return [{
          type: 'text',
          text: `验证码：${value.code || '(没识别出，正文见下)'}\n\n主题：${value.mail.subject}\n发件人：${value.mail.from}\n时间：${value.mail.receivedAt}\n\n${value.mail.body.slice(0, 1500)}`,
        }]
      },
    },
    execute: guard(async (args) => {
      const cfg = loadCfg()
      if (!cfg.address) throw new Error('还没有自己的邮箱，先调用 mail_address 创建')

      const timeoutSec = Math.min(Math.max(Number(args.timeoutSec) || 120, 5), 300)
      const recentSec = Math.min(Math.max(Number(args.includeRecentSec ?? 90), 0), 3600)
      const started = Date.now()
      const deadline = started + timeoutSec * 1000

      const baseline = new Set()
      try {
        for (const m of await listMessages(cfg, { limit: 30 })) baseline.add(m.id)
      } catch { /* 基线失败就按时间判断 */ }

      const subjectIncludes = String(args.subjectIncludes || '').trim().toLowerCase()

      while (Date.now() < deadline) {
        let list = []
        try {
          list = await listMessages(cfg, { limit: 30 })
        } catch {
          await sleep(3000)
          continue
        }
        for (const item of list) {
          const fresh = !baseline.has(item.id)
          const recent = recentSec > 0 && (Date.now() - new Date(item.createdAt).getTime() <= recentSec * 1000)
          if (!fresh && !recent) continue
          if (subjectIncludes && !String(item.subject || '').toLowerCase().includes(subjectIncludes)) continue

          const full = await readMessage(cfg, item.id)
          const body = mailBody(full)
          const haystack = `${full.subject || ''}\n${body}`
          const code = extractCode(haystack, args.pattern)
          if (args.pattern && !code) continue
          baseline.add(item.id)
          return {
            ok: true,
            address: cfg.address,
            code: code || null,
            mail: {
              id: full.id,
              subject: full.subject || '',
              from: senderOf(full),
              receivedAt: fmtTime(full.createdAt),
              body,
            },
            waitedSec: Math.round((Date.now() - started) / 1000),
          }
        }
        await sleep(3000)
      }

      return {
        ok: true,
        timeout: true,
        address: cfg.address,
        waitedSec: Math.round((Date.now() - started) / 1000),
      }
    }),
  }))

  /* ---- 发信 ---- */
  ctx.tools.register(defineTool({
    name: 'mail_send',
    description:
      '发一封邮件。通道回退链：配了 SMTP 就优先走 SMTP（QQ/163/Gmail 等，用 mail_smtp_config 配置，pass 填授权码）；' +
      '没配 SMTP 时自动尝试 Guerrilla Mail 临时域名通道（零配置，但实测只能投递到 @guerrillamailblock.com 等 Guerrilla 自家域名，' +
      '发往真实域名会被人机验证挡住，工具会如实报错、不会假装成功）。' +
      'channel 可强制指定：auto（默认）/ smtp / temp。支持中文主题/正文；HTML 版本只在 SMTP 通道生效。',
    parameters: {
      to: { type: 'string', required: true, description: '收件人，多个用逗号或分号分隔' },
      subject: { type: 'string', required: true, description: '主题' },
      body: { type: 'string', required: true, description: '正文（纯文本）' },
      html: { type: 'string', description: '可选，HTML 正文（仅 SMTP 通道支持）' },
      channel: { type: 'string', description: '可选，强制通道：auto（默认，SMTP 优先、失败回退临时）/ smtp / temp' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `✗ ${value.error}` }]
        if (value.channel === 'temp') {
          return [{
            type: 'text',
            text: `已通过临时域名通道发出 → ${value.to.join(', ')}\n发件人：${value.from}\n` +
              `⚠ 这是 Guerrilla Mail 的临时域名，不是正常邮箱：收件方大概率判垃圾/直接拒收，也别用这个身份做正式通信。`,
          }]
        }
        return [{ type: 'text', text: `已从 ${value.from} 发出 → ${value.to.join(', ')}` }]
      },
    },
    execute: guard(async (args) => {
      const cfg = loadCfg()
      const smtp = cfg.smtp
      const smtpReady = Boolean(smtp && smtp.host)
      const recipients = String(args.to).split(/[,;]/).map(addrOnly).filter(Boolean)
      if (recipients.length === 0) throw new Error('至少给一个收件人')

      const channel = String(args.channel || 'auto').toLowerCase()
      if (!['auto', 'smtp', 'temp'].includes(channel)) {
        throw new Error(`channel 只能是 auto / smtp / temp，收到的是 ${args.channel}`)
      }

      const doSmtp = async () => {
        if (!smtpReady) {
          throw new Error('还没配置发信账号，先调用 mail_smtp_config 填 host/port/user/pass（pass 填邮箱授权码）')
        }
        const from = smtp.from || smtp.user
        const result = await smtpSend({
          host: smtp.host,
          port: Number(smtp.port) || (smtp.secure ? 465 : 587),
          secure: Boolean(smtp.secure),
          user: smtp.user,
          pass: smtp.pass,
          from,
          to: recipients,
          subject: String(args.subject || ''),
          text: String(args.body || ''),
          html: args.html ? String(args.html) : '',
        })
        return { ok: true, channel: 'smtp', from, to: result.accepted }
      }

      const doTemp = async () => {
        const result = await gmSend(cfg, {
          to: recipients,
          subject: String(args.subject || ''),
          text: String(args.body || ''),
        })
        return {
          ok: true,
          channel: 'temp',
          from: result.from,
          to: result.accepted,
          mailId: result.mailId,
          warning: '临时域名，收件方可能判垃圾/被拒',
        }
      }

      if (channel === 'smtp') return doSmtp()
      if (channel === 'temp') return doTemp()

      // auto：SMTP 优先，失败/未配置再回退临时通道
      let smtpError = null
      if (smtpReady) {
        try {
          return await doSmtp()
        } catch (error) {
          smtpError = error
        }
      }
      try {
        return await doTemp()
      } catch (tempError) {
        const parts = []
        if (smtpReady) parts.push('SMTP 通道失败：' + String(smtpError?.message || smtpError))
        else parts.push('未配置 SMTP（mail_smtp_config 可配）')
        parts.push('临时通道失败：' + String(tempError?.message || tempError))
        throw new Error(parts.join('\n'))
      }
    }),
  }))

  /* ---- SMTP 配置 ---- */
  ctx.tools.register(defineTool({
    name: 'mail_smtp_config',
    description:
      '配置/查看/清除发信用的 SMTP 账号。注意：pass 要填「授权码」，不是登录密码——' +
      'QQ 邮箱：网页版 设置 → 账号 → 开启「POP3/SMTP 服务」→ 生成授权码，服务器 smtp.qq.com:465(SSL)；' +
      '163：网页版 设置 → POP3/SMTP/IMAP → 开启 SMTP 服务 → 生成客户端授权码，服务器 smtp.163.com:465(SSL)；' +
      'Gmail：smtp.gmail.com:465(SSL) 用「应用专用密码」。' +
      '不传参数=查看当前状态；clear=true=清除（清除后 mail_send 回退到临时域名通道）。',
    parameters: {
      host: { type: 'string', description: 'SMTP 服务器，如 smtp.qq.com' },
      port: { type: 'number', description: '端口，SSL 用 465，STARTTLS 用 587' },
      secure: { type: 'boolean', description: '是否 SSL 直连（465 端口填 true）' },
      user: { type: 'string', description: '登录账号（通常是完整邮箱地址）' },
      pass: { type: 'string', description: '邮箱授权码（QQ/163 到网页设置里开启 SMTP 服务后生成的授权码，不是登录密码）' },
      from: { type: 'string', description: '可选，发件人地址（默认同 user）' },
      clear: { type: 'boolean', description: '清除已配置的 SMTP 账号' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `✗ ${value.error}` }]
        if (!value.configured) {
          return [{
            type: 'text',
            text:
              'SMTP 未配置（目前只能收信，不能给真实邮箱发信）\n\n' +
              '一次性设置（3 分钟，pass 填「授权码」不是登录密码）：\n' +
              '· QQ 邮箱：打开 https://mail.qq.com → 设置 → 账号 → 开启「POP3/SMTP服务」→ 按提示生成授权码；\n' +
              '  然后调用 mail_smtp_config host=smtp.qq.com port=465 secure=true user=你的完整QQ邮箱 pass=授权码\n' +
              '· 163 邮箱：打开 https://mail.163.com → 设置 → POP3/SMTP/IMAP → 开启 SMTP → 生成客户端授权码；\n' +
              '  然后 host=smtp.163.com port=465 secure=true\n' +
              '· Gmail：需要在 Google 账号里开启两步验证并生成「应用专用密码」；host=smtp.gmail.com port=465 secure=true',
          }]
        }
        return [{ type: 'text', text: `SMTP：${value.host}:${value.port} (${value.secure ? 'SSL' : 'STARTTLS'}) 账号 ${value.user}，发件人 ${value.from}` }]
      },
    },
    execute: guard(async (args) => {
      const cfg = loadCfg()
      if (args.clear === true) {
        delete cfg.smtp
        saveCfg(cfg)
        return { ok: true, configured: false }
      }
      const hasInput = ['host', 'port', 'user', 'pass', 'from'].some((k) => args[k] !== undefined && args[k] !== '')
      if (hasInput) {
        const prev = cfg.smtp || {}
        const smtp = {
          host: String(args.host ?? prev.host ?? '').trim(),
          port: Number(args.port ?? prev.port ?? (args.secure === true || prev.secure ? 465 : 587)),
          secure: args.secure === undefined ? Boolean(prev.secure ?? false) : Boolean(args.secure),
          user: String(args.user ?? prev.user ?? '').trim(),
          pass: String(args.pass ?? prev.pass ?? ''),
          from: String(args.from ?? prev.from ?? '').trim(),
        }
        if (!smtp.host || !smtp.user || !smtp.pass) {
          throw new Error('配置不完整：host / user / pass 都必须有（pass 填邮箱授权码——QQ/163 要先去网页设置里开启 SMTP 服务并生成授权码，不是登录密码）')
        }
        cfg.smtp = smtp
        saveCfg(cfg)
      }
      const smtp = cfg.smtp
      return {
        ok: true,
        configured: Boolean(smtp && smtp.host),
        host: smtp?.host || '',
        port: smtp?.port || 0,
        secure: Boolean(smtp?.secure),
        user: smtp?.user || '',
        from: smtp?.from || smtp?.user || '',
        address: cfg.address || '',
      }
    }),
  }))
}

// 供离线自测/调试用的内部导出（不影响插件运行）
export const __test = { htmlToText, extractCode, buildMessage, smtpSend, createAddress, gmCall, gmSession, gmSend, gmIsOwnDomain, describeAccount: () => ({ address: (loadCfg().address || ''), smtpReady: Boolean(loadCfg().smtp && loadCfg().smtp.host), tempMail: loadCfg().tempMail || null }) }
