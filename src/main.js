// Mini Royale — main: UI, input, view sync, networking, render loop.
import * as THREE from 'three'
import { EffectComposer } from '../vendor/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from '../vendor/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from '../vendor/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from '../vendor/jsm/postprocessing/OutputPass.js'
import { Sim } from './sim.js'
import { Room, autoRoomParams } from './net.js'
import {
  WEAPONS, TIERS, MATS, MAT_KEYS, BUILD, RECIPES, PLAY_R, GRID, TICK,
  BOTS_MAX, BOT_NAMES, BOT_COLORS, WEAPON_KEYS, INPUT_RATE,
} from './config.js'
import {
  detectQuality, createRenderer, buildScene, generateWorldData, heightAt, hidePropVisual, damagePropVisual, TEX,
} from './world.js'
import { buildAvatar, lootMesh, chestMesh, ghostMesh, setGhostValid, FX, tagSprite } from './entities.js'

const $ = id => document.getElementById(id)
const canvas = $('scene')
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

/* ================= state ================= */
let quality = 'auto'
let soundOn = localStorage.getItem('mr_sound') !== '0'
let renderer, scene, camera, composer, fx, worldView, sim, room
let localPid = null
let mode = 'solo'                       // 'solo' | 'host' | 'guest'
let gameOn = false
let buildMode = false, pickMode = false
let piece = 'wall', matKey = 'wood'
let craftOpen = false
let ghost = null
let avatars = new Map()                 // pid -> avatar parts
let wallMeshes = new Map()              // wall id -> mesh
let lootMeshes = new Map()
let chestViews = new Map()
let instPropMap = new Map()             // instanced mesh -> {list:[prop per instanceId] or byIndex fn}
let shootTargets = []
let elapsed = 0
let snapAcc = 0, inputAcc = 0, hudAcc = 0
let myPredCd = 0
let botCount = 6
let lastInput = { mv: [0, 0], yaw: 0, pitch: 0.3, fire: false, jump: false, swing: false, place: false, piece: 'wall', mat: 'wood', craft: null }
const inputState = { fire: false, jumpEdge: false, placeEdge: false, craftReq: null }
const joy = { x: 0, y: 0, id: null }
const keys = {}
const lookPtrs = new Map()

/* ================= audio ================= */
let actx = null
function sfx(freq, dur, type, vol, slide) {
  if (!soundOn) return
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)()
    if (actx.state === 'suspended') actx.resume()
    const o = actx.createOscillator(), g = actx.createGain()
    o.type = type || 'square'; o.frequency.value = freq
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), actx.currentTime + dur)
    g.gain.value = vol || 0.05
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur)
    o.connect(g); g.connect(actx.destination)
    o.start(); o.stop(actx.currentTime + dur)
  } catch {}
}
const sndShoot = k => sfx(k === 'pump' ? 150 : k === 'bolt' ? 190 : 540, k === 'pump' ? 0.16 : 0.07, 'square', 0.045, -140)
const sndHit = () => sfx(940, 0.05, 'square', 0.05)
const sndHurt = () => sfx(210, 0.14, 'sawtooth', 0.06, -90)
const sndBuild = () => sfx(330, 0.09, 'triangle', 0.07, 140)
const sndCraft = () => { sfx(520, 0.1, 'sine', 0.07); setTimeout(() => sfx(780, 0.14, 'sine', 0.07), 110) }
const sndElim = () => sfx(280, 0.3, 'sawtooth', 0.08, -200)
const sndPickup = () => sfx(700, 0.09, 'sine', 0.06, 200)
const sndChest = () => { sfx(640, 0.09, 'sine', 0.07); setTimeout(() => sfx(900, 0.12, 'sine', 0.07), 100) }
const sndWin = () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => sfx(f, 0.28, 'sine', 0.09), i * 170))

function setSound(on) {
  soundOn = !!on
  localStorage.setItem('mr_sound', soundOn ? '1' : '0')
  const segs = $('soundSegs')
  if (segs) segs.querySelectorAll('.seg').forEach(b => b.classList.toggle('active', (b.dataset.s === '1') === soundOn))
  const pill = $('mutePill')
  if (pill) { pill.textContent = soundOn ? '🔊' : '🔇'; pill.title = soundOn ? 'Mute sound' : 'Unmute sound' }
}

