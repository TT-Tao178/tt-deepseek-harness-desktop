// ============================================================================
// dsh-pet-roxy —— 宿主插件（唯一 Node 入口，ESM，零依赖）
//
// 功能：
//   - /dsh-pet-roxy/* 路由组（widget.js / image / user-image / config / prefs /
//     balance.json / last-turn.json / tasks）
//   - tapIndex 注入页面脚本（每次打开 DSH Web 自动启用）
//   - 余额拉取（缓存 / 重试 / 瞬时失败回退 stale）
//   - 今日已用：记账模式（余额差值，币种感知，跨天归档 30 天）+ 令牌模式（可选）
//   - 每轮对话消耗：监听 session/event，按 (session,turn) 聚合，峰谷定价换算，
//     结算时附 reaction 表情
//   - 任务看板：用户登记任务 CRUD + 统计（今日/已完成/进行中/失败 + 7 天趋势）
//   - 用户图片上传：base64 JSON 传输，魔数校验，槽位分配
//   - 宿主任务事件探测（可选增强，探测失败静默回落，不影响任何功能）
//
// ============================================================================
// 行为 → 表情键 → 图片 → 触发方式（映射由 assets/roxy-config.json 的 expressions 决定）
//   default 默认     roxy0.png  开机/待机
//   happy   行为一   roxy1.png  单击（与行为二随机二选一）；任务完成；每轮消耗 <5 元
//   surprised 行为二 roxy2.png  单击（与行为一随机二选一）；任务失败；每轮消耗 ≥5 元
//   sleepy  行为三   roxy3.png  任务进行中 80% 概率出现，平时 20% 概率出现（工作态）
//   angry   行为四   roxy4.png  双击；随机犯困（25~35 秒，30% 概率；任务进行中不犯困）
// ============================================================================
//
// 设计说明见项目 README.md
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const UPLOAD_DIR = path.join(DSH_HOME, 'dsh-pet-roxy-uploads')
const CONFIG_OVERRIDE_FILE = path.join(DSH_HOME, '.dshp-roxy-config.json')
const USAGE_FILE = path.join(DSH_HOME, '.dshp-roxy-usage.json')
const TASKS_FILE = path.join(DSH_HOME, '.dshp-roxy-tasks.json')
const ASSETS_DIR = path.join(PACKAGE_ROOT, 'assets')
const CLIENT_FILE = path.join(PACKAGE_ROOT, 'client', 'roxy-widget.js')

const name = 'dsh-pet-roxy'
const inject = ['webServer', 'credentials']

// ---------------------------------------------------------------------------
// 峰谷定价（DeepSeek CNY 每百万 token 单价；2026-08-23 起周末全天谷价）
// ---------------------------------------------------------------------------
const PEAK_HOURS = [[9, 12], [14, 18]]
const BASE_PRICE = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING = {
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
  _default: BASE_PRICE,
}
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)

function priceFor(model) {
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.indexOf(key) !== -1) return PRICING[key]
  }
  return PRICING._default
}

function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const n = Number(timeSec)
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay()
    if (dow === 0 || dow === 6) return false
  }
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 兜底最小配置（包内配置解析失败时使用）
// ---------------------------------------------------------------------------
const FALLBACK_CONFIG = {
  expressions: { default: 'roxy0.png', happy: 'roxy1.png', surprised: 'roxy2.png', sleepy: 'roxy3.png', angry: 'roxy4.png' },
  reactions: {
    turnCost: [{ min: 5, expr: 'surprised' }, { min: 0.01, expr: 'happy' }, { min: 0, expr: 'angry' }],
    balanceLow: { threshold: 10, line: '余额不多了。……自己看着办。' },
  },
  prefs: { scale: 1.0, corner: 'bottom-right', marginX: 16, marginY: 16, mirrorOnLeft: false, animationOn: true, linesOn: true, turnCostOn: true, turnCostCloseMs: 5000 },
  behavior: { breatheMs: 2400, flickEverySec: [10, 20], flickChance: 0.2, flickMs: 1200, sleepyEverySec: [25, 35], sleepyChance: 0.3, sleepyMs: 5000, refreshMs: 60000, bubbleMs: 5000, taskPollMs: 1000 },
  speech: { toggles: { randomLines: true, turnCost: true, balanceLow: true }, customLines: [] },
  lines: [],
  reportLines: { taskDone: '……%title%，做完了。', taskFailed: '%title%……失败了。自己看日志。', taskAdded: '记下了：%title%。' },
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function todayKey() {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function uuid() {
  return crypto.randomBytes(8).toString('hex')
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

// 去注释（JSONC 支持 // 与 /* */；引号内不处理）
function stripJsonc(src) {
  let out = ''
  let inStr = false
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (inStr) {
      out += c
      if (c === '\\') { out += next || ''; i += 2; continue }
      if (c === '"') inStr = false
      i += 1
      continue
    }
    if (c === '"') { inStr = true; out += c; i += 1; continue }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue }
    if (c === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue }
    out += c
    i += 1
  }
  return out
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const key of Object.keys(over)) {
    const b = base[key]
    const o = over[key]
    out[key] = isPlainObject(b) && isPlainObject(o) ? deepMerge(b, o) : o
  }
  return out
}

