// Authoritative simulation (host) + prediction support (guest). No THREE dependency.
import {
  WEAPONS, TIERS, MATS, MAT_KEYS, BUILD, RECIPES, STORM, HARVEST,
  PICKAXE_DMG, MELEE_RANGE, GRID, PLAY_R, GRAV, DROP_ALTITUDE, GLIDER_ALT,
  BOT_NAMES, BOT_COLORS, rarityRoll,
} from './config.js'
import { heightAt, generateWorldData, mulberry32 } from './world.js'

const snapAngle = a => Math.round(a / (Math.PI / 2)) * (Math.PI / 2)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

function boxPush(px, pz, cx, cz, hw, hd, yaw, r) {
  const c = Math.cos(yaw), s = Math.sin(yaw)
  const dx = px - cx, dz = pz - cz
  const lx = dx * c + dz * s, lz = -dx * s + dz * c
  const qx = clamp(lx, -hw, hw), qz = clamp(lz, -hd, hd)
  const ex = lx - qx, ez = lz - qz
  const d2 = ex * ex + ez * ez
  if (d2 >= r * r) return null
  let nx, nz, push
  if (d2 > 1e-9) { const d = Math.sqrt(d2); nx = ex / d; nz = ez / d; push = r - d }
  else {
    const ox = hw - Math.abs(lx) + r, oz = hd - Math.abs(lz) + r
    if (ox < oz) { nx = lx >= 0 ? 1 : -1; nz = 0; push = ox }
    else { nx = 0; nz = lz >= 0 ? 1 : -1; push = oz }
  }
  const wx = nx * c - nz * s, wz = nx * s + nz * c
  return [px + wx * push, pz + wz * push]
}

export class Sim {
  constructor(mode, hooks, seed = 1337) {
    this.mode = mode            // 'host' | 'guest'
    this.hooks = hooks
    this.seed = seed
    this.data = generateWorldData(seed)
    this.rnd = mulberry32(seed ^ 0x9e37)
    this.players = []
    this.walls = []
    this.loots = []
    this.chests = []
    this.props = this.data.props
    this.propMap = new Map(this.props.map(p => [p.id, p]))
    this.byId = new Map()
    this.storm = { cx: 0, cz: 0, r: PLAY_R + 6, tx: 0, tz: 0, tr: PLAY_R, phase: 0, mode: 'wait', timer: STORM.firstDelay, t: 0 }
    this.events = []
    this.tickN = 0
    this.running = false
    this.winner = null
    this.myPid = null           // guest: own pid; host: own pid
    this.localInputs = new Map()
    this.wallSeq = 1
    this.lootSeq = 1
    this.gravityScale = 1
    for (const c of this.data.chests) this.chests.push({ id: c.id, x: c.x, z: c.z, open: false })
  }

  /* ---------------- match setup ---------------- */
  startMatch(defs) {
    // defs: [{id, name, color, bot, role}]
    this.players = defs.map((d, i) => {
      const a = (i / defs.length) * Math.PI * 2 + this.rnd()
      const dist = 120 + this.rnd() * 170
      return {
        id: d.id, name: d.name, color: d.color, bot: !!d.bot, role: d.role || null,
        x: Math.cos(a) * dist, y: DROP_ALTITUDE + this.rnd() * 8, z: Math.sin(a) * dist,
        vx: 0, vy: -6, yaw: a + Math.PI, camYaw: a + Math.PI, camPitch: 0.55,
        hp: 100, shield: 0, alive: true, state: 'drop', gliding: false,
        weapon: 'ar', tier: 0, mats: { wood: 40, brick: 20, metal: 10 },
        kills: 0, hop: 0, craft: null, moving: false, aiming: false, animT: this.rnd() * 9,
        piece: 'wall', mat: 'wood', ai: { t: this.rnd(), tx: 0, tz: 0, strafe: 1, react: 0, land: null },
        prevFire: false, prevJump: false, prevSwing: false, prevPlace: false,
        render: { x: 0, y: 0, z: 0, init: false },
        pred: { x: 0, y: 0, z: 0, vy: 0, init: false },
      }
    })
    for (const p of this.players) { p.render.x = p.x; p.render.y = p.y; p.render.z = p.z; p.pred.x = p.x; p.pred.y = p.y; p.pred.z = p.z; p.pred.vy = p.vy; p.pred.init = true; if (p.bot) { p.ai.land = { x: (this.rnd() - 0.5) * 450, z: (this.rnd() - 0.5) * 450 } } }
    // initial floor loot
    for (const s of this.data.lootSpots) this.addLoot(this.rollLoot(s.x, s.z, 1))
    for (const s of this.data.hopSpots) this.addLoot({ kind: 'hop', x: s.x, z: s.z })
    this.running = true
    this.winner = null
    this.storm = { cx: 0, cz: 0, r: PLAY_R + 6, tx: 0, tz: 0, tr: PLAY_R, phase: 0, mode: 'wait', timer: STORM.firstDelay, t: 0 }
  }
  rollLoot(x, z, luck) {
    const r = this.rnd()
    if (r < 0.62) {
      const keys = Object.keys(WEAPONS)
      const w = keys[Math.floor(this.rnd() * keys.length)]
      return { kind: 'weapon', wt: w, tier: rarityRoll(luck), x, z }
    }
    if (r < 0.82) return { kind: 'shield', x, z }
    if (r < 0.95) return { kind: 'med', x, z }
    return { kind: 'weapon', wt: 'smg', tier: 0, x, z }
  }
  addLoot(l) { l.id = this.lootSeq++; this.loots.push(l); this.emitView('lootAdd', l); return l }

  /* ---------------- events ---------------- */
  ev(type, data) { this.events.push([type, data]) }
  emitView(name, ...args) { if (this.hooks[name]) this.hooks[name](...args) }
  setLocalInput(pid, input) { this.localInputs.set(pid, input) }
  player(pid) { return this.players.find(p => p.id === pid) }