/* ================= menu & lobby ================= */
function initMenu() {
  if (matchMedia('(pointer: fine)').matches && !matchMedia('(pointer: coarse)').matches) document.body.classList.add('desktop')
  const segs = $('qualitySegs')
  segs.onclick = e => {
    const b = e.target.closest('.seg'); if (!b) return
    segs.querySelectorAll('.seg').forEach(x => x.classList.remove('active'))
    b.classList.add('active'); quality = b.dataset.q
  }
  const ss = $('soundSegs')
  if (ss) ss.onclick = e => {
    const b = e.target.closest('.seg'); if (!b) return
    setSound(b.dataset.s === '1')
  }
  setSound(soundOn)
  $('botCount').oninput = e => { botCount = +e.target.value; $('botVal').textContent = botCount }
  $('btnSolo').onclick = () => startGame('solo')
  $('btnHost').onclick = async () => {
    try {
      room = new Room()
      const r = await room.create('P1')
      localPid = r.pid; mode = 'host'
      $('lobbyTitle').textContent = '📱 Room created — invite phone #2'
      $('roomCode').textContent = r.code
      $('joinUrl').textContent = room.joinUrl()
      $('btnJoinInstead').style.display = 'none'
      $('btnStartRoom').disabled = true
      $('lobbyStatus').textContent = 'Waiting for phone #2 to join…'
      $('lobbyStatus').className = ''
      wireRoom(room)
      openLobby()
    } catch (e) { $('menuStatus').textContent = '⚠️ Could not create room: ' + e.message }
  }
  $('btnLobbyBack').onclick = () => { $('lobby').style.display = 'none'; if (room) { room.stop(); room = null } }
  $('btnJoinInstead').onclick = () => { $('joinForm').style.display = 'block'; $('codeInput').focus() }
  $('btnDoJoin').onclick = doJoin
  $('codeInput').onkeydown = e => { if (e.key === 'Enter') doJoin() }
  $('joinUrl').onclick = () => {
    navigator.clipboard?.writeText($('joinUrl').textContent)
    $('joinUrl').textContent = '✓ Copied! Open it on phone #2'
    setTimeout(() => { $('joinUrl').textContent = room ? room.joinUrl() : '' }, 1600)
  }
  $('btnStartRoom').onclick = () => startGame('host')
  $('btnAgain').onclick = () => { location.href = location.pathname }
  // auto-join via ?room=
  const p = autoRoomParams()
  if (p.get('room')) {
    $('menu').style.display = 'none'
    $('lobby').style.display = 'flex'
    $('lobbyTitle').textContent = '🔑 Joining room…'
    $('roomCode').textContent = p.get('room').toUpperCase()
    $('joinUrl').style.display = 'none'
    $('btnStartRoom').style.display = 'none'
    $('btnJoinInstead').style.display = 'none'
    $('lobbyStatus').textContent = 'Connecting…'
    doJoin(p.get('room'))
  }
}
function openLobby() { $('menu').style.display = 'none'; $('lobby').style.display = 'flex' }
async function doJoin(code) {
  code = (code || $('codeInput').value || '').trim().toUpperCase()
  if (code.length < 3) { $('lobbyStatus').textContent = 'Enter the 4-letter code'; return }
  try {
    room = new Room()
    const r = await room.join(code, 'P2')
    localPid = r.pid; mode = 'guest'
    $('lobbyTitle').textContent = '📱 Connected — waiting for host…'
    $('roomCode').textContent = r.code
    $('joinUrl').style.display = 'none'
    $('btnJoinInstead').style.display = 'none'
    $('btnStartRoom').style.display = 'none'
    $('lobbyStatus').textContent = '✓ Joined! Host will start the match.'
    $('lobbyStatus').className = 'ok'
    wireRoom(room)
    openLobby()
  } catch (e) {
    $('lobbyStatus').textContent = '⚠️ ' + (e.message.includes('404') ? 'Room not found' : e.message.includes('409') ? 'Room is full' : 'Connection failed')
    $('lobbyStatus').className = ''
  }
}
function wireRoom(room) {
  room.onStatus = (msg, ok) => { $('lobbyStatus').textContent = msg; $('lobbyStatus').className = ok ? 'ok' : ''; toast(msg) }
  room.on('system', d => {
    if (d.kind === 'joined') {
      if (mode === 'host') {
        $('lobbyStatus').textContent = `✓ ${d.name} joined (phone #2 connected!)`
        $('lobbyStatus').className = 'ok'
        $('btnStartRoom').disabled = false
        sfx(880, 0.12, 'sine', 0.07)
        if (gameOn && sim) {
          // late join: add guest as player 2 and send start
          const defs = currentDefs()
          if (!defs.some(x => x.id === d.pid)) defs.push({ id: d.pid, name: 'P2', color: 0xff7a1a, bot: false, role: 'guest' })
          sim.startMatch(defs)
          syncAvatars(defs)
          room.sendNow('start', { defs })
        }
      }
    }
  })
  room.on('start', d => {
    if (mode === 'guest') { startGame('guest', d.defs) }
  })
  room.on('input', (data, from) => { if (sim && mode === 'host') sim.handleNet('input', data, from) })
  room.on('snap', data => { if (sim && mode === 'guest') sim.handleNet('snap', data) })
  room.on('resync', () => { if (mode === 'guest' && sim) room.sendNow('hello', {}) })
  setInterval(() => {
    if (room && mode === 'host' && !$('pingLine').textContent) return
    if (room) $('pingLine').textContent = room.pingMs ? `ping ${room.pingMs}ms · code ${room.code}` : `code ${room?.code || ''}`
  }, 1000)
}
function currentDefs() {
  const defs = []
  if (mode === 'host') defs.push({ id: room.pid, name: 'P1', color: 0x2f80ff, bot: false, role: 'host' })
  const guest = room && room.players.find(p => p.role === 'guest')
  if (guest) defs.push({ id: guest.pid, name: 'P2', color: 0xff7a1a, bot: false, role: 'guest' })
  for (let i = 0; i < botCount; i++) defs.push({ id: 1000 + i, name: BOT_NAMES[i % BOT_NAMES.length], color: BOT_COLORS[i % BOT_COLORS.length], bot: true })
  return defs
}

