import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync, watch, readdirSync } from 'node:fs'
import { resolve, join, extname, normalize, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3000)
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.ico': 'image/x-icon',
}

/* ---------- live preview (SSE) ---------- */
const liveClients = new Set()
let liveTimer = null
const notifyLive = () => { clearTimeout(liveTimer); liveTimer = setTimeout(() => { for (const c of liveClients) c.write('event: change\ndata: changed\n\n') }, 250) }
const ignoredWatch = new Set(['.git', 'node_modules', '.opencode', '.agents', 'screenshots'])
try {
  const watchDir = dir => {
    try {
      watch(dir, () => notifyLive())
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && !ignoredWatch.has(e.name) && !e.name.startsWith('.')) watchDir(join(dir, e.name))
      }
    } catch {}
  }
  watchDir(ROOT)
} catch {}
const LIVE_SCRIPT = `<script data-omgithub-live-preview>(()=>{const es=new EventSource('/__omgithub/live');es.addEventListener('change',()=>{if(window.parent!==window)window.parent.postMessage({type:'omgithub:live-change'},'*');else location.reload()});window.addEventListener('pagehide',()=>es.close(),{once:true})})()</script>`

/* ---------- game rooms (2-phone multiplayer) ---------- */
const rooms = new Map() // code -> { id, created, lastActive, players: Map<pid,{name,role}>, seq, log: [{seq,from,type,data}] }
const ROOM_TTL = 30 * 60 * 1000
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const newCode = () => { for (let i = 0; i < 5; i++) { let c = ''; for (let j = 0; j < 4; j++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; if (!rooms.has(c)) return c } return 'R' + Date.now().toString(36).toUpperCase().slice(-4) }
let pidSeq = 0
const roomJSON = r => ({ ...r, players: [...r.players.values()], log: undefined })
const touch = r => { r.lastActive = Date.now() }
setInterval(() => { const now = Date.now(); for (const [c, r] of rooms) if (now - r.lastActive > ROOM_TTL) rooms.delete(c) }, 60000)

const waiters = new Map() // code -> [resolvers]

function roomResponse(res, code, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(obj))
}
function readBody(req) {
  return new Promise((ok, fail) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) { fail(new Error('too big')); req.destroy() } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}) } catch { ok({}) } }); req.on('error', fail)
  })
}
async function handleRoomAPI(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean) // api, room, ...
  // POST /api/room  {name}
  if (parts[1] === 'room' && parts.length === 2 && req.method === 'POST') {
    const body = await readBody(req)
    const code = newCode()
    const pid = ++pidSeq
    const r = { code, created: Date.now(), lastActive: Date.now(), started: false, hostPid: pid, seq: 0, log: [], players: new Map() }
    r.players.set(pid, { pid, name: (body.name || 'Player1').slice(0, 16), role: 'host', joined: Date.now() })
    rooms.set(code, r)
    touch(r)
    return roomResponse(res, code, 200, { code, pid, role: 'host' })
  }
  if (parts[1] === 'room' && parts[2] && parts[3] === 'join' && req.method === 'POST') {
    const r = rooms.get(parts[2].toUpperCase())
    if (!r) return roomResponse(res, code, 404, { error: 'room not found' })
    const body = await readBody(req)
    const pid = ++pidSeq
    const existing = [...r.players.values()].find(p => p.role === 'guest' && !p.left)
    if (existing) return roomResponse(res, r.code, 409, { error: 'room full', pid: existing.pid })
    r.players.set(pid, { pid, name: (body.name || 'Player2').slice(0, 16), role: 'guest', joined: Date.now() })
    touch(r)
    pushMsg(r, 0, 'system', { kind: 'joined', pid, name: r.players.get(pid).name })
    return roomResponse(res, r.code, 200, { code: r.code, pid, role: 'guest' })
  }
  if (parts[1] === 'room' && parts[2] && parts[3] === 'msg' && req.method === 'POST') {
    const r = rooms.get(parts[2].toUpperCase())
    if (!r) return roomResponse(res, code, 404, { error: 'room not found' })
    const body = await readBody(req)
    const m = pushMsg(r, body.from | 0, body.type || 'data', body.data)
    touch(r)
    return roomResponse(res, r.code, 200, { seq: m.seq })
  }
  if (parts[1] === 'room' && parts[2] && parts[3] === 'msg' && req.method === 'GET') {
    const r = rooms.get(parts[2].toUpperCase())
    if (!r) return roomResponse(res, code, 404, { error: 'room not found' })
    touch(r)
    const since = Number(url.searchParams.get('since') || 0)
    const wait = Math.min(25, Number(url.searchParams.get('wait') || 0))
    const mine = r.log.filter(m => m.seq > since)
    if (mine.length || !wait) return roomResponse(res, r.code, 200, { seq: r.seq, msgs: mine, players: [...r.players.values()], started: r.started })
    // long-poll: hold up to wait seconds
    const timer = setTimeout(() => { finish([]) }, wait * 1000)
    const finish = msgs => {
      clearTimeout(timer)
      const set = waiters.get(r.code); if (set) { const i = set.indexOf(onMsg); if (i >= 0) set.splice(i, 1) }
      roomResponse(res, r.code, 200, { seq: r.seq, msgs, players: [...r.players.values()], started: r.started })
    }
    const onMsg = msgs => finish(msgs)
    if (!waiters.has(r.code)) waiters.set(r.code, [])
    waiters.get(r.code).push(onMsg)
    req.on('close', () => { clearTimeout(timer); const set = waiters.get(r.code); if (set) { const i = set.indexOf(onMsg); if (i >= 0) set.splice(i, 1) } })
    return undefined
  }
  if (parts[1] === 'room' && parts[2] && parts[3] === 'state' && req.method === 'POST') {
    const r = rooms.get(parts[2].toUpperCase())
    if (!r) return roomResponse(res, code, 404, { error: 'room not found' })
    const body = await readBody(req)
    if (body.started !== undefined) r.started = !!body.started
    touch(r)
    return roomResponse(res, r.code, 200, { ok: true })
  }
  return roomResponse(res, code, 404, { error: 'unknown api' })
}
function pushMsg(r, from, type, data) {
  const m = { seq: ++r.seq, from, type, data, t: Date.now() }
  r.log.push(m)
  if (r.log.length > 600) r.log.splice(0, r.log.length - 600)
  const set = waiters.get(r.code)
  if (set && set.length) { const waiting = [...set]; waiters.set(r.code, []); for (const f of waiting) f([m]) }
  return m
}