  /* ---------------- ground & collision ---------------- */
  groundHeight(x, z, feetY) {
    let h = heightAt(x, z)
    for (const f of this.walls) {
      if (f.type !== 'floor') continue
      if (Math.abs(x - f.x) <= 2 && Math.abs(z - f.z) <= 2) {
        const top = f.base + 0.24
        if (top > h && top <= feetY + 0.7) h = top
      }
      if (f.type === 'ramp') {
        const dx = x - f.x, dz = z - f.z
        const c = Math.cos(-f.yaw), s = Math.sin(-f.yaw)
        const lx = dx * c - dz * s, lz = dx * s + dz * c
        if (Math.abs(lx) <= 2 && Math.abs(lz) <= 2) {
          const t = clamp((lz + 2) / 4, 0, 1)
          const top = f.base + t * 3.2
          if (top > h && top <= feetY + 0.9) h = top
        }
      }
    }
    return h
  }
  collide(p) {
    const r = 0.62
    const d = Math.hypot(p.x, p.z)
    if (d > PLAY_R + 12) { p.x *= (PLAY_R + 12) / d; p.z *= (PLAY_R + 12) / d }
    for (const c of this.data.circles) {
      if (c.r <= 0.001) continue
      if (c.propId) { const pr = this.propMap.get(c.propId); if (pr && pr.hp <= 0) continue }
      const dx = p.x - c.x, dz = p.z - c.z
      const rr = c.r + r, d2 = dx * dx + dz * dz
      if (d2 < rr * rr && d2 > 1e-9) { const l = Math.sqrt(d2); p.x = c.x + dx / l * rr; p.z = c.z + dz / l * rr }
    }
    for (const b of this.data.boxes) {
      const res = boxPush(p.x, p.z, b.x, b.z, b.hw, b.hd, b.yaw, r)
      if (res) { p.x = res[0]; p.z = res[1] }
    }
    for (const w of this.walls) {
      if (w.type === 'ramp') continue
      if (w.type === 'wall') {
        const yawN = Math.abs(Math.sin(w.yaw)) > 0.5
        const hw = yawN ? 0.2 : 2, hd = yawN ? 2 : 0.2
        const top = w.base + 3.2
        if (p.y + 2.1 < w.base || p.y > top) continue
        const res = boxPush(p.x, p.z, w.x, w.z, hw, hd, 0, r)
        if (res) { p.x = res[0]; p.z = res[1] }
      } else if (w.type === 'floor') {
        const top = w.base + 0.24
        if (p.y + 2.0 < w.base || p.y > top - 0.1) continue
        const res = boxPush(p.x, p.z, w.x, w.z, 2, 2, 0, r)
        if (res) { p.x = res[0]; p.z = res[1] }
      }
    }
  }

  /* ---------------- host tick ---------------- */
  step(dt) {
    if (!this.running || this.mode !== 'host') return
    this.tickN++
    // inputs
    for (const p of this.players) {
      let input
      if (p.bot) input = this.botInput(p, dt)
      else input = this.localInputs.get(p.id) || { mv: [0, 0], yaw: p.camYaw, pitch: p.camPitch, fire: false, jump: false, swing: false, place: false, craft: null }
      this.stepPlayer(p, input, dt)
      p.prevFire = input.fire; p.prevJump = input.jump; p.prevSwing = input.swing; p.prevPlace = input.place
      p.craftInput = null
    }
    this.stepStorm(dt)
    this.checkWin()
  }

  stepPlayer(p, input, dt) {
    if (!p.alive) return
    p.camYaw = input.yaw ?? p.camYaw
    p.camPitch = input.pitch ?? p.camPitch
    p.piece = input.piece || p.piece
    p.mat = input.mat || p.mat

    if (p.state === 'drop') { this.stepDrop(p, input, dt); return }

    // crafting timer
    if (p.craft) {
      p.craft.remain -= dt
      if (p.craft.remain <= 0) {
        const rec = RECIPES.find(r => r.id === p.craft.id)
        this.applyGives(p, rec)
        this.ev('craft', { p: p.id, id: rec.id, name: rec.name, icon: rec.icon })
        p.craft = null
      }
    }
    if (input.craft && !p.craft) this.tryCraft(p, input.craft)

    // movement
    const [mx, mz] = input.mv || [0, 0]
    const len = Math.hypot(mx, mz)
    const hopBoost = p.hop > 0 ? 1.12 : 1
    let moving = false
    if (len > 0.14) {
      const cl = Math.min(len, 1) / (len || 1)
      const sy = Math.sin(p.camYaw), cy = Math.cos(p.camYaw)
      const wx = (mx * cy + mz * sy) * cl
      const wz = (-mx * sy + mz * cy) * cl
      const spd = 7.6 * hopBoost
      p.x += wx * spd * dt
      p.z += wz * spd * dt
      p.yaw = Math.atan2(wx, wz)
      moving = true
    }
    p.moving = moving
    p.aiming = !!input.fire

    // gravity / jump
    const g = GRAV * (p.hop > 0 ? 0.42 : 1)
    const ground = this.groundHeight(p.x, p.z, p.y)
    const onGround = p.y <= ground + 0.06
    if (input.jump && !p.prevJump && onGround) { p.vy = p.hop > 0 ? 13.4 : 9.4 }
    p.vy -= g * dt
    p.y += p.vy * dt
    if (p.y <= ground) { p.y = ground; p.vy = 0 } else if (p.vy < 0 && p.y - p.vy * dt <= ground + 0.05 && p.y <= ground + 0.4) { p.y = ground; p.vy = 0 }
    this.collide(p)

    if (p.hop > 0) p.hop = Math.max(0, p.hop - dt)

    // fire / swing / place
    const w = WEAPONS[p.weapon]
    p.cd = (p.cd || 0) - dt
    const wantFire = input.fire && (w.auto || !p.prevFire)
    if (wantFire && p.cd <= 0) this.shoot(p)
    const swingWant = input.swing && (this.rnd() < 1 || true)
    p.swingCd = (p.swingCd || 0) - dt
    if (input.swing && p.swingCd <= 0) { this.swing(p); p.swingCd = 0.52 }
    if (input.place && !p.prevPlace) this.placePiece(p)

    // pickups
    this.checkPickups(p)
  }