/* ================= view hooks ================= */
function makeHooks() {
  return {
    raycast: viewRaycast,
    fxShot: (p, o, e, w) => {
      if (!p) return
      fx.tracer(new THREE.Vector3(...o), new THREE.Vector3(...e), w.tracer)
      sndShoot(w ? guessW(p) : 'ar')
    },
    muzzle: o => fx.muzzle(new THREE.Vector3(...o)),
    fxDmg: (v, amt, shield, head, pos) => {
      fx.damageNum(new THREE.Vector3(pos[0], pos[1] + 0.3, pos[2]), String(amt), head ? '#ffe14d' : shield ? '#7ec9ff' : '#ffffff')
      if (v && v.id === localPid) { sndHurt(); flashVitals() } else sndHit()
    },
    fxDmgText: (pos, text, color) => fx.damageNum(new THREE.Vector3(...pos), text, color),
    fxElim: (v, k) => {
      fx.debris(new THREE.Vector3(v.x, v.y + 1.2, v.z), v.color || 0xffffff, 12)
      sndElim()
    },
    fxSpark: (pos, color) => fx.spark(new THREE.Vector3(...pos), color),
    fxSwing: p => { const a = avatars.get(p && p.id); if (a) a.swingT = 0.25 },
    fxBuild: (w, p) => { sndBuild(); fx.spark(new THREE.Vector3(w.x, w.base + 1.5, w.z), MATS[w.mat].color) },
    fxPickup: (p, l) => { if (p && p.id === localPid) sndPickup() },
    wallAdd: w => addWallMesh(w),
    wallRemove: (w, debris) => removeWallMesh(w, debris),
    wallHurt: w => { const m = wallMeshes.get(w.id); if (m && m.material.emissive !== undefined) { m.material.emissive.setHex(0x552222); setTimeout(() => m.material.emissive && m.material.emissive.setHex(0x000000), 80) } },
    lootAdd: l => addLootMesh(l),
    lootRemove: l => { const m = lootMeshes.get(l.id); if (m) { scene.remove(m); lootMeshes.delete(l.id) } },
    chestOpen: (c, p, silent) => {
      const cv = chestViews.get(c.id)
      if (cv) { cv.lid.rotation.x = -1.5; cv.glow.material.opacity = 0.15; cv.beam.visible = false }
      if (!silent) { sndChest(); if (p && p.id === localPid) toast('🎁 Chest opened!') }
    },
    propHurt: prop => damagePropVisual(prop),
    propDestroy: (prop, by, silent) => {
      hidePropVisual(worldView, prop)
      if (!silent) fx.debris(new THREE.Vector3(prop.x, (prop.y || 0) + 1.2, prop.z), prop.type === 'tree' ? 0x6a9a3a : prop.type === 'rock' ? 0x96a0ab : 0x7f93a8, 8)
    },
    toast: (pid, msg) => { if (pid === localPid || pid === 0) toast(msg) },
    feed: html => feed(html),
    zoneWarn: () => { sfx(220, 0.5, 'sawtooth', 0.07, -60); $('zonePill').classList.add('warn') },
    craftStarted: (pid, id) => { if (pid === localPid) sndCraft() },
    landed: pid => { if (pid === localPid) { $('dropHint').style.display = 'none'; sfx(180, 0.2, 'triangle', 0.07, 60) } },
    gameOver: winner => showOver(winner),
  }
}
const guessW = p => p && p.weapon ? p.weapon : 'ar'

/* ---- structures / meshes ---- */
function addWallMesh(w) {
  if (wallMeshes.has(w.id)) return
  const matDef = MATS[w.mat]
  const tex = w.mat === 'wood' ? TEX.wood : w.mat === 'brick' ? TEX.brick : TEX.metal
  const mtl = new THREE.MeshLambertMaterial({ map: tex || null, color: tex ? 0xffffff : matDef.color })
  let geo, mesh
  if (w.type === 'wall') {
    geo = new THREE.BoxGeometry(4, 3.2, 0.3)
    mesh = new THREE.Mesh(geo, mtl)
    mesh.position.set(w.x, w.base + 1.6, w.z)
    if (Math.abs(Math.sin(w.yaw)) > 0.5) mesh.rotation.y = Math.PI / 2
  } else if (w.type === 'floor') {
    geo = new THREE.BoxGeometry(4, 0.26, 4)
    mesh = new THREE.Mesh(geo, mtl)
    mesh.position.set(w.x, w.base + 0.13, w.z)
  } else {
    geo = new THREE.BoxGeometry(4, 0.3, 4.6)
    mesh = new THREE.Mesh(geo, mtl)
    const mid = w.base + 1.6
    mesh.position.set(w.x, mid, w.z)
    mesh.rotation.order = 'YXZ'
    mesh.rotation.y = w.yaw
    mesh.rotation.x = -Math.atan2(3.2, 4)
    // slide ramp along its facing so low end sits at cell edge
    mesh.position.x += Math.sin(w.yaw) * 0
  }
  mesh.castShadow = mesh.receiveShadow = true
  mesh.userData.kind = w.type === 'wall' ? 'wall' : 'piece'
  mesh.userData.ref = w
  scene.add(mesh)
  wallMeshes.set(w.id, mesh)
  rebuildShootTargets()
}
function removeWallMesh(w, debris) {
  const m = wallMeshes.get(w.id)
  if (m) {
    if (debris) fx.debris(m.position.clone(), MATS[w.mat].color, 6)
    scene.remove(m)
    m.geometry?.dispose()
    wallMeshes.delete(w.id)
    rebuildShootTargets()
  }
}
function addLootMesh(l, silent) {
  if (lootMeshes.has(l.id)) return
  const g = lootMesh(l.kind, l.wt, l.tier || 0)
  g.position.set(l.x, 0.95, l.z)
  g.userData.bob = Math.random() * 6
  scene.add(g)
  lootMeshes.set(l.id, g)
}
function syncAvatars(defs) {
  for (const [pid, a] of avatars) if (!defs.some(d => d.id === pid)) { scene.remove(a.group); avatars.delete(pid) }
  for (const d of defs) {
    if (avatars.has(d.id)) continue
    const av = buildAvatar(d.color, d.name, d.id === localPid)
    av.hit.userData = { kind: 'player', pid: d.id }
    av.headHit.userData = { kind: 'head', pid: d.id }
    // pickaxe model
    const pick = new THREE.Group()
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.85, 0.09), new THREE.MeshLambertMaterial({ color: 0x8a5a34 }))
    handle.rotation.z = 0.4
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.14, 0.14), new THREE.MeshLambertMaterial({ color: 0xb9c4d0 }))
    head.position.set(0.16, 0.38, 0)
    pick.add(handle, head)
    pick.position.set(0.55, 1.45, 0.5)
    pick.visible = false
    av.group.add(pick)
    av.pick = pick
    scene.add(av.group)
    avatars.set(d.id, av)
  }
  rebuildShootTargets()
}