function readJsonFile(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(stripJsonc(raw))
    if (parsed && typeof parsed === 'object') return parsed
  } catch (err) { /* fallthrough */ }
  return fallback
}

function atomicWriteJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${uuid()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch (err2) { /* ignore */ }
    return false
  }
}

// 包内默认配置 + 用户覆盖深合并
function loadConfig() {
  const defaults = readJsonFile(path.join(ASSETS_DIR, 'roxy-config.json'), FALLBACK_CONFIG)
  const user = readJsonFile(CONFIG_OVERRIDE_FILE, {})
  return deepMerge(defaults, user)
}

function writeUserConfig(user) {
  return atomicWriteJson(CONFIG_OVERRIDE_FILE, user)
}

function readUserConfig() {
  return readJsonFile(CONFIG_OVERRIDE_FILE, {})
}

function readUsageLedger() {
  return readJsonFile(USAGE_FILE, { date: todayKey(), lastBalance: null, lastCurrency: '', todayUsage: 0, history: {} })
}

function writeUsageLedger(led) {
  return atomicWriteJson(USAGE_FILE, led)
}

function readTasksFile() {
  const data = readJsonFile(TASKS_FILE, { tasks: [] })
  if (!Array.isArray(data.tasks)) data.tasks = []
  return data
}

function writeTasksFile(data) {
  return atomicWriteJson(TASKS_FILE, data)
}

// 记账模式：余额差值累计（币种感知，跨天归档 30 天）
function recordLedgerUsage(currentBalance, currency) {
  const t = todayKey()
  let led = readUsageLedger()
  const cur = String(currency || '')
  const currencyChanged =
    typeof led.lastCurrency === 'string' && led.lastCurrency !== '' &&
    cur !== '' && led.lastCurrency !== cur
  if (led.date !== t) {
    if (led.date && typeof led.todayUsage === 'number') {
      led.history = led.history || {}
      led.history[led.date] = led.todayUsage
    }
    led.date = t
    led.lastBalance = currentBalance
    led.lastCurrency = cur
    led.todayUsage = 0
  } else if (currencyChanged) {
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  } else {
    const prev = typeof led.lastBalance === 'number' ? led.lastBalance : currentBalance
    if (typeof prev === 'number' && typeof currentBalance === 'number' && currentBalance < prev) {
      led.todayUsage = (typeof led.todayUsage === 'number' ? led.todayUsage : 0) + (prev - currentBalance)
    }
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  }
  const keys = Object.keys(led.history || {}).sort()
  while (keys.length > 30) {
    delete led.history[keys.shift()]
  }
  writeUsageLedger(led)
  return led
}

function reactionFor(amount, config) {
  const rules = (config && Array.isArray(config.reactions && config.reactions.turnCost))
    ? config.reactions.turnCost
    : FALLBACK_CONFIG.reactions.turnCost
  const n = Number(amount) || 0
  let match = 'sleepy'
  for (const rule of rules) {
    if (n >= (Number(rule.min) || 0)) { match = rule.expr; break }
  }
  return match
}