  stepDrop(p, input, dt) {
    const ground = heightAt(p.x, p.z)
    const [mx, mz] = input.mv || [0, 0]
    const len = Math.hypot(mx, mz)
    if (!p.gliding && p.y <= GLIDER_ALT) { p.gliding = true; this.ev('glide', { p: p.id }) }
    if (p.bot && p.ai.land) {
      // steer toward landing spot
      const dx = p.ai.land.x - p.x, dz = p.ai.land.z - p.z
      const d = Math.hypot(dx, dz)
      if (d > 1) { this.botMove(p, dx / d, dz / d, dt, p.gliding ? 20 : 17); p.yaw = Math.atan2(dx, dz); p.camYaw = p.yaw }
    } else if (len > 0.12) {
      const cl = Math.min(1, len)
      const spd = p.gliding ? 17 : 14
      const sy = Math.sin(p.camYaw), cy = Math.cos(p.camYaw)
      const wx = (mx * cy + mz * sy) / len * cl
      const wz = (-mx * sy + mz * cy) / len * cl
      p.x += wx * spd * dt
      p.z += wz * spd * dt
      p.yaw = Math.atan2(wx, wz)
      p.moving = true
    }
    const targetVy = p.gliding ? -9.5 : -44
    p.vy += (targetVy - p.vy) * Math.min(1, dt * 2.4)
    p.y += p.vy * dt
    const d = Math.hypot(p.x, p.z)
    if (d > PLAY_R + 6) { p.x *= (PLAY_R + 6) / d; p.z *= (PLAY_R + 6) / d }
    if (p.y <= ground + 0.02) {
      p.y = ground; p.vy = 0; p.state = 'play'; p.gliding = false
      this.ev('land', { p: p.id, x: p.x, z: p.z })
    }
  }

  /* ---------------- combat ---------------- */
  shoot(p) {
    const w = WEAPONS[p.weapon]
    const tier = TIERS[p.tier]
    p.cd = w.cd
    const sy = Math.sin(p.camYaw), cy = Math.cos(p.camYaw)
    const cp = Math.cos(p.camPitch), sp = Math.sin(p.camPitch)
    const ox = p.x + sy * 0.9, oy = p.y + 1.55, oz = p.z + cy * 0.9
    for (let i = 0; i < w.pellets; i++) {
      const spread = w.spread
      const yaw = p.camYaw + (this.rnd() - 0.5) * spread * 3.4
      const pitch = p.camPitch + (this.rnd() - 0.5) * spread * 2.4
      const dyaw = yaw - p.camYaw
      const dir = [
        Math.sin(yaw) * Math.cos(pitch),
        -Math.sin(pitch) + 0.012,
        Math.cos(yaw) * Math.cos(pitch),
      ]
      const hit = this.hooks.raycast([ox, oy, oz], dir, w.range, p.id)
      const end = hit ? hit.point : [ox + dir[0] * w.range, oy + dir[1] * w.range, oz + dir[2] * w.range]
      this.ev('shot', { from: p.id, w: p.weapon, tier: p.tier, o: [ox, oy, oz], e: end })
      this.emitView('fxShot', p, [ox, oy, oz], end, w)
      if (!hit) continue
      const dmg = w.dmg * tier.mult * (hit.kind === 'head' ? 1.6 : 1) * (0.94 + this.rnd() * 0.12)
      if (hit.kind === 'player' || hit.kind === 'head') {
        const v = this.player(hit.pid)
        if (v && v.alive && v !== p) this.damage(v, dmg, p, hit.kind === 'head', hit.point)
      } else if (hit.kind === 'prop') {
        this.hurtProp(hit.ref, dmg * 0.8, p)
      } else if (hit.kind === 'wall') {
        hit.ref.hp -= dmg
        this.emitView('wallHurt', hit.ref)
        if (hit.ref.hp <= 0) this.removeWall(hit.ref, true)
      } else if (hit.kind === 'piece') {
        hit.ref.hp -= dmg
        this.emitView('wallHurt', hit.ref)
        if (hit.ref.hp <= 0) this.removeWall(hit.ref, true)
      }
    }
    this.emitView('muzzle', [ox, oy, oz])
  }
  damage(v, dmg, from, head, point) {
    if (!v.alive) return
    let rem = dmg
    let shieldHit = false
    if (v.shield > 0) { const s = Math.min(v.shield, rem); v.shield -= s; rem -= s; shieldHit = true }
    v.hp -= rem
    const pos = point || [v.x, v.y + 1.6, v.z]
    this.ev('dmg', { p: v.id, a: Math.round(dmg), s: shieldHit ? 1 : 0, head: head ? 1 : 0, at: pos, from: from ? from.id : 0 })
    this.emitView('fxDmg', v, Math.round(dmg), shieldHit, head, pos)
    if (v.hp <= 0) { v.hp = 0; this.eliminate(v, from) }
  }
  eliminate(v, killer) {
    v.alive = false
    v.state = 'dead'
    // drop weapon
    this.addLoot({ kind: 'weapon', wt: v.weapon, tier: v.tier, x: v.x + (this.rnd() - 0.5), z: v.z + (this.rnd() - 0.5) })
    if (this.rnd() < 0.75) this.addLoot({ kind: this.rnd() < 0.5 ? 'shield' : 'med', x: v.x + (this.rnd() - 0.5) * 2, z: v.z + (this.rnd() - 0.5) * 2 })
    if (killer && killer !== v) { killer.kills++; killer.mats.wood += 20; killer.mats.brick += 20; killer.mats.metal += 10 }
    this.ev('kill', { k: killer ? killer.id : 0, kn: killer ? killer.name : 'Storm', v: v.id, vn: v.name })
    this.emitView('feed', `<b>${esc(killer ? killer.name : '🌪️ Storm')}</b> eliminated ${esc(v.name)}`)
    this.emitView('fxElim', v, killer)
  }