/* ---- raycast ---- */
const rayc = new THREE.Raycaster()
function viewRaycast(o, d, range, shooterId) {
  rayc.set(new THREE.Vector3(o[0], o[1], o[2]), new THREE.Vector3(d[0], d[1], d[2]).normalize())
  rayc.far = range
  const targets = shootTargets.filter(t => {
    const ud = t.userData
    if (ud && ud.pid === shooterId) return false
    return true
  })
  const hits = rayc.intersectObjects(targets, false)
  for (const h of hits) {
    const ud = h.object.userData
    const pt = [h.point.x, h.point.y, h.point.z]
    if (ud && (ud.kind === 'player' || ud.kind === 'head')) {
      const p = sim.player(ud.pid)
      if (p && p.alive) return { point: pt, kind: ud.kind, pid: ud.pid }
    } else if (ud && ud.kind === 'propHouse') {
      if (ud.ref.hp > 0) return { point: pt, kind: 'prop', ref: ud.ref }
    } else if (ud && (ud.kind === 'wall' || ud.kind === 'piece')) {
      return { point: pt, kind: ud.kind === 'wall' ? 'wall' : 'piece', ref: ud.ref }
    } else if (h.instanceId !== undefined) {
      const entry = instPropMap.get(h.object)
      if (entry) {
        const prop = entry[h.instanceId]
        if (prop && prop.hp > 0) return { point: pt, kind: 'prop', ref: prop }
      }
    }
  }
  return null
}
function rebuildShootTargets() {
  shootTargets = []
  for (const [, av] of avatars) { shootTargets.push(av.hit, av.headHit) }
  if (worldView) for (const m of worldView.propMeshes.instMeshes) shootTargets.push(m)
  if (worldView) for (const [, prop] of propById) if (prop._mesh) { prop._mesh.userData = { kind: 'propHouse', ref: prop }; shootTargets.push(prop._mesh) }
  for (const [, m] of wallMeshes) shootTargets.push(m)
}
const propById = new Map()

/* ================= world init ================= */
function initGraphics() {
  const q = quality === 'auto' ? detectQuality() : quality
  window.__quality = q
  renderer = createRenderer(canvas, q)
  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(isPortrait() ? 74 : 68, innerWidth / innerHeight, 0.1, 2400)
  camera.position.set(0, 40, 60)
  const data = generateWorldData(1337)
  worldView = buildScene(scene, data, q)
  propById.clear()
  for (const p of data.props) propById.set(p.id, p)
  // instance id -> prop maps
  instPropMap.clear()
  const trees = data.props.filter(p => p.type === 'tree')
  const mapTrunk = [], mapBlob = [], mapRock = [], mapBarrel = [], mapBox = []
  trees.forEach((p, i) => { mapTrunk[i] = p; for (let b = 0; b < 3; b++) mapBlob[i * 3 + b] = p })
  data.props.filter(p => p.type === 'rock').forEach((p, i) => { mapRock[i] = p })
  data.props.filter(p => p.type === 'metal' && p.variant === 0).forEach((p, i) => { mapBarrel[i] = p })
  data.props.filter(p => p.type === 'metal' && p.variant === 1).forEach((p, i) => { mapBox[i] = p })
  instPropMap.set(worldView.propMeshes.trunks, mapTrunk)
  instPropMap.set(worldView.propMeshes.blobs, mapBlob)
  instPropMap.set(worldView.propMeshes.rockMesh, mapRock)
  instPropMap.set(worldView.propMeshes.barrelMesh, mapBarrel)
  instPropMap.set(worldView.propMeshes.boxMesh, mapBox)
  // chests visuals
  for (const c of data.chests) {
    const cv = chestMesh()
    cv.group.position.set(c.x, heightAt(c.x, c.z), c.z)
    scene.add(cv.group)
    chestViews.set(c.id, cv)
  }
  // storm visuals
  const stormGeo = new THREE.CylinderGeometry(1, 1, 190, 48, 1, true)
  const stormMat = new THREE.ShaderMaterial({
    transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false,
    uniforms: { t: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `varying vec2 vUv; uniform float t;
      void main(){
        float s = sin(vUv.y*46.0 - t*2.2 + sin(vUv.x*28.0 + t*0.6)*2.4);
        float s2 = sin(vUv.y*17.0 + t*1.3 + vUv.x*40.0);
        float a = 0.13 + 0.10*pow(abs(s),2.0) + 0.06*pow(abs(s2),3.0);
        vec3 col = mix(vec3(0.32,0.28,0.95), vec3(0.62,0.35,1.0), 0.5+0.5*s2);
        gl_FragColor = vec4(col, a);
      }`,
  })
  const stormMesh = new THREE.Mesh(stormGeo, stormMat)
  stormMesh.position.y = 55
  scene.add(stormMesh)
  const ringGeo = new THREE.TorusGeometry(1, 0.22, 8, 64)
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xb9a4ff, transparent: true, opacity: 0.8 }))
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.4
  scene.add(ring)
  worldView.stormMesh = stormMesh
  worldView.stormRing = ring
  fx = new FX(scene)
  if (q === 'bloom' || q === 'high') {
    composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))
    const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.34, 0.6, 0.86)
    composer.addPass(bloom)
    composer.addPass(new OutputPass())
  }
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight)
    camera.aspect = isPortrait() ? innerWidth / innerHeight : innerWidth / innerHeight
    camera.updateProjectionMatrix()
    if (composer) composer.setSize(innerWidth, innerHeight)
  })
}
const isPortrait = () => innerHeight > innerWidth

/* ================= start a match ================= */
function startGame(m, defsArg) {
  mode = m
  $('menu').style.display = 'none'
  $('lobby').style.display = 'none'
  $('hud').style.display = 'block'
  if (!renderer) initGraphics()
  let defs
  if (m === 'solo') {
    localPid = 1
    defs = [{ id: 1, name: 'P1', color: 0x2f80ff, bot: false, role: 'host' }]
    for (let i = 0; i < botCount; i++) defs.push({ id: 1000 + i, name: BOT_NAMES[i % BOT_NAMES.length], color: BOT_COLORS[i % BOT_COLORS.length], bot: true })
  } else if (m === 'host') {
    defs = currentDefs()
  } else {
    defs = defsArg
  }
  sim = new Sim(m === 'guest' ? 'guest' : 'host', makeHooks(), 1337)
  sim.myPid = localPid
  window.__sim = sim
  sim.startMatch(defs)
  syncAvatars(defs)
  // clear old view objects
  for (const [, mesh] of wallMeshes) scene.remove(mesh)
  wallMeshes.clear()
  for (const [, mesh] of lootMeshes) scene.remove(mesh)
  lootMeshes.clear()
  for (const l of sim.loots) addLootMesh(l, true)
  for (const [, prop] of propById) { prop.hp = prop.maxHp; if (prop._mesh) prop._mesh.visible = true }
  // restore instanced props visibility by rebuilding scene props is heavy; instead full rebuild of instanced is skip — world persists between matches (single match per page load anyway)
  buildCraftList()
  $('dropHint').style.display = 'block'
  $('over').style.display = 'none'
  $('alivePill').textContent = `🧍 ${defs.length} alive`
  if (m === 'host' && room) {
    room.sendNow('start', { defs })
    $('lobby').style.display = 'none'
  }
  if (m === 'guest') { /* waiting UI hidden */ }
  gameOn = true
  if (!loopRunning) { loopRunning = true; requestAnimationFrame(loop) }
  feed(`🪂 <b>${defs.length}</b> players dropped in — good luck!`)
}
let loopRunning = false