/* ---------- server ---------- */
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/__omgithub/live') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' })
      res.write(': connected\n\n')
      liveClients.add(res)
      req.on('close', () => liveClients.delete(res))
      return
    }
    if (url.pathname.startsWith('/api/')) return await handleRoomAPI(req, res, url)
    const path = resolve(ROOT, '.' + decodeURIComponent(url.pathname))
    if (path !== ROOT && !path.startsWith(ROOT + '/')) { res.writeHead(404); res.end(); return }
    let file = path
    if (existsSync(path) && statSync(path).isDirectory()) file = join(path, 'index.html')
    if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return }
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream')
    res.setHeader('Cache-Control', url.searchParams.has('omgithub_live') ? 'no-store' : 'no-cache')
    const content = readFileSync(file)
    if (extname(file) === '.html' && url.searchParams.get('omgithub_live') === '1') {
      const html = content.toString()
      res.end(/<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, LIVE_SCRIPT + '</body>') : html + LIVE_SCRIPT)
    } else res.end(content)
  } catch (e) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(String(e && e.message)) }
})

if (process.env.OPENCODE_WEB_DIR) {
  try {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(process.env.OPENCODE_WEB_DIR, { recursive: true })
    writeFileSync(join(process.env.OPENCODE_WEB_DIR, 'deployment-output.json'), JSON.stringify({ project: ROOT, directory: ROOT }))
  } catch {}
}

server.listen(PORT, '0.0.0.0', () => console.log(`Mini Royale server on http://0.0.0.0:${PORT}`))
