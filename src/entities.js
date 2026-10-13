// View entities: avatars, loot, chests, build ghosts, effects (tracers, damage numbers…)
import * as THREE from 'three'
import { WEAPONS, TIERS, MATS } from './config.js'
import { GLOW } from './world.js'

export function tagSprite(text, cssColor = '#ffffff', sub = '') {
  const c = document.createElement('canvas'); c.width = 320; c.height = 84
  const g = c.getContext('2d')
  g.font = 'bold 40px Arial'
  const w = Math.min(300, g.measureText(text).width + 34)
  g.fillStyle = 'rgba(8,10,24,0.62)'
  g.beginPath(); g.roundRect(160 - w / 2, 8, w, 50, 12); g.fill()
  if (sub) { g.fillStyle = 'rgba(8,10,24,0.5)'; g.beginPath(); g.roundRect(120, 54, 80, 26, 8); g.fill(); }
  g.fillStyle = cssColor; g.textAlign = 'center'; g.fillText(text, 160, 43)
  if (sub) { g.font = 'bold 19px Arial'; g.fillStyle = '#ffe9a8'; g.fillText(sub, 160, 72) }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }))
  s.scale.set(2.6, 0.68, 1)
  s.renderOrder = 999
  return s
}

export function buildAvatar(colorHex, name, isLocal) {
  const g = new THREE.Group()
  const cloth = new THREE.MeshLambertMaterial({ color: colorHex })
  const cloth2 = new THREE.MeshLambertMaterial({ color: new THREE.Color(colorHex).multiplyScalar(0.75) })
  const skin = new THREE.MeshLambertMaterial({ color: 0xf3c99b })
  const dark = new THREE.MeshLambertMaterial({ color: 0x2b3040 })

  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.86, 0.36), dark)
  const legR = legL.clone()
  legL.geometry.translate(0, -0.43, 0); legR.geometry = legL.geometry.clone()
  legL.position.set(-0.2, 0.86, 0); legR.position.set(0.2, 0.86, 0)
  g.add(legL, legR)

  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.3, 0.44), cloth2)
  hips.position.y = 0.98; g.add(hips)
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.78, 0.5), cloth)
  torso.position.y = 1.5; g.add(torso)
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.22), cloth2)
  pack.position.set(0, 1.5, -0.34); g.add(pack)

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 12), skin)
  head.position.y = 2.12; g.add(head)
  // face
  const face = document.createElement('canvas'); face.width = face.height = 64
  const fg = face.getContext('2d')
  fg.fillStyle = '#22262e'
  fg.beginPath(); fg.ellipse(22, 26, 5, 6.5, 0, 0, 7); fg.fill()
  fg.beginPath(); fg.ellipse(42, 26, 5, 6.5, 0, 0, 7); fg.fill()
  fg.strokeStyle = '#22262e'; fg.lineWidth = 3; fg.lineCap = 'round'
  fg.beginPath(); fg.arc(32, 36, 11, 0.25, Math.PI - 0.25); fg.stroke()
  const faceTex = new THREE.CanvasTexture(face); faceTex.colorSpace = THREE.SRGBColorSpace
  const faceMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), new THREE.MeshLambertMaterial({ map: faceTex, transparent: true }))
  faceMesh.position.set(0, 2.12, 0.315); g.add(faceMesh)

  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.36, 12, 8, 0, Math.PI * 2, 0, 1.35), cloth2)
  cap.position.y = 2.2; g.add(cap)

  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.72, 0.24), cloth)
  const armR = armL.clone()
  armL.geometry = armL.geometry.clone(); armL.geometry.translate(0, -0.3, 0)
  armR.geometry = armL.geometry.clone()
  armL.position.set(-0.55, 1.78, 0); armR.position.set(0.55, 1.78, 0.12)
  g.add(armL, armR)

  // gun in right hand
  const gun = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, 0.9), dark)
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.5, 7), dark)
  barrel.rotation.x = Math.PI / 2; barrel.position.z = 0.62
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.26, 0.16), new THREE.MeshLambertMaterial({ color: 0x444c5e }))
  mag.position.set(0, -0.18, 0.1)
  gun.add(body, barrel, mag)
  gun.position.set(0.55, 1.5, 0.5)
  g.add(gun)

  const sh = new THREE.Mesh(new THREE.CircleGeometry(0.7, 18),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }))
  sh.rotation.x = -Math.PI / 2; sh.position.y = 0.04; g.add(sh)

  const tag = tagSprite(name, isLocal ? '#ffe9a8' : '#ffffff')
  tag.position.y = 2.95; g.add(tag)

  const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 2.4, 8), new THREE.MeshBasicMaterial({ visible: false }))
  hit.position.y = 1.2; g.add(hit)
  const headHit = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 8), new THREE.MeshBasicMaterial({ visible: false }))
  headHit.position.y = 2.12; g.add(headHit)

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: isLocal ? GLOW.white : GLOW.purple, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }))
  glow.scale.set(3.4, 3.4, 1); glow.position.y = 1.4; g.add(glow)

  g.traverse(o => { if (o.isMesh && !o.material.visible === false) o.castShadow = false })

  const anim = { t: 0 }
  const updateAnim = (dt, moving, aiming, gliding) => {
    anim.t += dt * (moving ? 9 : 2.2)
    const sw = Math.sin(anim.t) * (moving ? 0.7 : 0.08)
    legL.rotation.x = sw; legR.rotation.x = -sw
    armL.rotation.x = -sw * 0.8
    armR.rotation.x = aiming ? -1.15 : -sw * 0.5
    gun.position.y = 1.5 + (aiming ? 0 : Math.sin(anim.t * 0.5) * 0.05)
    if (gliding) { armL.rotation.z = 1.15; armR.rotation.z = -1.15 } else { armL.rotation.z = 0.06; armR.rotation.z = -0.06 }
  }
  return { group: g, gun, hit, headHit, tag, legs: [legL, legR], armL, armR, updateAnim, faceMesh }
}