/* ================= input ================= */
function bindInput() {
  // joystick
  const joyEl = $('joy'), knob = $('joyKnob')
  const R = 52
  const move = e => {
    const r = joyEl.getBoundingClientRect()
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2)
    const len = Math.hypot(dx, dy) || 1, max = r.width / 2
    const cl = Math.min(len, max)
    dx = dx / len * cl; dy = dy / len * cl
    knob.style.transform = `translate(${dx}px,${dy}px)`
    joy.x = dx / max; joy.y = dy / max
  }
  joyEl.addEventListener('pointerdown', e => { joy.id = e.pointerId; joyEl.setPointerCapture(e.pointerId); move(e) })
  joyEl.addEventListener('pointermove', e => { if (e.pointerId === joy.id) move(e) })
  const endJoy = e => { if (e.pointerId === joy.id) { joy.id = null; joy.x = joy.y = 0; knob.style.transform = '' } }
  joyEl.addEventListener('pointerup', endJoy); joyEl.addEventListener('pointercancel', endJoy)

  // look drag on canvas
  canvas.addEventListener('pointerdown', e => {
    lookPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
    try { canvas.setPointerCapture(e.pointerId) } catch {}
  })
  canvas.addEventListener('pointermove', e => {
    const lp = lookPtrs.get(e.pointerId); if (!lp || !sim) return
    const dx = e.clientX - lp.x, dy = e.clientY - lp.y
    lp.x = e.clientX; lp.y = e.clientY
    const p = sim.player(localPid)
    if (!p) return
    p.camYaw -= dx * 0.0052
    p.camPitch = clamp(p.camPitch + dy * 0.004, -0.35, 0.9)
  })
  const endLook = e => lookPtrs.delete(e.pointerId)
  canvas.addEventListener('pointerup', endLook); canvas.addEventListener('pointercancel', endLook)

  // action buttons
  const holdBtn = (el, down, up) => {
    el.addEventListener('pointerdown', e => { e.preventDefault(); down() })
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('pointerleave', up)
  }
  holdBtn($('btnFire'), () => {
    if (buildMode) { inputState.placeEdge = true } else inputState.fire = true
  }, () => { inputState.fire = false })
  holdBtn($('btnJump'), () => { inputState.jumpEdge = true }, () => {})
  $('btnBuild').onclick = () => toggleBuild()
  $('btnPick').onclick = () => togglePick()
  $('btnCraft').onclick = () => toggleCraft()
  const mutePill = $('mutePill')
  if (mutePill) mutePill.onclick = () => setSound(!soundOn)
  $('btnCloseBuild').onclick = () => toggleBuild(false)
  $('btnCloseCraft').onclick = () => toggleCraft(false)
  $('buildBar').onclick = e => {
    const b = e.target.closest('.bbtn'); if (!b) return
    if (b.dataset.piece) { piece = b.dataset.piece; refreshBuildBar() }
    else if (b.dataset.mat) { matKey = b.dataset.mat; refreshBuildBar() }
  }
  // desktop keys
  addEventListener('keydown', e => {
    keys[e.code] = true
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault()
    if (e.code === 'Space') inputState.jumpEdge = true
    if (e.code === 'KeyF') inputState.fire = true
    if (e.code === 'KeyG') toggleBuild()
    if (e.code === 'KeyQ') togglePick()
    if (e.code === 'KeyV') toggleCraft()
    if (e.code === 'Digit1') { piece = 'wall'; refreshBuildBar() }
    if (e.code === 'Digit2') { piece = 'ramp'; refreshBuildBar() }
    if (e.code === 'Digit3') { piece = 'floor'; refreshBuildBar() }
    if (e.code === 'KeyZ') { matKey = 'wood'; refreshBuildBar() }
    if (e.code === 'KeyX') { matKey = 'brick'; refreshBuildBar() }
    if (e.code === 'KeyC') { matKey = 'metal'; refreshBuildBar() }
  })
  addEventListener('keyup', e => { keys[e.code] = false; if (e.code === 'KeyF') inputState.fire = false })
}
function toggleBuild(force) {
  buildMode = force === undefined ? !buildMode : force
  if (buildMode) { pickMode = false; $('btnPick').classList.remove('on') }
  $('btnBuild').classList.toggle('on', buildMode)
  $('buildBar').classList.toggle('show', buildMode)
  $('btnFire').textContent = buildMode ? 'PLACE' : 'FIRE'
  $('btnFire').classList.toggle('place', buildMode)
  if (ghost) { ghost.visible = buildMode; }
  refreshBuildBar()
}
function togglePick(force) {
  pickMode = force === undefined ? !pickMode : force
  if (pickMode) { buildMode = false; toggleBuild(false) }
  $('btnPick').classList.toggle('on', pickMode)
  for (const [, av] of avatars) { av.gun.visible = !pickMode; if (av.pick) av.pick.visible = pickMode }
}
function toggleCraft(force) {
  craftOpen = force === undefined ? !craftOpen : force
  $('craftPanel').classList.toggle('show', craftOpen)
  if (craftOpen) refreshCraftList()
}
function refreshBuildBar() {
  $('buildBar').querySelectorAll('[data-piece]').forEach(b => b.classList.toggle('active', b.dataset.piece === piece))
  $('buildBar').querySelectorAll('[data-mat]').forEach(b => b.classList.toggle('active', b.dataset.mat === matKey))
  if (ghost) ghost.userData.piece = piece
}
function buildCraftList() {
  const list = $('recipeList')
  list.innerHTML = ''
  for (const r of RECIPES) {
    const el = document.createElement('div')
    el.className = 'recipe'
    el.innerHTML = `<div class="ricon">${r.icon}</div>
      <div class="rinfo"><div class="rname">${r.name}</div><div class="rdesc">${r.desc}</div>
      <div class="rcost" id="cost-${r.id}"></div></div>
      <button class="btn" data-r="${r.id}">CRAFT</button>`
    el.querySelector('button').onclick = () => { inputState.craftReq = r.id; toggleCraft(false) }
    list.appendChild(el)
  }
}
function refreshCraftList() {
  const p = sim && sim.player(localPid)
  if (!p) return
  for (const r of RECIPES) {
    const el = $(`cost-${r.id}`)
    if (!el) continue
    const parts = MAT_KEYS.filter(k => r.cost[k]).map(k => {
      const ok = (p.mats[k] || 0) >= r.cost[k]
      return `<span class="${ok ? 'ok' : 'no'}">${MATS[k].icon}${r.cost[k]}</span>`
    })
    el.innerHTML = parts.join(' ')
  }
  const prog = $('craftProgress')
  if (p.craft && p.craft.remain > 0) {
    prog.classList.add('show')
    prog.firstElementChild.style.width = (100 * (1 - p.craft.remain / p.craft.total)) + '%'
  } else if (sim.mode === 'guest' && p.hasCraft) {
    prog.classList.add('show')
    prog.firstElementChild.style.width = '50%'
  } else prog.classList.remove('show')
}
function gatherInput() {
  const p = sim && sim.player(localPid)
  if (!p) return lastInput
  let mx = 0, mz = 0
  if (keys['KeyW']) mz += 1
  if (keys['KeyS']) mz -= 1
  if (keys['KeyA']) mx -= 1
  if (keys['KeyD']) mx += 1
  mx += joy.x; mz += -joy.y
  const len = Math.hypot(mx, mz)
  if (len > 1) { mx /= len; mz /= len }
  const inp = {
    mv: [mx, mz],
    yaw: p.camYaw, pitch: p.camPitch,
    fire: inputState.fire && !buildMode && !pickMode,
    jump: inputState.jumpEdge || !!keys['Space'],
    swing: (pickMode && (inputState.fire || keys['KeyF'])) ,
    place: inputState.placeEdge || (buildMode && (keys['KeyF'] && !keys.__fPrev)),
    piece, mat: matKey,
    craft: inputState.craftReq,
  }
  inputState.jumpEdge = false
  inputState.placeEdge = false
  inputState.craftReq = null
  keys.__fPrev = !!keys['KeyF']
  lastInput = inp
  return inp
}

