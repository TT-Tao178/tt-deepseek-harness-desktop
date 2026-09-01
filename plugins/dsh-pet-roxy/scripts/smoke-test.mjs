// ============================================================================
// dsh-pet-roxy 冒烟测试（开发用，不随包发布）
// 用法：node scripts/smoke-test.mjs
// 说明：用 mock ctx 驱动 lib/index.js，在临时 DSH_HOME 下验证全部路由与逻辑，
//       不依赖真实 DSH、不发真实网络请求。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 隔离 DSH_HOME（必须在动态 import 之前设置，模块顶部常量读取它）
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'roxy-smoke-'))
process.env.DSH_HOME = tmpHome

const { name, inject, apply } = await import('../lib/index.js')

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + label) }
  else { fail++; console.log('  ✘ ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

// ---- mock ctx ----
const routes = new Map()
const tapFns = []
const listeners = new Map()
const disposers = []
const ctx = {
  webServer: {
    register({ kind, path: p, handler }) {
      routes.set(p, handler)
      return () => routes.delete(p)
    },
    tapIndex(fn) { tapFns.push(fn); return () => {} },
  },
  credentials: {
    async resolve() { return null }, // 无凭据 → NO_KEY（避免真实网络）
  },
  on(ev, cb) {
    if (!listeners.has(ev)) listeners.set(ev, [])
    listeners.get(ev).push(cb)
    return () => {}
  },
  effect(fn) { disposers.push(fn) },
}

apply(ctx)

// ---- 请求模拟 ----
function makeReq(method, url, bodyString) {
  const evs = { data: [], end: [], error: [] }
  const r = {
    method,
    url,
    on(ev, cb) { (evs[ev] || (evs[ev] = [])).push(cb); return r },
    destroy() {},
  }
  setTimeout(() => {
    if (bodyString != null) for (const cb of evs.data) cb(Buffer.from(bodyString))
    for (const cb of evs.end) cb()
  }, 0)
  return r
}
function makeRes() {
  const out = { status: 0, headers: {}, body: null }
  return {
    writeHead(s, h) { out.status = s; Object.assign(out.headers, h || {}) },
    end(chunk) { out.body = chunk },
    json() { if (typeof out.body === 'string') { try { return JSON.parse(out.body) } catch (e) { return out.body } } return out.body },
    get status() { return out.status },
    get headers() { return out.headers },
    get body() { return out.body },
  }
}
async function call(method, url, bodyString) {
  const handler = routes.get(url.split('?')[0])
  if (!handler) throw new Error('route not found: ' + url)
  const res = makeRes()
  await handler(makeReq(method, url, bodyString), res)
  return res
}

console.log('== 插件契约 ==')
check('name = dsh-pet-roxy', name === 'dsh-pet-roxy', name)
check('inject = [webServer, credentials]', JSON.stringify(inject) === JSON.stringify(['webServer', 'credentials']), inject)

console.log('== 配置 ==')
const cfgRes = await call('GET', '/dsh-pet-roxy/config')
check('GET /config ok', cfgRes.json().ok === true)
check('config 含 expressions', !!cfgRes.json().config && !!cfgRes.json().config.expressions && cfgRes.json().config.expressions.happy === 'roxy1.png')
check('config 含 prefs.scale=1.0', cfgRes.json().config.prefs.scale === 1.0)
check('config 含台词组', Array.isArray(cfgRes.json().config.lines) && cfgRes.json().config.lines.length >= 4)

console.log('== 任务看板 ==')
const t1 = await call('POST', '/dsh-pet-roxy/tasks', JSON.stringify({ title: '写周报' }))
check('POST /tasks 新增', t1.json().ok === true && t1.json().task.status === 'todo')
const taskId = t1.json().task.id
const t2 = await call('GET', '/dsh-pet-roxy/tasks')
check('GET /tasks 统计 today.total=1', t2.json().ok === true && t2.json().today.total === 1, t2.json().today)
const t3 = await call('PATCH', '/dsh-pet-roxy/tasks?id=' + taskId, JSON.stringify({ status: 'done' }))
check('PATCH 状态 done', t3.json().ok === true && t3.json().task.status === 'done')
const t4 = await call('GET', '/dsh-pet-roxy/tasks')
check('统计 today.done=1', t4.json().today.done === 1, t4.json().today)
check('趋势 trend 含今天', Array.isArray(t4.json().trend) && t4.json().trend.length === 7 && t4.json().trend[6].done === 1)
const t5 = await call('POST', '/dsh-pet-roxy/tasks', JSON.stringify({ title: '   ' }))
check('空标题被拒', t5.json().ok === false)
const t6 = await call('PATCH', '/dsh-pet-roxy/tasks?id=bad-id', JSON.stringify({ status: 'done' }))
check('不存在的任务 404 语义', t6.json().ok === false && t6.json().code === 'NOT_FOUND')
const t7 = await call('PATCH', '/dsh-pet-roxy/tasks?id=' + taskId, JSON.stringify({ status: 'oops' }))
check('非法状态被拒', t7.json().ok === false)
const t8 = await call('DELETE', '/dsh-pet-roxy/tasks?id=' + taskId)
check('DELETE 删除', t8.json().ok === true)
const t9 = await call('GET', '/dsh-pet-roxy/tasks')
check('删除后 today.total=0', t9.json().today.total === 0)

console.log('== 用户图片上传 ==')
// 1x1 透明 PNG
const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const u1 = await call('POST', '/dsh-pet-roxy/user-image', JSON.stringify({ slot: 'happy', mime: 'image/png', data: PNG1 }))
check('POST 上传成功', u1.json().ok === true && u1.json().slot === 'happy', u1.json())
const upName = u1.json().fileName
const u2 = await call('GET', '/dsh-pet-roxy/user-image?name=' + encodeURIComponent(upName))
check('GET 下发用户图 200 + PNG', u2.status === 200 && (u2.headers['Content-Type'] || '').indexOf('image/png') !== -1)
const u3 = await call('GET', '/dsh-pet-roxy/config')
check('配置中 happy 指向用户图', u3.json().config.expressions.happy === 'user-image/' + upName)
const u4 = await call('POST', '/dsh-pet-roxy/user-image', JSON.stringify({ slot: 'happy', mime: 'image/png', data: 'not-really-base64!!' }))
check('伪造内容被拒', u4.json().ok === false && u4.json().code === 'BAD_CONTENT')
const u5 = await call('POST', '/dsh-pet-roxy/user-image', JSON.stringify({ slot: 'happy', mime: 'image/svg+xml', data: PNG1 }))
check('SVG 被拒', u5.json().ok === false && u5.json().code === 'BAD_MIME')
const u6 = await call('POST', '/dsh-pet-roxy/user-image', JSON.stringify({ slot: 'nope', mime: 'image/png', data: PNG1 }))
check('非法槽位被拒', u6.json().ok === false && u6.json().code === 'BAD_SLOT')
const u7 = await call('GET', '/dsh-pet-roxy/user-image?name=..%2F..%2Fetc%2Fpasswd')
check('路径穿越被拒 404', u7.status === 404)
const u8 = await call('DELETE', '/dsh-pet-roxy/user-image?name=' + encodeURIComponent(upName))
check('DELETE 删除用户图', u8.json().ok === true)
const u9 = await call('GET', '/dsh-pet-roxy/config')
check('删除后回落默认图', u9.json().config.expressions.happy === 'roxy1.png')

console.log('== 预置偏好 ==')
const p1 = await call('PUT', '/dsh-pet-roxy/prefs', JSON.stringify({ prefs: { scale: 1.4, turnCostCloseMs: 8000 } }))
check('PUT prefs ok', p1.json().ok === true)
const p2 = await call('GET', '/dsh-pet-roxy/config')
check('prefs 深合并生效 scale=1.4', p2.json().config.prefs.scale === 1.4 && p2.json().config.prefs.marginX === 16)
const p3 = await call('PUT', '/dsh-pet-roxy/prefs', JSON.stringify({ speech: { customLines: [{ group: 'custom', weight: 10, items: ['自定义测试台词'] }] } }))
check('PUT speech ok', p3.json().ok === true)
const p4 = await call('GET', '/dsh-pet-roxy/config')
check('customLines 合并生效', Array.isArray(p4.json().config.speech.customLines) && p4.json().config.speech.customLines.length === 1)

console.log('== 余额（无凭据） ==')
const b1 = await call('GET', '/dsh-pet-roxy/balance.json')
check('balance NO_KEY 且 200', b1.status === 200 && b1.json().ok === false && b1.json().code === 'NO_KEY', b1.json())

console.log('== 每轮消耗（模拟会话事件） ==')
const emit = (ev, data) => {
  const cbs = listeners.get('session/event') || []
  for (const cb of cbs) cb({ id: 's1' }, { type: ev, data })
}
emit('assistant/message', { turn: 1, usage: { inputTokens: 1000000, cacheReadTokens: 0, outputTokens: 500000, reasoningTokens: 0 }, message: { source: { model: 'deepseek-v4-flash' } } })
emit('turn/end', {})
const l1 = await call('GET', '/dsh-pet-roxy/last-turn.json')
const lj = l1.json()
check('last-turn seq=1', lj.ok === true && lj.seq === 1, lj)
// 谷价：输入 1.5/1e6 *1e6 = 1.5；输出 4.5/1e6*0.5e6 = 2.25；合计 3.75 → happy（0.01~5，新规则：≥5 才 surprised）
check('消耗金额≈3.75', Math.abs(lj.amount - 3.75) < 0.01, lj.amount)
check('reaction=happy', lj.reaction === 'happy', lj.reaction)

console.log('== tapIndex 注入 ==')
const html = tapFns[0]('<html><head></head><body><div>page</div></body></html>')
check('注入 widget.js 且幂等', html.indexOf('/dsh-pet-roxy/widget.js') !== -1 && html.indexOf('/dsh-pet-roxy/widget.js') === html.lastIndexOf('/dsh-pet-roxy/widget.js'))
const html2 = tapFns[0]('<html><body><script src="/dsh-pet-roxy/widget.js"></script></body></html>')
check('已存在时不重复注入', html2.indexOf('/dsh-pet-roxy/widget.js') === html2.lastIndexOf('/dsh-pet-roxy/widget.js'))

console.log('== widget.js 路由 ==')
const w1 = await call('GET', '/dsh-pet-roxy/widget.js')
check('widget.js 200 且含 __dshPetRoxy', w1.status === 200 && String(w1.body).indexOf('__dshPetRoxy') !== -1)

console.log('== 会话清理 ==')
const disp = listeners.get('session/disposed') || []
for (const cb of disp) cb({ id: 's1' })
check('ctx.effect 注册了清理', disposers.length >= 1)
for (const fn of disposers) { try { fn() } catch (e) {} }

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
fs.rmSync(tmpHome, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