/* ---------------- loot ---------------- */
export function lootMesh(kind, weaponType, tier) {
  const g = new THREE.Group()
  if (kind === 'weapon') {
    const w = WEAPONS[weaponType]
    const t = TIERS[tier]
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.28, 0.3), new THREE.MeshLambertMaterial({ color: 0x232a36 }))
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.36), new THREE.MeshBasicMaterial({ color: t.color }))
    tip.position.x = 0.72
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.3, 0.16), new THREE.MeshLambertMaterial({ color: 0x3a4256 }))
    mag.position.y = -0.24
    g.add(b, tip, mag)
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.07, 8, 22), new THREE.MeshBasicMaterial({ color: t.color }))
    ring.rotation.x = Math.PI / 2; ring.position.y = -0.35
    g.add(ring)
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: t.id >= 3 ? GLOW.purple : t.id === 2 ? GLOW.blue : GLOW.gold, transparent: true, opacity: 0.75, depthWrite: false }))
    glow.scale.set(2.6, 2.6, 1)
    g.add(glow)
    g.userData.tier = tier; g.userData.wname = w.name
  } else if (kind === 'shield') {
    const b = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 0), new THREE.MeshBasicMaterial({ color: 0x3fa9ff }))
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW.blue, transparent: true, opacity: 0.8, depthWrite: false }))
    glow.scale.set(2.2, 2.2, 1)
    g.add(b, glow)
  } else if (kind === 'hop') {
    const b = new THREE.Mesh(new THREE.DodecahedronGeometry(0.42, 0), new THREE.MeshLambertMaterial({ color: 0x8b4dff, emissive: 0x6a24f0, emissiveIntensity: 1.2 }))
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW.purple, transparent: true, opacity: 0.9, depthWrite: false }))
    glow.scale.set(2.4, 2.4, 1)
    g.add(b, glow)
  } else { // med
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.46, 0.66), new THREE.MeshLambertMaterial({ color: 0xf5f5f5 }))
    const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.14, 0.1), new THREE.MeshBasicMaterial({ color: 0xe03131 }))
    const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.46, 0.1), new THREE.MeshBasicMaterial({ color: 0xe03131 }))
    c1.position.y = 0.24; c2.position.y = 0.24
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW.white, transparent: true, opacity: 0.5, depthWrite: false }))
    glow.scale.set(1.8, 1.8, 1)
    g.add(b, c1, c2, glow)
  }
  return g
}

export function chestMesh() {
  const g = new THREE.Group()
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.85, 1.05), new THREE.MeshLambertMaterial({ color: 0x9a641f }))
  base.position.y = 0.45
  const lid = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.45, 1.05), new THREE.MeshLambertMaterial({ color: 0xd9a02a, emissive: 0x6b4a00, emissiveIntensity: 0.5 }))
  lid.position.y = 1.1
  lid.geometry.translate(0, 0, 0.52); lid.position.z = -0.52   // hinge at back
  const band = new THREE.Mesh(new THREE.BoxGeometry(1.54, 0.2, 1.09), new THREE.MeshLambertMaterial({ color: 0xffe08a, emissive: 0x8a6a10, emissiveIntensity: 0.6 }))
  band.position.y = 0.9
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW.gold, transparent: true, opacity: 0.85, depthWrite: false }))
  glow.scale.set(3.4, 3.4, 1); glow.position.y = 1.4
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.5, 5.5, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }))
  beam.position.y = 3.4
  g.add(base, lid, band, glow, beam)
  return { group: g, lid, glow, beam }
}