/* ================= HUD ================= */
function toast(msg, ms = 2200) {
  const t = document.createElement('div')
  t.className = 'toast'; t.textContent = msg
  $('toasts').appendChild(t)
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s' }, ms - 400)
  setTimeout(() => t.remove(), ms)
}
function feed(html) {
  const d = document.createElement('div')
  d.className = 'feed'; d.innerHTML = html
  $('killfeed').prepend(d)
  while ($('killfeed').children.length > 5) $('killfeed').lastChild.remove()
  setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity .8s' }, 4200)
  setTimeout(() => d.remove(), 5200)
}
let vitalsFlash = 0
function flashVitals() { vitalsFlash = 0.35 }
function updateHUD() {
  if (!sim) return
  const p = sim.player(localPid)
  if (!p) return
  const hp = Math.max(0, Math.round(p.hp)), sh = Math.max(0, Math.round(p.shield))
  $('barHP').style.width = hp + '%'
  $('barHP').style.background = hp > 50 ? 'linear-gradient(180deg,#6cf084,#3fd95b)' : hp > 25 ? 'linear-gradient(180deg,#ffd97a,#f5a623)' : 'linear-gradient(180deg,#ff8a8a,#e03131)'
  $('barSH').firstElementChild.style.width = sh + '%'
  $('hpNums').textContent = `${hp} / 100${sh ? `  +${sh}🛡️` : ''}${p.hop > 0 ? '  ☄️' : ''}`
  $('pname').innerHTML = `${p.alive ? '' : '💀 '}<span style="color:#ffe9a8">${p.name}</span> ${p.alive ? '' : '<span style="opacity:.7">(spectating)</span>'}`
  $('mWood').textContent = p.mats.wood | 0
  $('mBrick').textContent = p.mats.brick | 0
  $('mMetal').textContent = p.mats.metal | 0
  const w = WEAPONS[p.weapon], t = TIERS[p.tier]
  $('wName').textContent = (pickMode ? '⛏ Pickaxe' : w.name)
  $('wTier').textContent = pickMode ? 'HARVEST' : t.name.toUpperCase()
  $('wTier').style.color = pickMode ? '#cfd6e4' : t.css
  $('weaponCard').style.borderColor = pickMode ? '#8892a4' : t.css
  $('wStat').textContent = pickMode ? 'hit trees/rocks/metal' : `dmg ${Math.round(w.dmg * t.mult)}${w.pellets > 1 ? '×' + w.pellets : ''}${w.auto ? ' · auto' : ''}`
  const alive = sim.players.filter(x => x.alive).length
  $('alivePill').textContent = `🧍 ${alive} alive`
  const s = sim.storm
  const zp = $('zonePill')
  if (s.mode === 'shrink') { zp.textContent = `⚠️ Zone ${s.phase} moving!`; zp.classList.add('warn') }
  else { zp.textContent = `⭕ Zone ${s.phase + 1} in ${Math.ceil(s.timer)}s`; zp.classList.remove('warn') }
  // storm vignette
  const outside = p.alive && Math.hypot(p.x - s.cx, p.z - s.cz) > s.r
  $('stormVignette').style.opacity = outside ? '1' : '0'
  // drop hint
  $('dropHint').style.display = p.state === 'drop' ? 'block' : 'none'
  // craft costs in build bar
  $('costWood').textContent = p.mats.wood | 0
  $('costBrick').textContent = p.mats.brick | 0
  $('costMetal').textContent = p.mats.metal | 0
  if (craftOpen) refreshCraftList()
}
const mmCtx = $('minimap').getContext('2d')
function drawMinimap() {
  if (!sim) return
  const S = 220, g = mmCtx
  g.clearRect(0, 0, S, S)
  g.fillStyle = '#12351f'; g.fillRect(0, 0, S, S)
  const sc = v => (v / (PLAY_R * 2.3) + 0.5) * S
  const s = sim.storm
  g.strokeStyle = 'rgba(185,164,255,.95)'; g.lineWidth = 7
  g.beginPath(); g.arc(sc(s.cx), sc(s.cz), Math.max(2, s.r / (PLAY_R * 2.3) * S), 0, 7); g.stroke()
  g.strokeStyle = '#ffffff'; g.lineWidth = 2.5
  g.beginPath(); g.arc(sc(s.cx), sc(s.cz), Math.max(2, s.r / (PLAY_R * 2.3) * S), 0, 7); g.stroke()
  for (const p of sim.players) {
    if (!p.alive) continue
    const self = p.id === localPid
    g.fillStyle = self ? '#ffffff' : p.bot ? '#ff8a8a' : '#ffb02e'
    g.beginPath(); g.arc(sc(p.x), sc(p.z), self ? 6 : 5, 0, 7); g.fill()
    if (self) {
      g.strokeStyle = '#ffffff'; g.lineWidth = 2
      g.beginPath(); g.moveTo(sc(p.x), sc(p.z))
      g.lineTo(sc(p.x + Math.sin(p.camYaw) * 6), sc(p.z + Math.cos(p.camYaw) * 6)); g.stroke()
    }
  }
}