  swing(p) {
    const sy = Math.sin(p.camYaw), cy = Math.cos(p.camYaw)
    const pitch = p.camPitch
    const dir = [Math.sin(p.camYaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(p.camYaw) * Math.cos(pitch)]
    const o = [p.x + sy * 0.6, p.y + 1.5, p.z + cy * 0.6]
    this.emitView('fxSwing', p)
    const hit = this.hooks.raycast(o, dir, MELEE_RANGE, p.id)
    if (!hit) return
    if (hit.kind === 'prop') {
      const prop = hit.ref
      this.hurtProp(prop, PICKAXE_DMG, p, true)
    } else if (hit.kind === 'wall' || hit.kind === 'piece') {
      hit.ref.hp -= PICKAXE_DMG
      this.emitView('wallHurt', hit.ref)
      if (hit.ref.hp <= 0) this.removeWall(hit.ref, true)
      this.emitView('fxSpark', hit.point, 0xcccccc)
    } else if (hit.kind === 'player' || hit.kind === 'head') {
      const v = this.player(hit.pid)
      if (v && v.alive && v !== p) this.damage(v, 20, p, hit.kind === 'head', hit.point)
    }
  }
  hurtProp(prop, dmg, from, pickaxe) {
    if (prop.hp <= 0) return
    prop.hp -= dmg
    this.emitView('propHurt', prop)
    if (prop.hp <= 0) {
      prop.hp = 0
      const def = HARVEST[prop.type] || HARVEST.tree
      if (from && from.mats) {
        from.mats[def.mat] = (from.mats[def.mat] || 0) + def.amount
        this.ev('harv', { p: from.id, m: def.mat, a: def.amount, at: [prop.x, prop.y + 1.4, prop.z] })
      }
      this.ev('prop-', { id: prop.id })
      this.emitView('propDestroy', prop, from)
    } else if (pickaxe) {
      this.ev('harv', { p: from.id, m: 'tick', a: 0, at: [prop.x, prop.y + 1.6, prop.z] })
    }
  }

  /* ---------------- building ---------------- */
  placePiece(p) {
    if (!p.alive || p.state !== 'play') return
    const piece = p.piece, matKey = p.mat
    const def = BUILD[piece], mat = MATS[matKey]
    if ((p.mats[matKey] || 0) < def.cost) { this.ev('rej', { p: p.id, msg: `Not enough ${mat.name}` }); return }
    const spot = this.buildSpot(p, piece)
    if (!spot) { this.ev('rej', { p: p.id, msg: 'Can\'t build here' }); return }
    if (spot.occupied) { this.ev('rej', { p: p.id, msg: 'Space occupied' }); return }
    p.mats[matKey] -= def.cost
    const w = {
      id: this.wallSeq++, type: piece, mat: matKey, owner: p.id,
      x: spot.x, z: spot.z, base: spot.base, yaw: spot.yaw,
      hp: mat.hp, maxHp: mat.hp,
    }
    this.walls.push(w)
    this.ev('wall+', { w: this.wallObj(w) })
    this.emitView('wallAdd', w)
    this.emitView('fxBuild', w, p)
  }
  wallObj(w) { return [w.id, w.type === 'wall' ? 0 : w.type === 'ramp' ? 1 : 2, MAT_KEYS.indexOf(w.mat), w.x, w.base, w.z, w.yaw, w.hp] }
  parseWallObj(a) {
    return { id: a[0], type: ['wall', 'ramp', 'floor'][a[1]], mat: MAT_KEYS[a[2]], owner: 0, x: a[3], base: a[4], z: a[5], yaw: a[6], hp: a[7], maxHp: MATS[MAT_KEYS[a[2]]].hp }
  }
  buildSpot(p, piece) {
    const terrain = heightAt(p.x, p.z)
    const offset = p.y - terrain
    const level = offset >= 1.9 ? Math.round(offset / 3.2) : 0
    const base = terrain + level * 3.2
    const fy = Math.sin(p.camYaw), fz = Math.cos(p.camYaw)
    const dist = piece === 'wall' ? 3.0 : 3.2
    const yaw = snapAngle(p.camYaw)
    let x, z
    x = Math.round((p.x + fy * dist) / GRID) * GRID
    z = Math.round((p.z + fz * dist) / GRID) * GRID
    const d = Math.hypot(x - p.x, z - p.z)
    if (d > 7.5) return null
    if (piece === 'wall') {
      // wall sits on cell boundary in facing direction
      x = Math.round((p.x + fy * dist) / GRID) * GRID
      z = Math.round((p.z + fz * dist) / GRID) * GRID
    }
    const occupied = this.walls.some(w => w.type === piece && Math.abs(w.base - base) < 0.6 &&
      (piece === 'wall'
        ? Math.abs(w.x - x) < 1.6 && Math.abs(w.z - z) < 1.6
        : Math.abs(w.x - x) < 1.2 && Math.abs(w.z - z) < 1.2))
    return { x, z, base, yaw, occupied }
  }
  removeWall(w, debris) {
    const i = this.walls.indexOf(w)
    if (i < 0) return
    this.walls.splice(i, 1)
    this.ev('wall-', { id: w.id })
    this.emitView('wallRemove', w, debris)
  }

  /* ---------------- harvesting / crafting ---------------- */
  tryCraft(p, recipeId) {
    const rec = RECIPES.find(r => r.id === recipeId)
    if (!rec || p.craft || !p.alive) return
    if (rec.gives.upgrade && p.tier >= 4) { this.ev('rej', { p: p.id, msg: 'Already legendary!' }); return }
    for (const k of MAT_KEYS) if ((p.mats[k] || 0) < (rec.cost[k] || 0)) { this.ev('rej', { p: p.id, msg: `Need more ${MATS[k].name}` }); return }
    for (const k of MAT_KEYS) p.mats[k] -= rec.cost[k] || 0
    p.craft = { id: rec.id, remain: rec.time, total: rec.time }
    this.ev('craftStart', { p: p.id, id: rec.id })
  }
  applyGives(p, rec) {
    if (rec.gives.shield) p.shield = Math.min(100, p.shield + rec.gives.shield)
    if (rec.gives.heal) p.hp = Math.min(100, p.hp + rec.gives.heal)
    if (rec.gives.hop) p.hop = rec.gives.hop
    if (rec.gives.upgrade) p.tier = Math.min(4, p.tier + 1)
  }

  checkPickups(p) {
    if (p.pickCd > 0) { p.pickCd -= 1 / 30 }
    for (const c of this.chests) {
      if (c.open) continue
      if ((p.x - c.x) ** 2 + (p.z - c.z) ** 2 < 5) {
        c.open = true
        this.ev('chest', { id: c.id, p: p.id })
        this.emitView('chestOpen', c, p)
        p.mats.wood += 25; p.mats.brick += 15; p.mats.metal += 10
        const w = this.rollLoot(c.x + 1.4, c.z, 2.4)
        this.addLoot(w)
        this.addLoot(this.rollLoot(c.x - 1.4, c.z + 0.6, 1.6))
        if (this.rnd() < 0.7) this.addLoot({ kind: this.rnd() < 0.5 ? 'shield' : 'med', x: c.x + (this.rnd() - 0.5) * 2, z: c.z + 1.6 })
        this.ev('get', { p: p.id, icon: '🎁', name: 'Chest loot!', tier: -1 })
      }
    }
    for (let i = this.loots.length - 1; i >= 0; i--) {
      const l = this.loots[i]
      if ((p.x - l.x) ** 2 + (p.z - l.z) ** 2 > 4.4) continue
      let msg = null, icon = '', tier = -1
      if (l.kind === 'weapon') {
        if (p.weapon === l.wt && p.tier === l.tier) continue
        if (!(p.weapon === l.wt && p.tier === l.tier)) this.addLoot({ kind: 'weapon', wt: p.weapon, tier: p.tier, x: l.x + 1.1, z: l.z })
        p.weapon = l.wt; p.tier = l.tier
        p.pickCd = 1.4
        const wp = WEAPONS[l.wt], t = TIERS[l.tier]
        msg = `${t.name} ${wp.name}`; icon = wp.icon; tier = l.tier
      } else if (l.kind === 'shield') {
        if (p.shield >= 100) continue
        p.shield = Math.min(100, p.shield + 50); msg = '+50 Shield'; icon = '🛡️'
      } else if (l.kind === 'med') {
        if (p.hp >= 100) continue
        p.hp = Math.min(100, p.hp + 40); msg = '+40 Health'; icon = '❤️'
      } else if (l.kind === 'hop') {
        p.hop = 20; msg = 'Hop Rock! Low gravity'; icon = '☄️'; tier = 3
      }
      this.loots.splice(i, 1)
      this.ev('loot-', { id: l.id })
      this.emitView('lootRemove', l)
      this.ev('get', { p: p.id, icon, name: msg, tier })
      this.emitView('feed', `${esc(p.name)} ${icon} <b>${esc(msg)}</b>`)
      this.emitView('toast', p.id, `${icon} ${msg}`)
      this.emitView('fxPickup', p, l)
    }
  }

  /* ---------------- storm ---------------- */
  stepStorm(dt) {
    const s = this.storm
    if (s.mode === 'wait') {
      s.timer -= dt
      if (s.timer <= 0) {
        const ph = STORM.phases[Math.min(s.phase, STORM.phases.length - 1)]
        s.mode = 'shrink'; s.t = 0; s.dur = ph.shrink
        s.sx = s.cx; s.sz = s.cz; s.sr = s.r
        s.tr = Math.max(4, (s.phase === 0 ? PLAY_R + 6 : s.r) * ph.scale)
        const a = this.rnd() * Math.PI * 2, off = Math.max(0, s.r - s.tr) * 0.55 * this.rnd()
        s.tx = clamp(s.cx + Math.cos(a) * off, -PLAY_R, PLAY_R)
        s.tz = clamp(s.cz + Math.sin(a) * off, -PLAY_R, PLAY_R)
        this.ev('zone', { phase: s.phase + 1 })
      }
    } else {
      s.t += dt
      const ph = STORM.phases[Math.min(s.phase, STORM.phases.length - 1)]
      const k = Math.min(1, s.t / s.dur)
      const e = k // linear shrink
      s.cx = s.sx + (s.tx - s.sx) * e
      s.cz = s.sz + (s.tz - s.sz) * e
      s.r = s.sr + (s.tr - s.sr) * e
      if (k >= 1) {
        s.mode = 'wait'; s.phase++; s.timer = ph.wait
        s.cx = s.tx; s.cz = s.tz
      }
    }
    // damage
    const dps = s.mode === 'shrink' || s.phase > 0 ? (STORM.phases[Math.min(s.phase, STORM.phases.length - 1)].dps) : 0
    if (dps > 0) {
      for (const p of this.players) {
        if (!p.alive || p.state !== 'play') continue
        if (Math.hypot(p.x - s.cx, p.z - s.cz) > s.r) {
          let d = dps
          if (p.shield > 0) { const a = Math.min(p.shield, d); p.shield -= a; d -= a }
          p.hp -= d
          if (p.hp <= 0) { p.hp = 0; this.eliminate(p, p.lastAttacker) }
        }
      }
    }
  }

  checkWin() {
    if (!this.running) return
    const alive = this.players.filter(p => p.alive)
    if (alive.length <= 1 && this.players.length > 1) {
      this.running = false
      this.winner = alive[0] ? alive[0].id : 0
      this.ev('over', { winner: this.winner, name: alive[0] ? alive[0].name : '' })
      this.emitView('gameOver', alive[0] || null)
    }
  }

  /* ---------------- bots ---------------- */
  botInput(p, dt) {
    const ai = p.ai
    ai.t -= dt
    const input = { mv: [0, 0], yaw: p.camYaw, pitch: p.camPitch, fire: false, jump: false, swing: false, place: false, piece: p.piece, mat: p.mat, craft: null }
    if (p.state === 'drop') return input
    const s = this.storm
    const dStorm = Math.hypot(p.x - s.cx, p.z - s.cz)
    let foe = null, foeD = 1e9, foeLOS = false
    for (const q of this.players) {
      if (q === p || !q.alive || q.state !== 'play') continue
      const d = Math.hypot(p.x - q.x, p.z - q.z)
      if (d < foeD) { foeD = d; foe = q }
    }
    if (foe) {
      const dir = [foe.x - p.x, (foe.y + 1.3) - (p.y + 1.5), foe.z - p.z]
      const l = Math.hypot(dir[0], dir[1], dir[2]) || 1
      const hit = this.hooks.raycast([p.x, p.y + 1.5, p.z], [dir[0] / l, dir[1] / l, dir[2] / l], l, p.id)
      foeLOS = !hit || (hit.kind === 'player' && hit.pid === foe.id)
    }
    if (ai.t <= 0) {
      ai.t = 0.3 + this.rnd() * 0.4
      ai.strafe = this.rnd() < 0.5 ? -1 : 1
      if (this.rnd() < 0.14) { ai.tx = s.cx + (this.rnd() - 0.5) * s.r; ai.tz = s.cz + (this.rnd() - 0.5) * s.r }
      // loot target
      let bl = null, bd = 1e9
      for (const l of this.loots) { const d = Math.hypot(p.x - l.x, p.z - l.z); if (d < bd) { bd = d; bl = l } }
      for (const c of this.chests) { if (c.open) continue; const d = Math.hypot(p.x - c.x, p.z - c.z); if (d < bd) { bd = d; bl = c } }
      ai.loot = bl
      if (p.hp < 50 && p.hp > 0 && this.rnd() < 0.5) p.hp = Math.min(100, p.hp + 40)
      if (p.shield < 50 && this.rnd() < 0.4) p.shield = Math.min(100, p.shield + 50)
      if (foe && foeLOS && foeD < 26 && p.mats.wood >= 10 && this.rnd() < 0.35) { p.piece = this.rnd() < 0.5 ? 'wall' : 'ramp'; input.place = true }
    }
    const inStorm = dStorm > s.r - 1.5 && s.r < PLAY_R + 5
    let mx = 0, mz = 0
    if (inStorm) {
      mx = s.cx - p.x; mz = s.cz - p.z
    } else if (foe && foeD < 55 && (foeLOS || foeD < 24)) {
      p.camYaw = Math.atan2(foe.x - p.x, foe.z - p.z)
      p.camPitch = clamp(Math.atan2((foe.y + 1.4) - (p.y + 1.5), foeD), -0.4, 0.5) * 0.8
      input.yaw = p.camYaw; input.pitch = p.camPitch
      const want = foeD > 20 ? 1 : (foeD < 9 ? -1 : 0)
      const fx = Math.sin(p.camYaw), fz = Math.cos(p.camYaw)
      mx = fx * want + fz * ai.strafe * 0.75
      mz = fz * want - fx * ai.strafe * 0.75
      input.fire = foeLOS && foeD < WEAPONS[p.weapon].range * 0.95
      if (this.rnd() < dt * 0.6 && p.y <= this.groundHeight(p.x, p.z, p.y) + 0.1) input.jump = true
    } else if (ai.loot) {
      const t = ai.loot
      mx = t.x - p.x; mz = t.z - p.z
      if (Math.hypot(mx, mz) < 1.6) { ai.loot = null; mx = (this.rnd() - 0.5) * 2; mz = (this.rnd() - 0.5) * 2 }
      p.camYaw = Math.atan2(mx, mz)
    } else {
      mx = ai.tx - p.x; mz = ai.tz - p.z
      if (Math.hypot(mx, mz) < 3) { ai.tx = (this.rnd() - 0.5) * 400; ai.tz = (this.rnd() - 0.5) * 400 }
      p.camYaw = Math.atan2(mx, mz)
    }
    const l = Math.hypot(mx, mz)
    if (l > 0.05) { input.mv = [mx / l, mz / l]; p.yaw = Math.atan2(mx, mz) }
    input.place = !!input.place
    return input
  }
  botMove(p, dx, dz, dt, spd) { p.x += dx * spd * dt; p.z += dz * spd * dt }

  /* ---------------- guest prediction ---------------- */
  guestStep(dt, myInput) {
    if (!this.running) return
    const p = this.player(this.myPid)
    if (!p || !p.alive) return
    const pred = p.pred
    if (!pred.init) { pred.x = p.x; pred.y = p.y; pred.z = p.z; pred.vy = p.vy || 0; pred.init = true }
    const inp = myInput || {}
    if (p.state === 'drop') {
      const [mx, mz] = inp.mv || [0, 0]
      const len = Math.hypot(mx, mz)
      if (!p.gliding && pred.y <= GLIDER_ALT) p.gliding = true
      if (len > 0.12) {
        const spd = p.gliding ? 17 : 14
        const sy = Math.sin(inp.yaw ?? p.camYaw), cy = Math.cos(inp.yaw ?? p.camYaw)
        pred.x += (mx * cy + mz * sy) / len * spd * dt
        pred.z += (-mx * sy + mz * cy) / len * spd * dt
      }
      const targetVy = p.gliding ? -9.5 : -44
      pred.vy += (targetVy - pred.vy) * Math.min(1, dt * 2.4)
      pred.y += pred.vy * dt
      const g = heightAt(pred.x, pred.z)
      if (pred.y <= g) { pred.y = g; pred.vy = 0; p.gliding = false }
      return
    }
    // play: local movement prediction (pred only — never touch authoritative p.x/y/z)
    const [mx, mz] = inp.mv || [0, 0]
    const len = Math.hypot(mx, mz)
    p.camYaw = inp.yaw ?? p.camYaw
    p.camPitch = inp.pitch ?? p.camPitch
    if (len > 0.14) {
      const cl = Math.min(len, 1) / (len || 1)
      const sy = Math.sin(p.camYaw), cy = Math.cos(p.camYaw)
      const wx = (mx * cy + mz * sy) * cl
      const wz = (-mx * sy + mz * cy) * cl
      pred.x += wx * 7.6 * dt; pred.z += wz * 7.6 * dt
      p.yaw = Math.atan2(wx, wz)
      p.moving = true
    } else p.moving = false
    const g = this.groundHeight(pred.x, pred.z, pred.y)
    const onGround = pred.y <= g + 0.06
    if (inp.jump && !p.prevJump && onGround) pred.vy = p.hop > 0 ? 13.4 : 9.4
    pred.vy -= GRAV * (p.hop > 0 ? 0.42 : 1) * dt
    pred.y += pred.vy * dt
    if (pred.y <= g) { pred.y = g; pred.vy = 0 }
    this.collide(pred)
    p.prevJump = !!inp.jump
  }

  /* ---------------- snapshots (host) ---------------- */
  buildSnapshot() {
    const bulk = this.tickN % 15 === 1
    const snap = {
      type: 'snap',
      tick: this.tickN,
      storm: [round2(this.storm.cx), round2(this.storm.cz), round2(this.storm.r), this.storm.phase, this.storm.mode === 'shrink' ? 1 : 0, round1(this.storm.timer)],
      players: this.players.map(p => [
        p.id, round2(p.x), round2(p.y), round2(p.z), round2(p.yaw), round2(p.camYaw), round2(p.camPitch),
        Math.round(p.hp), Math.round(p.shield), p.alive ? (p.state === 'drop' ? 1 : 2) : 0,
        p.weapon, p.tier, p.mats.wood | 0, p.mats.brick | 0, p.mats.metal | 0, p.kills,
        Math.round(p.hop), p.craft ? 1 : 0, p.piece === 'wall' ? 0 : p.piece === 'ramp' ? 1 : 2,
        MAT_KEYS.indexOf(p.mat), p.gliding ? 1 : 0,
        p.craft ? round1(p.craft.remain) : -1, p.craft ? round1(p.craft.total) : -1,
      ]),
      ev: this.events,
      bulk: bulk ? {
        walls: this.walls.map(w => this.wallObj(w)),
        loots: this.loots.map(l => [l.id, l.kind === 'weapon' ? 0 : l.kind === 'shield' ? 1 : l.kind === 'med' ? 2 : 3, l.kind === 'weapon' ? WEAPON_IDX(l.wt) : 0, l.kind === 'weapon' ? l.tier : 0, round2(l.x), round2(l.z)]),
        chests: this.chests.map(c => [c.id, c.open ? 1 : 0]),
        props: this.props.filter(p => p.hp <= 0).map(p => p.id),
      } : null,
    }
    this.events = []
    return snap
  }
  applySnapshot(snap) {
    this.running = true
    // storm
    const st = snap.storm
    this.storm.cx = st[0]; this.storm.cz = st[1]; this.storm.r = st[2]
    const prevPhase = this.storm.phase
    this.storm.phase = st[3]; this.storm.mode = st[4] ? 'shrink' : 'wait'; this.storm.timer = st[5]
    // players
    for (const a of snap.players) {
      let p = this.player(a[0])
      if (!p) { p = { id: a[0], render: { init: false }, pred: { init: false }, mats: {}, ai: {} }; this.players.push(p) }
      p.x = a[1]; p.y = a[2]; p.z = a[3]; p.yaw = a[4]; p.camYaw = a[5]; p.camPitch = a[6]
      p.hp = a[7]; p.shield = a[8]
      const wasAlive = p.alive
      p.alive = a[9] > 0; p.state = a[9] === 1 ? 'drop' : a[9] === 2 ? 'play' : 'dead'
      p.weapon = a[10]; p.tier = a[11]
      p.mats.wood = a[12]; p.mats.brick = a[13]; p.mats.metal = a[14]
      p.kills = a[15]; p.hop = a[16]; p.hasCraft = !!a[17]
      p.piece = ['wall', 'ramp', 'floor'][a[18]]; p.mat = MAT_KEYS[a[19]]; p.gliding = !!a[20]
      if (a[21] > 0 && p.id === this.myPid) p.craft = { id: p.craft ? p.craft.id : '', remain: a[21], total: a[22] || a[21] }
      else if (a[21] <= 0 && p.id === this.myPid) p.craft = null
      if (!p.render.init) { p.render.x = p.x; p.render.y = p.y; p.render.z = p.z; p.render.init = true }
      if (p.id === this.myPid && p.pred.init) {
        // reconcile prediction
        const err = Math.hypot(p.x - p.pred.x, p.y - p.pred.y, p.z - p.pred.z)
        if (err > 5) { p.pred.x = p.x; p.pred.y = p.y; p.pred.z = p.z }
        else { p.pred.x += (p.x - p.pred.x) * 0.12; p.pred.y += (p.y - p.pred.y) * 0.12; p.pred.z += (p.z - p.pred.z) * 0.12 }
        p.x = p.pred.x; p.y = p.pred.y; p.z = p.pred.z
      }
      if (!wasAlive && p.alive) p.render.init = false
    }
    // events
    for (const [type, d] of snap.ev || []) this.handleEvent(type, d)
    // bulk
    if (snap.bulk) this.applyBulk(snap.bulk)
  }
  applyBulk(b) {
    // walls
    const seen = new Set()
    for (const a of b.walls) {
      seen.add(a[0])
      let w = this.walls.find(x => x.id === a[0])
      if (!w) { w = this.parseWallObj(a); this.walls.push(w); this.emitView('wallAdd', w, true) }
      else { w.hp = a[7] }
    }
    for (const w of [...this.walls]) if (!seen.has(w.id)) { this.walls.splice(this.walls.indexOf(w), 1); this.emitView('wallRemove', w, false) }
    // loots
    const seenL = new Set()
    for (const a of b.loots) {
      seenL.add(a[0])
      if (this.loots.some(l => l.id === a[0])) continue
      const kind = ['weapon', 'shield', 'med', 'hop'][a[1]]
      const wt = kind === 'weapon' ? WEAPON_KEYS[a[2]] : null
      const l = { id: a[0], kind, wt, tier: a[3], x: a[4], z: a[5] }
      this.loots.push(l)
      this.emitView('lootAdd', l, true)
    }
    for (const l of [...this.loots]) if (!seenL.has(l.id)) { this.loots.splice(this.loots.indexOf(l), 1); this.emitView('lootRemove', l) }
    // chests
    for (const a of b.chests) {
      const c = this.chests.find(x => x.id === a[0])
      if (c && a[1] && !c.open) { c.open = true; this.emitView('chestOpen', c, null, true) }
    }
    // destroyed props
    for (const id of b.props) {
      const prop = this.props.find(p => p.id === id)
      if (prop && prop.hp > 0) { prop.hp = 0; this.emitView('propDestroy', prop, null, true) }
    }
  }
  handleEvent(type, d) {
    if (type === 'shot') {
      if (d.from === this.myPid) return   // already predicted locally
      const p = this.player(d.from)
      this.emitView('fxShot', p, d.o, d.e, WEAPONS[d.w] || WEAPONS.ar)
      this.emitView('muzzle', d.o)
    } else if (type === 'dmg') {
      const v = this.player(d.p)
      if (v) this.emitView('fxDmg', v, d.a, !!d.s, !!d.head, d.at)
    } else if (type === 'kill') {
      const v = this.player(d.v), k = this.player(d.k)
      if (v) this.emitView('fxElim', v, k)
      this.emitView('feed', `<b>${esc(d.kn)}</b> eliminated ${esc(d.vn)}`)
    } else if (type === 'harv') {
      if (d.m !== 'tick' && d.a > 0) this.emitView('fxDmgText', d.at, `+${d.a} ${MATS[d.m].icon}`, '#ffe9a8')
    } else if (type === 'rej') {
      this.emitView('toast', d.p, `⛔ ${d.msg}`)
    } else if (type === 'get') {
      this.emitView('feed', `${this.playerName(d.p)} ${d.icon} <b>${esc(d.name)}</b>`)
      this.emitView('toast', d.p, `${d.icon} ${d.name}`)
    } else if (type === 'chest') {
      const c = this.chests.find(x => x.id === d.id)
      if (c && !c.open) { c.open = true; this.emitView('chestOpen', c, this.player(d.p)) }
    } else if (type === 'wall+') {
      const w = this.parseWallObj(d.w)
      if (!this.walls.some(x => x.id === w.id)) { this.walls.push(w); this.emitView('wallAdd', w, true) }
    } else if (type === 'wall-') {
      const w = this.walls.find(x => x.id === d.id)
      if (w) { this.walls.splice(this.walls.indexOf(w), 1); this.emitView('wallRemove', w, true) }
    } else if (type === 'loot-') {
      const l = this.loots.find(x => x.id === d.id)
      if (l) { this.loots.splice(this.loots.indexOf(l), 1); this.emitView('lootRemove', l) }
    } else if (type === 'prop-') {
      const prop = this.props.find(p => p.id === d.id)
      if (prop && prop.hp > 0) { prop.hp = 0; this.emitView('propDestroy', prop, null, true) }
    } else if (type === 'zone') {
      this.emitView('feed', `⚠️ <b>Zone ${d.phase}</b> is moving!`)
      this.emitView('zoneWarn')
    } else if (type === 'craft') {
      const p = this.player(d.p)
      this.emitView('toast', d.p, `${d.icon} Crafted ${d.name}!`)
      if (p && p.id === this.myPid && d.id === 'upgrade') { /* tier from snapshot */ }
    } else if (type === 'craftStart') {
      this.emitView('craftStarted', d.p, d.id)
    } else if (type === 'over') {
      this.running = false
      this.winner = d.winner
      this.emitView('gameOver', this.player(d.winner))
    } else if (type === 'land') {
      this.emitView('landed', d.p)
    } else if (type === 'glide') {
      // noop
    }
  }
  playerName(pid) { const p = this.player(pid); return p ? p.name : '???' }

  /* ---------------- net plumbing ---------------- */
  handleNet(type, data, from) {
    if (type === 'input') {
      if (this.mode !== 'host') return
      const p = this.player(from)
      if (p) this.setLocalInput(from, data)
    } else if (type === 'snap') {
      if (this.mode !== 'guest') return
      this.applySnapshot(data)
    } else if (type === 'chat') {
      this.emitView('feed', `${esc(data.name)}: ${esc(data.msg)}`)
    }
  }
  guestInputSend(inp) { return inp }
}
const WEAPON_IDX = k => Math.max(0, Object.keys(WEAPONS).indexOf(k))
const round2 = v => Math.round(v * 100) / 100
const round1 = v => Math.round(v * 10) / 10
const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