/* ---------------- build ghost ---------------- */
export function ghostMesh(piece, matKey) {
  const mat = MATS[matKey]
  let geo
  if (piece === 'wall') geo = new THREE.BoxGeometry(4, 3.2, 0.28)
  else if (piece === 'floor') geo = new THREE.BoxGeometry(4, 0.24, 4)
  else geo = new THREE.BoxGeometry(4, 0.3, 4.6)   // ramp slab (angled below)
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: mat.color, transparent: true, opacity: 0.42, depthWrite: false }))
  if (piece === 'ramp') { m.rotation.x = -Math.atan2(3.2, 4); }
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }))
  m.add(edges)
  m.userData.piece = piece
  return m
}
export function setGhostValid(mesh, valid, matKey) {
  const col = valid ? MATS[matKey].color : 0xff3b3b
  mesh.material.color.setHex(col)
}

/* ---------------- FX ---------------- */
export class FX {
  constructor(scene) {
    this.scene = scene
    this.items = []
    this.numbers = []
  }
  tracer(a, b, color = 0xffe14d) {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b])
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }))
    this.scene.add(line)
    this.items.push({ obj: line, life: 0.1, total: 0.1, kind: 'fade' })
  }
  spark(pos, color = 0xffe14d, size = 0.3) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW.gold, color, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending }))
    s.position.copy(pos); s.scale.set(size * 3, size * 3, 1)
    this.scene.add(s)
    this.items.push({ obj: s, life: 0.16, total: 0.16, kind: 'pop' })
  }
  muzzle(pos) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW.gold, color: 0xfff2a8, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending }))
    s.position.copy(pos); s.scale.set(1.5, 1.5, 1)
    this.scene.add(s)
    this.items.push({ obj: s, life: 0.07, total: 0.07, kind: 'pop' })
  }
  debris(pos, color, n = 8) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.22), new THREE.MeshLambertMaterial({ color }))
      m.position.copy(pos)
      this.scene.add(m)
      this.items.push({
        obj: m, life: 0.7, total: 0.7, kind: 'phys',
        vel: new THREE.Vector3((Math.random() - 0.5) * 7, 3 + Math.random() * 5, (Math.random() - 0.5) * 7),
        spin: new THREE.Vector3(Math.random() * 8, Math.random() * 8, 0),
      })
    }
  }
  damageNum(pos, text, color = '#ffffff') {
    const c = document.createElement('canvas'); c.width = 256; c.height = 96
    const g = c.getContext('2d')
    g.font = 'bold 66px Arial Black, Arial'
    g.textAlign = 'center'
    g.lineWidth = 9; g.strokeStyle = 'rgba(0,0,0,0.85)'
    g.strokeText(text, 128, 72)
    g.fillStyle = color
    g.fillText(text, 128, 72)
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }))
    s.position.copy(pos)
    s.position.x += (Math.random() - 0.5) * 0.8
    s.scale.set(2.4, 0.9, 1)
    s.renderOrder = 998
    this.scene.add(s)
    this.numbers.push({ obj: s, life: 0.9, total: 0.9 })
  }
  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]
      it.life -= dt
      const k = Math.max(0, it.life / it.total)
      if (it.kind === 'fade') it.obj.material.opacity = k
      else if (it.kind === 'pop') { it.obj.material.opacity = k; it.obj.scale.multiplyScalar(1 + dt * 3) }
      else if (it.kind === 'phys') {
        it.vel.y -= 26 * dt
        it.obj.position.addScaledVector(it.vel, dt)
        it.obj.rotation.x += it.spin.x * dt; it.obj.rotation.y += it.spin.y * dt
        if (it.obj.position.y < 0.1) { it.obj.position.y = 0.1; it.vel.multiplyScalar(0.4); it.vel.y = Math.abs(it.vel.y) * 0.35 }
        it.obj.scale.setScalar(k)
      }
      if (it.life <= 0) {
        this.scene.remove(it.obj)
        if (it.obj.geometry) it.obj.geometry.dispose()
        if (it.obj.material) it.obj.material.dispose()
        this.items.splice(i, 1)
      }
    }
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i]
      n.life -= dt
      n.obj.position.y += dt * 1.6
      const k = n.life / n.total
      n.obj.material.opacity = Math.min(1, k * 2.4)
      n.obj.material.color.setScalar(0.6 + 0.4 * k)
      if (n.life <= 0) {
        this.scene.remove(n.obj)
        n.obj.material.map.dispose(); n.obj.material.dispose()
        this.numbers.splice(i, 1)
      }
    }
  }
}