// 任务统计：today + 7 天趋势（口径见设计文档 5.5）
function taskStats(tasks) {
  const t = todayKey()
  const today = tasks.filter((x) => x.date === t)
  const count = (list, s) => list.filter((x) => x.status === s).length
  const dates = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    dates.push(`${d.getFullYear()}-${m}-${day}`)
  }
  const byDate = new Map()
  for (const task of tasks) {
    if (!byDate.has(task.date)) byDate.set(task.date, { done: 0, doing: 0, failed: 0, total: 0 })
    const bucket = byDate.get(task.date)
    bucket.total += 1
    if (task.status === 'done') bucket.done += 1
    else if (task.status === 'doing') bucket.doing += 1
    else if (task.status === 'failed') bucket.failed += 1
  }
  const trendFixed = dates.map((d) => ({ date: d, ...(byDate.get(d) || { done: 0, doing: 0, failed: 0, total: 0 }) }))
  return {
    today: { total: today.length, done: count(today, 'done'), doing: count(today, 'doing'), failed: count(today, 'failed') },
    trend: trendFixed,
  }
}

// 图片魔数嗅探：PNG / JPEG / WebP；返回规范化 mime 或 null
function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

function extForMime(mime) {
  return mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png'
}

function contentTypeFor(name) {
  const lower = String(name).toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'application/octet-stream'
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
}