/* ================= game over ================= */
function showOver(winner) {
  if (!$('over') || $('over').style.display === 'flex') return
  const t = $('overTitle'), s = $('overSub')
  const won = winner && winner.id === localPid
  if (winner && !winner.bot) {
    t.textContent = '#1 VICTORY ROYALE!'; t.className = 'win'
    s.innerHTML = `👑 <b>${winner.name}</b> takes the crown!`
    if (won) sndWin()
  } else if (winner) {
    t.textContent = `${winner.name} wins`; t.className = ''
    s.innerHTML = winner.bot ? 'The bots got this one. Try again!' : `Winner: <b>${winner.name}</b>`
  } else { t.textContent = 'DRAW'; t.className = ''; s.textContent = 'Everyone fell to the storm.' }
  const rows = [...sim.players].sort((a, b) => (b.alive - a.alive) || (b.kills - a.kills) || (a.hp - b.hp))
    .map((p, i) => `<div class="${p.id === localPid ? 'you' : ''}">${i === 0 ? '👑' : '#' + (i + 1)} ${p.name}${p.bot ? ' 🤖' : ''} — ${p.kills} elim${p.kills === 1 ? '' : 's'} ${p.alive ? '· ALIVE' : ''}</div>`).join('')
  $('standings').innerHTML = rows
  $('over').style.display = 'flex'
  gameOn = false
}

/* ================= camera & render ================= */
const camTmp = { pos: new THREE.Vector3(), look: new THREE.Vector3() }
const headV = new THREE.Vector3(), dirV = new THREE.Vector3()
const camRay = new THREE.Raycaster()
function renderFrame(dt) {
  const p = sim.player(localPid)
  let target = p && p.alive ? p : null
  if (!target) target = sim.players.find(x => x.alive) || p
  if (!target) return
  const rx = target.rx ?? target.x, ry = target.ry ?? target.y, rz = target.rz ?? target.z
  const dropping = target.state === 'drop'
  const pitch = dropping ? Math.max(0.75, target.camPitch) : target.camPitch
  const dist = dropping ? 10 : 6.9
  const h = dropping ? 2.2 : 3.3
  const fx_ = Math.sin(target.camYaw), fz_ = Math.cos(target.camYaw)
  camTmp.pos.set(rx - fx_ * dist * Math.cos(pitch), ry + h + Math.sin(pitch) * dist, rz - fz_ * dist * Math.cos(pitch))
  camTmp.look.set(rx + fx_ * 4, ry + 1.75, rz + fz_ * 4)
  // camera collision
  headV.set(rx, ry + 2.0, rz)
  dirV.copy(camTmp.pos).sub(headV)
  const cdist = dirV.length()
  if (cdist > 0.01 && worldView) {
    dirV.divideScalar(cdist)
    camRay.set(headV, dirV); camRay.far = cdist
    const hits = camRay.intersectObjects(worldView.occluders, false)
    if (hits.length) camTmp.pos.copy(headV).addScaledVector(dirV, Math.max(1.5, hits[0].distance - 0.55))
  }
  camera.position.copy(camTmp.pos)
  camera.lookAt(camTmp.look)
  if (composer) composer.render(); else renderer.render(scene, camera)
}

/* ================= ghost preview ================= */
function updateGhost() {
  const p = sim && sim.player(localPid)
  if (!p || !ghost) return
  if (!buildMode || !p.alive || p.state !== 'play') { ghost.visible = false; return }
  const spot = sim.buildSpot(p, piece)
  if (!spot) { ghost.visible = false; return }
  ghost.visible = true
  ghost.position.set(spot.x, spot.base + (piece === 'wall' ? 1.6 : piece === 'floor' ? 0.13 : 1.6), spot.z)
  ghost.rotation.order = 'YXZ'
  ghost.rotation.set(0, 0, 0)
  if (piece === 'wall') ghost.rotation.y = Math.abs(Math.sin(spot.yaw)) > 0.5 ? Math.PI / 2 : 0
  else if (piece === 'ramp') { ghost.rotation.y = spot.yaw; ghost.rotation.x = -Math.atan2(3.2, 4) }
  const canAfford = (p.mats[matKey] || 0) >= BUILD[piece].cost
  setGhostValid(ghost, canAfford && !spot.occupied, matKey)
}

