// Room transport: HTTP long-poll relay that works through any proxy (2 phones, one room).
const BASE = ''
const jfetch = async (url, body, method = 'POST') => {
  const opts = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const r = await fetch(BASE + url, opts)
  if (!r.ok) throw new Error('http ' + r.status)
  return r.json()
}

export class Room {
  constructor() {
    this.code = null
    this.pid = null
    this.role = null
    this.name = ''
    this.handlers = new Map()      // type -> fn(data, from)
    this.anyHandler = null
    this.onStatus = null           // fn(text, ok)
    this.outbox = []               // pending messages
    this.seq = 0
    this.running = false
    this.lastPing = 0
    this.pingMs = 0
    this.started = false
    this.players = []
    this.failStreak = 0
  }
  on(type, fn) { this.handlers.set(type, fn); return this }
  emit(type, data, from = this.pid) {
    const fn = this.handlers.get(type)
    if (fn) fn(data, from)
    if (this.anyHandler) this.anyHandler(type, data, from)
  }
  async create(name) {
    const r = await jfetch('/api/room', { name })
    this.code = r.code; this.pid = r.pid; this.role = r.role; this.name = name
    this.start()
    return r
  }
  async join(code, name) {
    const r = await jfetch(`/api/room/${encodeURIComponent(code.trim().toUpperCase())}/join`, { name })
    this.code = r.code; this.pid = r.pid; this.role = r.role; this.name = name
    this.start()
    return r
  }
  send(type, data) {
    if (!this.code) return
    this.outbox.push({ from: this.pid, type, data })
  }
  sendNow(type, data) {
    if (!this.code) return
    jfetch(`/api/room/${this.code}/msg`, { from: this.pid, type, data }).catch(() => {})
  }
  async flush() {
    if (!this.outbox.length || !this.code) return
    const batch = this.outbox.splice(0, this.outbox.length)
    // only the last input of a kind matters — compress
    const kept = []
    for (const m of batch) {
      const i = kept.findIndex(k => k.type === m.type && m.type === 'input')
      if (i >= 0) kept[i] = m; else kept.push(m)
    }
    try {
      for (const m of kept) await jfetch(`/api/room/${this.code}/msg`, m)
      this.failStreak = 0
    } catch (e) {
      this.failStreak++
      this.outbox.unshift(...batch)
      if (this.failStreak > 3) this.onStatus && this.onStatus('⚠️ connection lost, retrying…', false)
    }
  }
  async pollLoop() {
    while (this.running) {
      try {
        const t0 = performance.now()
        const r = await jfetch(`/api/room/${this.code}/msg?since=${this.seq}&wait=20`, undefined, 'GET')
        this.pingMs = Math.round(performance.now() - t0)
        this.seq = r.seq
        this.players = r.players || []
        this.started = !!r.started
        if (this.failStreak > 0) { this.onStatus && this.onStatus('✓ reconnected', true); this.emit('resync', {}) }
        this.failStreak = 0
        for (const m of r.msgs || []) this.emit(m.type, m.data, m.from)
      } catch (e) {
        this.failStreak++
        if (this.failStreak > 3) this.onStatus && this.onStatus('⚠️ connection lost, retrying…', false)
        await new Promise(ok => setTimeout(ok, 1200))
      }
      await new Promise(ok => setTimeout(ok, 30))
    }
  }
  async flushLoop() {
    while (this.running) {
      await this.flush()
      await new Promise(ok => setTimeout(ok, 55))
    }
  }
  start() {
    if (this.running) return
    this.running = true
    this.pollLoop()
    this.flushLoop()
  }
  stop() { this.running = false }
  joinUrl() {
    const u = new URL(location.href)
    u.searchParams.set('room', this.code)
    return u.toString()
  }
}
export const autoRoomParams = () => new URLSearchParams(location.search)