// ---------------------------------------------------------------------------
// apply(ctx)
// ---------------------------------------------------------------------------
function apply(ctx) {
  const disposers = []
  const packageImageBytes = new Map() // name -> Buffer（包内图缓存）
  let balanceCache = null // { value, at }
  let balanceInFlight = null
  let turnAggs = new Map() // sessionId -> { turn, cost, tokens, lastTs }
  let lastTurn = null
  let lastTurnSeq = 0
  // 用户上传图内存缓存：name -> { bytes, ts }
  const userImageCache = new Map()

  function readBody(req, maxSize) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > maxSize) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function queryOf(req) {
    const q = String(req.url || '').split('?')[1] || ''
    return new URLSearchParams(q)
  }

  function sendJson(res, status, obj) {
    res.writeHead(status, JSON_HEADERS)
    res.end(JSON.stringify(obj))
  }

  function sendOk(res, obj) {
    sendJson(res, 200, obj)
  }

  function safeHandler(handler) {
    return (req, res) => Promise.resolve()
      .then(() => handler(req, res))
      .catch((err) => {
        try {
          sendOk(res, { ok: false, code: 'ERROR', error: String((err && err.message) || err).slice(0, 200) })
        } catch (err2) { /* res already sent */ }
      })
  }

  // ---- 配置 ----
  function mergedConfig() {
    return loadConfig()
  }

  // ---- 余额 ----
  function pickBalanceInfo(infos) {
    if (!Array.isArray(infos) || infos.length === 0) return null
    const num = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
    return (
      infos.find((x) => x && x.currency === 'CNY' && num(x) > 0) ||
      infos.find((x) => num(x) > 0) ||
      infos.find((x) => x && x.currency === 'CNY') ||
      infos[0]
    )
  }

  function normalizeUsageMode(m) {
    return m === 'token' ? 'token' : 'ledger'
  }

  async function fetchBalance() {
    let cred
    try {
      cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
    } catch (err) {
      return { ok: false, code: 'NO_KEY', error: '凭据读取失败: ' + String((err && err.message) || err).slice(0, 160) }
    }
    if (!cred) {
      return { ok: false, code: 'NO_KEY', error: '未配置 DEEPSEEK_API_KEY' }
    }
    let lastErr = null
    let res = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch('https://api.deepseek.com/user/balance', {
          headers: { Authorization: 'Bearer ' + cred.value },
          signal: AbortSignal.timeout(20000),
        })
        break
      } catch (err) {
        lastErr = err
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
      }
    }
    if (!res) {
      const cached = balanceCache ? balanceCache.value : null
      if (cached && cached.ok) {
        return { ...cached, stale: true }
      }
      return { ok: false, code: 'NETWORK', error: '余额接口请求失败: ' + String((lastErr && lastErr.message) || lastErr).slice(0, 160), transient: true }
    }
    let json = null
    try {
      json = await res.json()
    } catch (err) {
      lastErr = err
      json = null
    }
    if (!res.ok || !json || json.code !== 0) {
      const cached = balanceCache ? balanceCache.value : null
      if (cached && cached.ok && res.status >= 500) {
        return { ...cached, stale: true }
      }
      return {
        ok: false,
        code: 'API',
        error: '余额接口返回异常: HTTP ' + res.status + ' ' + String((json && json.error && json.error.message) || (json && json.msg) || (lastErr && lastErr.message) || '').slice(0, 160),
      }
    }
    const info = pickBalanceInfo(json.balance_infos)
    const total = info ? Number(info.total_balance) : NaN
    const currency = info ? String(info.currency || 'CNY') : 'CNY'
    const cfg = mergedConfig()
    const usageMode = normalizeUsageMode(cfg.prefs && cfg.prefs.usageMode)
    const led = usageMode === 'token' ? readUsageLedger() : recordLedgerUsage(total, currency)
    const payload = {
      ok: true,
      totalBalance: Number.isFinite(total) ? total : null,
      currency,
      updatedAt: Date.now(),
      todayUsage: typeof led.todayUsage === 'number' ? led.todayUsage : 0,
      isPeak: isPeakTime(Math.floor(Date.now() / 1000)),
      usageMode,
    }
    balanceCache = { value: payload, at: Date.now() }
    return payload
  }

  function getBalance() {
    const cfg = mergedConfig()
    const ttl = 25000
    if (balanceCache && Date.now() - balanceCache.at < ttl) {
      return Promise.resolve(balanceCache.value)
    }
    if (balanceInFlight) return balanceInFlight
    balanceInFlight = fetchBalance().finally(() => { balanceInFlight = null })
    return balanceInFlight
  }

  // ---- 每轮消耗（会话事件） ----
  function finalizeTurn(sessionId) {
    const agg = turnAggs.get(sessionId)
    if (agg) {
      if (agg.cost > 0) {
        const cfg = mergedConfig()
        lastTurn = {
          turn: agg.turn,
          amount: Math.round(agg.cost * 100) / 100,
          tokens: agg.tokens,
          reaction: reactionFor(agg.cost, cfg),
          ts: agg.lastTs,
        }
        lastTurnSeq++
      }
      turnAggs.delete(sessionId)
    }
  }

  function handleSessionEvent(sessionId, event) {
    try {
      const type = event && event.type
      const d = event && event.data
      if (!d || typeof d !== 'object') return
      if (type === 'turn/end') {
        finalizeTurn(sessionId)
        return
      }
      if (type !== 'assistant/message') return
      const turn = Number(d.turn)
      const usage = d.usage
      if (!usage || typeof usage !== 'object' || !isFinite(turn)) return
      let agg = turnAggs.get(sessionId)
      if (!agg || agg.turn !== turn) {
        if (agg) finalizeTurn(sessionId)
        agg = { turn, cost: 0, tokens: 0, lastTs: Date.now() }
        turnAggs.set(sessionId, agg)
      }
      const input = Number(usage.inputTokens) || 0
      const cache = Number(usage.cacheReadTokens) || 0
      const output = Number(usage.outputTokens) || 0
      const reasoning = Number(usage.reasoningTokens) || 0
      agg.tokens += input + cache + output + reasoning
      const model = d.message && d.message.source ? d.message.source.model : ''
      const p = priceFor(model)
      const off = isPeakTime(Math.floor(Date.now() / 1000)) ? 1 : 0
      agg.cost += (cache / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + ((output + reasoning) / 1e6) * p.out[off]
      agg.lastTs = Date.now()
    } catch (err) { /* 静默 */ }
  }

  disposers.push(ctx.on('session/event', (session, event) => {
    const sid = session && session.id ? session.id : 'default'
    handleSessionEvent(sid, event)
  }))
  disposers.push(ctx.on('session/disposed', (session) => {
    if (session && session.id) turnAggs.delete(session.id)
  }))

  // ---- 宿主任务事件探测（可选增强；探测失败静默回落，不影响启动） ----
  function probeHostTaskEvents() {
    try {
      if (!ctx.on) return
      const mapStatus = (ev) => (ev === 'taskDone' ? 'done' : ev === 'taskError' ? 'failed' : 'doing')
      for (const ev of ['taskStarted', 'taskProgress', 'taskDone', 'taskError']) {
        try {
          const disposer = ctx.on(ev, (payload) => {
            try {
              const title = String((payload && (payload.title || payload.task || payload.name)) || (ev === 'taskDone' ? '宿主任务完成' : ev === 'taskError' ? '宿主任务失败' : '宿主任务进行中')).slice(0, 80)
              const data = readTasksFile()
              const id = 'h-' + Date.now() + '-' + uuid()
              data.tasks.push({
                id,
                title,
                status: mapStatus(ev),
                date: todayKey(),
                created: Date.now(),
                updated: Date.now(),
                source: 'host',
              })
              writeTasksFile(data)
            } catch (err) { /* 忽略 */ }
          })
          if (disposer) disposers.push(disposer)
        } catch (err) { /* 该事件不存在，跳过 */ }
      }
    } catch (err) { /* 探测失败：静默回落数据源 A */ }
  }
  probeHostTaskEvents()

  // ---- 任务 CRUD ----
  function taskHandlers() {
    const TASK_STATUS = new Set(['todo', 'doing', 'done', 'failed'])
    return {
      list() {
        const data = readTasksFile()
        const stats = taskStats(data.tasks)
        const sorted = [...data.tasks].sort((a, b) => (b.updated || 0) - (a.updated || 0))
        return { ok: true, today: stats.today, trend: stats.trend, tasks: sorted }
      },
      create(title) {
        const clean = String(title || '').trim().slice(0, 80)
        if (!clean) return { ok: false, code: 'EMPTY_TITLE', error: '任务标题不能为空' }
        const data = readTasksFile()
        const task = {
          id: 't-' + Date.now() + '-' + uuid(),
          title: clean,
          status: 'todo',
          date: todayKey(),
          created: Date.now(),
          updated: Date.now(),
          source: 'user',
        }
        data.tasks.push(task)
        writeTasksFile(data)
        return { ok: true, task }
      },
      update(id, status) {
        if (!TASK_STATUS.has(status)) return { ok: false, code: 'BAD_STATUS', error: 'status 必须是 todo/doing/done/failed' }
        const data = readTasksFile()
        const task = data.tasks.find((x) => x.id === id)
        if (!task) return { ok: false, code: 'NOT_FOUND', error: '任务不存在' }
        task.status = status
        task.updated = Date.now()
        writeTasksFile(data)
        return { ok: true, task }
      },
      remove(id) {
        const data = readTasksFile()
        const before = data.tasks.length
        data.tasks = data.tasks.filter((x) => x.id !== id)
        if (data.tasks.length === before) return { ok: false, code: 'NOT_FOUND', error: '任务不存在' }
        writeTasksFile(data)
        return { ok: true }
      },
    }
  }

  // ---- 用户图片 ----
  function loadPackageImage(exprName) {
    if (packageImageBytes.has(exprName)) return packageImageBytes.get(exprName)
    const p = path.join(ASSETS_DIR, exprName)
    try {
      const bytes = fs.readFileSync(p)
      if (bytes && bytes.length > 0) {
        packageImageBytes.set(exprName, bytes)
        return bytes
      }
    } catch (err) { /* fallthrough */ }
    return null
  }

  function loadUserImage(name) {
    const cached = userImageCache.get(name)
    if (cached) return cached.bytes
    try {
      const p = path.join(UPLOAD_DIR, name)
      const bytes = fs.readFileSync(p)
      userImageCache.set(name, { bytes, ts: Date.now() })
      return bytes
    } catch (err) {
      return null
    }
  }

  // 合并配置中 expressions 的所有合法值集合（包内图名 / user-image/ 名）
  function expressionValueSets() {
    const cfg = mergedConfig()
    const expr = cfg.expressions || FALLBACK_CONFIG.expressions
    const packageNames = new Set()
    const userNames = new Set()
    for (const key of Object.keys(expr)) {
      const v = String(expr[key] || '')
      if (v.startsWith('user-image/')) {
        const name = v.slice('user-image/'.length)
        if (/^[a-z0-9-]+\.(png|jpg|jpeg|webp)$/i.test(name)) userNames.add(name)
      } else if (/^[\w.-]+$/.test(v)) {
        packageNames.add(v)
      }
    }
    return { packageNames, userNames }
  }

  // ---- 路由 ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-pet-roxy/widget.js',
    handler: (req, res) => {
      try {
        const js = fs.readFileSync(CLIENT_FILE, 'utf8')
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(js)
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('roxy widget unavailable: ' + String((err && err.message) || err))
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-pet-roxy/image',
    handler: (req, res) => {
      try {
        const name = queryOf(req).get('name') || ''
        const { packageNames } = expressionValueSets()
        if (!name || !packageNames.has(name)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('unknown image')
          return
        }
        const bytes = loadPackageImage(name)
        if (!bytes) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('image unavailable')
          return
        }
        res.writeHead(200, { 'Content-Type': contentTypeFor(name), 'Cache-Control': 'max-age=3600', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('image unavailable')
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-pet-roxy/user-image',
    handler: safeHandler(async (req, res) => {
      const method = req.method || 'GET'
      if (method === 'POST') {
        const body = await readBody(req, 4 * 1024 * 1024)
        let parsed
        try {
          parsed = JSON.parse(body)
        } catch (err) {
          sendOk(res, { ok: false, code: 'BAD_JSON', error: '请求体不是合法 JSON' })
          return
        }
        const cfg = mergedConfig()
        const expr = cfg.expressions || FALLBACK_CONFIG.expressions
        const slot = String(parsed.slot || '')
        if (!Object.prototype.hasOwnProperty.call(expr, slot)) {
          sendOk(res, { ok: false, code: 'BAD_SLOT', error: 'slot 必须为 default/happy/surprised/sleepy/angry 之一' })
          return
        }
        const declaredMime = String(parsed.mime || '')
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(declaredMime)) {
          sendOk(res, { ok: false, code: 'BAD_MIME', error: '仅支持 PNG/JPEG/WebP' })
          return
        }
        let bytes
        try {
          bytes = Buffer.from(String(parsed.data || ''), 'base64')
        } catch (err) {
          bytes = null
        }
        if (!bytes || bytes.length === 0) {
          sendOk(res, { ok: false, code: 'BAD_DATA', error: '图片数据为空或无法解码' })
          return
        }
        if (bytes.length > 2.5 * 1024 * 1024) {
          sendOk(res, { ok: false, code: 'TOO_LARGE', error: '图片超过 2MB 限制' })
          return
        }
        const sniffed = sniffImageMime(bytes)
        if (!sniffed || sniffed !== declaredMime) {
          sendOk(res, { ok: false, code: 'BAD_CONTENT', error: '图片内容与声明的格式不符（魔数校验失败）' })
          return
        }
        // 删除同 slot 旧用户图
        const user = readUserConfig()
        const prevRef = user.expressions && user.expressions[slot]
        if (prevRef && String(prevRef).startsWith('user-image/')) {
          try { fs.rmSync(path.join(UPLOAD_DIR, String(prevRef).slice('user-image/'.length)), { force: true }) } catch (err) { /* ignore */ }
        }
        const fileName = `${slot}-${uuid()}${extForMime(sniffed)}`
        try {
          fs.mkdirSync(UPLOAD_DIR, { recursive: true })
          fs.writeFileSync(path.join(UPLOAD_DIR, fileName), bytes)
        } catch (err) {
          sendOk(res, { ok: false, code: 'WRITE_FAIL', error: '保存图片失败: ' + String((err && err.message) || err).slice(0, 160) })
          return
        }
        user.expressions = user.expressions || {}
        user.expressions[slot] = 'user-image/' + fileName
        writeUserConfig(user)
        userImageCache.set(fileName, { bytes, ts: Date.now() })
        sendOk(res, { ok: true, url: '/dsh-pet-roxy/user-image?name=' + encodeURIComponent(fileName), slot, fileName })
        return
      }
      if (method === 'DELETE') {
        const name = queryOf(req).get('name') || ''
        const { userNames } = expressionValueSets()
        if (!name || !userNames.has(name)) {
          sendOk(res, { ok: false, code: 'NOT_FOUND', error: '不存在该用户图片引用' })
          return
        }
        try { fs.rmSync(path.join(UPLOAD_DIR, name), { force: true }) } catch (err) { /* ignore */ }
        userImageCache.delete(name)
        // 移除用户配置里指向该图的槽位引用（回落到包内默认）
        const user = readUserConfig()
        if (user.expressions) {
          for (const key of Object.keys(user.expressions)) {
            if (user.expressions[key] === 'user-image/' + name) delete user.expressions[key]
          }
          writeUserConfig(user)
        }
        sendOk(res, { ok: true })
        return
      }
      // GET 下发
      const name = queryOf(req).get('name') || ''
      const { userNames } = expressionValueSets()
      if (!name || !userNames.has(name)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('unknown user image')
        return
      }
      const bytes = loadUserImage(name)
      if (!bytes) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('user image unavailable')
        return
      }
      res.writeHead(200, { 'Content-Type': contentTypeFor(name), 'Cache-Control': 'no-store', 'Content-Length': String(bytes.length) })
      res.end(bytes)
    }),
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-pet-roxy/config',
    handler: (req, res) => {
      sendOk(res, { ok: true, config: mergedConfig() })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-pet-roxy/prefs',
    handler: safeHandler(async (req, res) => {
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readBody(req, 256 * 1024)
        let parsed
        try {
          parsed = JSON.parse(body)
        } catch (err) {
          sendOk(res, { ok: false, code: 'BAD_JSON', error: '请求体不是合法 JSON' })
          return
        }
        if (!parsed || typeof parsed !== 'object') {
          sendOk(res, { ok: false, code: 'BAD_BODY', error: '请求体必须是对象' })
          return
        }
        const user = readUserConfig()
        for (const key of ['prefs', 'speech', 'behavior', 'expressions']) {
          if (parsed[key] && typeof parsed[key] === 'object' && !Array.isArray(parsed[key])) {
            user[key] = deepMerge(user[key] || {}, parsed[key])
          }
        }
        // usageMode 变化时清余额缓存
        const newMode = parsed.prefs && parsed.prefs.usageMode
        if (newMode !== undefined) {
          const oldMode = normalizeUsageMode(user.prefs && user.prefs.usageMode)
          if (oldMode !== normalizeUsageMode(newMode)) balanceCache = null
        }
        writeUserConfig(user)
        sendOk(res, { ok: true })
        return
      }
      const cfg = mergedConfig()
      sendOk(res, {
        ok: true,
        prefs: cfg.prefs || {},
        speech: cfg.speech || {},
        behavior: cfg.behavior || {},
        expressions: cfg.expressions || {},
      })
    }),
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-pet-roxy/balance.json',
    handler: safeHandler(async (req, res) => {
      const payload = await getBalance()
      sendOk(res, payload)
    }),
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-pet-roxy/last-turn.json',
    handler: (req, res) => {
      const payload = lastTurn
        ? { ok: true, seq: lastTurnSeq, turn: lastTurn.turn, amount: lastTurn.amount, tokens: lastTurn.tokens, reaction: lastTurn.reaction, ts: lastTurn.ts }
        : { ok: true, seq: 0, turn: null, amount: null, tokens: null, reaction: 'sleepy', ts: null }
      sendOk(res, payload)
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-pet-roxy/tasks',
    handler: safeHandler(async (req, res) => {
      const method = req.method || 'GET'
      const api = taskHandlers()
      if (method === 'POST') {
        const body = await readBody(req, 16 * 1024)
        let parsed
        try {
          parsed = JSON.parse(body)
        } catch (err) {
          sendOk(res, { ok: false, code: 'BAD_JSON', error: '请求体不是合法 JSON' })
          return
        }
        const result = api.create(parsed && parsed.title)
        if (!result.ok) { sendOk(res, result); return }
        sendOk(res, result)
        return
      }
      if (method === 'PATCH' || method === 'DELETE') {
        const id = queryOf(req).get('id') || ''
        if (!id) {
          sendOk(res, { ok: false, code: 'BAD_ID', error: '缺少任务 id' })
          return
        }
        let result
        if (method === 'DELETE') {
          result = api.remove(id)
        } else {
          const body = await readBody(req, 16 * 1024)
          let parsed
          try {
            parsed = JSON.parse(body)
          } catch (err) {
            sendOk(res, { ok: false, code: 'BAD_JSON', error: '请求体不是合法 JSON' })
            return
          }
          result = api.update(id, parsed && parsed.status)
        }
        sendOk(res, result)
        return
      }
      sendOk(res, api.list())
    }),
  }))

  disposers.push(ctx.webServer.tapIndex((html) => {
    if (html.indexOf('/dsh-pet-roxy/widget.js') !== -1) return html
    const tag = '<script defer src="/dsh-pet-roxy/widget.js"></script>'
    if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
    return html + tag
  }))

  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch (err) { /* ignore */ }
    }
  })
}

export { name, inject, apply }