/* ================= main loop ================= */
let lastT = performance.now()
function loop(now) {
  requestAnimationFrame(loop)
  const dt = Math.min(0.05, (now - lastT) / 1000)
  lastT = now
  if (!sim || !renderer) return
  elapsed += dt
  const inp = gatherInput()

  if (gameOn) {
    if (sim.mode === 'host') {
      sim.setLocalInput(localPid, inp)
      sim.step(dt)
      // snapshots
      snapAcc += dt
      if (room && snapAcc >= 1 / 20) { snapAcc = 0; room.sendNow('snap', sim.buildSnapshot()) }
      else if (!room && snapAcc >= 1 / 20) snapAcc = 0
    } else {
      // guest
      sim.guestStep(dt, inp)
      inputAcc += dt
      if (inputAcc >= INPUT_RATE) { inputAcc = 0; if (room) room.send('input', { ...inp, mv: [+inp.mv[0].toFixed(2), +inp.mv[1].toFixed(2)], yaw: +inp.yaw.toFixed(3), pitch: +inp.pitch.toFixed(3) }) }
      // predicted local shot visuals
      const p = sim.player(localPid)
      myPredCd -= dt
      if (p && p.alive && p.state === 'play' && inp.fire && !buildMode && !pickMode) {
        const w = WEAPONS[p.weapon]
        if (myPredCd <= 0) {
          myPredCd = w.cd
          const sy = Math.sin(p.camYaw), cy = Math.cos(p.camYaw)
          const cp = Math.cos(p.camPitch)
          const o = [p.x + sy * 0.9, p.y + 1.55, p.z + cy * 0.9]
          const dir = [Math.sin(p.camYaw) * Math.cos(p.camPitch), -Math.sin(p.camPitch), Math.cos(p.camYaw) * Math.cos(p.camPitch)]
          const hit = viewRaycast(o, dir, w.range, localPid)
          const e = hit ? hit.point : [o[0] + dir[0] * w.range, o[1] + dir[1] * w.range, o[2] + dir[2] * w.range]
          fx.tracer(new THREE.Vector3(...o), new THREE.Vector3(...e), w.tracer)
          fx.muzzle(new THREE.Vector3(...o))
          sndShoot(p.weapon)
        }
      }
      if (inp.swing) { const a = avatars.get(localPid); if (a && a.swingT <= 0) a.swingT = 0.2 }
    }
  }

  // render positions: smoothing for remote, direct for local
  for (const [pid, av] of avatars) {
    const p = sim.player(pid)
    if (!p) continue
    let tx = p.x, ty = p.y, tz = p.z
    if (pid === localPid && sim.mode === 'guest' && p.pred.init) { tx = p.pred.x; ty = p.pred.y; tz = p.pred.z }
    if (!p.render.init) { p.rx = tx; p.ry = ty; p.rz = tz; p.render.init = true }
    const k = pid === localPid ? 1 : Math.min(1, dt * 14)
    p.rx = (p.rx ?? tx) + (tx - (p.rx ?? tx)) * k
    p.ry = (p.ry ?? ty) + (ty - (p.ry ?? ty)) * (pid === localPid ? 1 : Math.min(1, dt * 10))
    p.rz = (p.rz ?? tz) + (tz - (p.rz ?? tz)) * k
    av.group.position.set(p.rx, p.ry, p.rz)
    if (!p.alive) {
      av.group.rotation.z = -Math.PI / 2
      av.group.position.y = p.ry + 0.35
    } else {
      av.group.rotation.z = 0
      av.group.rotation.y = (p.state === 'play' && (p.aiming || p.bot && p.moving)) ? p.camYaw : p.yaw
    }
    av.swingT = (av.swingT || 0) - dt
    if (av.swingT > 0) { av.armR.rotation.x = -1.6 + Math.sin(av.swingT * 30) * 0.7 }
    else av.updateAnim(dt, p.moving && p.state === 'play', !!p.aiming || (p.bot && p.state === 'play'), p.gliding)
    // hop rock glow
    if (av.glow) av.glow.material.opacity = p.hop > 0 ? 0.5 + Math.sin(elapsed * 6) * 0.2 : 0
  }

  // loots bob
  for (const [id, m] of lootMeshes) {
    m.position.y = 0.95 + Math.sin(elapsed * 2 + m.userData.bob) * 0.16
    m.rotation.y += dt * 1.4
  }
  // storm visuals
  const s = sim.storm
  if (worldView.stormMesh) {
    worldView.stormMesh.position.x = s.cx
    worldView.stormMesh.position.z = s.cz
    worldView.stormMesh.scale.set(Math.max(0.5, s.r), 1, Math.max(0.5, s.r))
    worldView.stormMesh.material.uniforms.t.value = elapsed
    worldView.stormRing.position.x = s.cx
    worldView.stormRing.position.z = s.cz
    worldView.stormRing.scale.setScalar(Math.max(0.5, s.r))
  }

  updateGhost()
  fx.update(dt)
  // world update (sun, water, clouds, fog)
  const focusP = sim.player(localPid)
  worldView.update(dt, { x: focusP ? focusP.x : 0, y: 0, z: focusP ? focusP.z : 0 }, elapsed, focusP && Math.hypot(focusP.x - s.cx, focusP.z - s.cz) > s.r)

  hudAcc += dt
  if (hudAcc > 0.12) { hudAcc = 0; updateHUD(); drawMinimap() }
  if (vitalsFlash > 0) { vitalsFlash -= dt; $('vitals').style.filter = vitalsFlash > 0 ? 'brightness(1.6) saturate(1.4)' : '' }

  renderFrame(dt)
}

/* ================= boot ================= */
initMenu()
bindInput()
