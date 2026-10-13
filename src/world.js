// World generation + Fortnite-style graphics. Deterministic (seeded) so host & guest match.
import * as THREE from 'three'

export const mulberry32 = a => () => {
  a |= 0; a = a + 0x6D2B79F5 | 0
  let t = Math.imul(a ^ a >>> 15, 1 | a)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

// ---------- terrain height function (pure, shared) ----------
const hash2 = (x, y) => {
  let h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return h - Math.floor(h)
}
const smooth = t => t * t * (3 - 2 * t)
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y)
  const xf = x - xi, yf = y - yi
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1)
  const u = smooth(xf), v = smooth(yf)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}
const CRATER = { x: -170, z: 150, r: 42 }
export const heightAt = (x, z) => {
  const d = Math.hypot(x, z)
  const edge = Math.max(0, Math.min(1, (360 - d) / 80))   // fade to beach at rim
  let h = (vnoise(x * 0.022, z * 0.022) - 0.45) * 9 + (vnoise(x * 0.07, z * 0.07) - 0.5) * 2.6
  h = Math.max(0, h) * edge + 0.15 * edge
  // meteor crater
  const cd = Math.hypot(x - CRATER.x, z - CRATER.z)
  if (cd < CRATER.r) h -= (1 - cd / CRATER.r) * 3.4
  return Math.max(0, h)
}

// ---------- pure world data (identical on both devices) ----------
export function generateWorldData(seed = 1337) {
  const rnd = mulberry32(seed)
  const props = []
  const houses = []
  const chests = []
  const lootSpots = []
  const circles = []   // {x,z,r}
  const boxes = []     // {x,z,hw,hd,yaw}
  let pid = 1

  // spatial grid so free() stays O(1) even with thousands of props
  const CELL = 24, grid = new Map()
  const gkey = (cx, cz) => cx * 100000 + cz
  const addGrid = (x, z, r, foot) => {
    const f = foot === undefined ? r : foot
    const x0 = Math.floor((x - f) / CELL), x1 = Math.floor((x + f) / CELL)
    const z0 = Math.floor((z - f) / CELL), z1 = Math.floor((z + f) / CELL)
    for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
      const k = gkey(gx, gz); let arr = grid.get(k); if (!arr) grid.set(k, arr = []); arr.push({ x, z, r })
    }
  }
  const free = (x, z, pad) => {
    const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL)
    for (let i = gx - 1; i <= gx + 1; i++) for (let j = gz - 1; j <= gz + 1; j++) {
      const arr = grid.get(gkey(i, j)); if (!arr) continue
      for (const c of arr) if ((x - c.x) * (x - c.x) + (z - c.z) * (z - c.z) < (c.r + pad) * (c.r + pad)) return false
    }
    for (const h of houses) if (Math.hypot(x - h.x, z - h.z) < 13 + pad) return false
    if (Math.hypot(x - CRATER.x, z - CRATER.z) < CRATER.r + 4) return false
    return true
  }

  // houses on a ring with door facing center
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2 + rnd() * 0.5
    const dist = 80 + rnd() * 170
    const hx = Math.cos(a) * dist, hz = Math.sin(a) * dist
    const rot = Math.atan2(-hx, -hz) + (rnd() - 0.5) * 0.8   // face-ish center
    const house = { id: 'h' + i, x: hx, z: hz, rot, walls: [] }
    const W = 9, D = 7, T = 3.1
    const seg = (lx, lz, yaw, hw, hd) => {
      const cosr = Math.cos(rot), sinr = Math.sin(rot)
      const wx = hx + lx * cosr - lz * sinr
      const wz = hz + lx * sinr + lz * cosr
      const id = 'p' + (pid++)
      const p = { id, type: 'house', house: house.id, x: wx, z: wz, y: heightAt(wx, wz), yaw: rot + yaw, hw, hd, hh: T / 2, hp: 120, maxHp: 120, give: 'wood', amount: 10, radius: 0, solid: true, meshKind: 'box' }
      props.push(p); house.walls.push(p.id)
      boxes.push({ x: wx, z: wz, hw: hd, hd: hw, yaw: rot + yaw })
      return p
    }
    // back wall (full), front with door gap, sides split into 2 for windows
    seg(0, -D / 2, 0, W / 2, 0.18)
    seg(-W / 4 - 0.6, D / 2, 0, W / 4 - 1.2, 0.18)
    seg(W / 4 + 0.6, D / 2, 0, W / 4 - 1.2, 0.18)
    seg(-W / 2, -D / 4 - 0.4, Math.PI / 2, D / 4 - 0.6, 0.18)
    seg(-W / 2, D / 4 + 0.4, Math.PI / 2, D / 4 - 0.6, 0.18)
    seg(W / 2, -D / 4 - 0.4, Math.PI / 2, D / 4 - 0.6, 0.18)
    seg(W / 2, D / 4 + 0.4, Math.PI / 2, D / 4 - 0.6, 0.18)
    houses.push(house)
    circles.push({ x: hx, z: hz, r: 0.001 })   // blocks other props from centering inside
    chests.push({ id: 'c' + i, x: hx + (rnd() - 0.5) * 3, z: hz + (rnd() - 0.5) * 2 })
    lootSpots.push({ x: hx + (rnd() - 0.5) * 5, z: hz + (rnd() - 0.5) * 4 })
  }

  // trees
  let treeTries = 0, nTree = 0
  while (nTree < 1600 && treeTries++ < 25000) {
    const a = rnd() * Math.PI * 2, d = 40 + rnd() * 290
    const x = Math.cos(a) * d, z = Math.sin(a) * d
    if (!free(x, z, 2.5)) continue
    const s = 0.85 + rnd() * 0.6
    const prop = { id: 'p' + (pid++), type: 'tree', x, z, y: heightAt(x, z), rot: rnd() * 6.28, scale: s, hp: 70, maxHp: 70, give: 'wood', amount: 10, radius: 0.55 * s, solid: true, variant: rnd() < 0.5 ? 0 : 1, tint: rnd() }
    props.push(prop); nTree++
    circles.push({ x, z, r: 0.55 * s, propId: prop.id }); addGrid(x, z, 0.55 * s)
  }
  // rocks
  let nRock = 0
  while (nRock < 500 && treeTries++ < 35000) {
    const a = rnd() * Math.PI * 2, d = 30 + rnd() * 280
    const x = Math.cos(a) * d, z = Math.sin(a) * d
    if (!free(x, z, 2.2)) continue
    const s = 0.8 + rnd() * 1.1
    const prop = { id: 'p' + (pid++), type: 'rock', x, z, y: heightAt(x, z), rot: rnd() * 6.28, scale: s, hp: 90, maxHp: 90, give: 'brick', amount: 9, radius: 1.15 * s, solid: true, variant: 0, tint: rnd() }
    props.push(prop); nRock++
    circles.push({ x, z, r: 1.15 * s, propId: prop.id }); addGrid(x, z, 1.15 * s)
  }
  // metal barrels/crates
  let nMetal = 0
  while (nMetal < 400 && treeTries++ < 45000) {
    const a = rnd() * Math.PI * 2, d = 30 + rnd() * 280
    const x = Math.cos(a) * d, z = Math.sin(a) * d
    if (!free(x, z, 2)) continue
    const prop = { id: 'p' + (pid++), type: 'metal', x, z, y: heightAt(x, z), rot: rnd() * 6.28, scale: 1, hp: 80, maxHp: 80, give: 'metal', amount: 9, radius: 0.8, solid: true, variant: rnd() < 0.5 ? 0 : 1, tint: rnd() }
    props.push(prop); nMetal++
    circles.push({ x, z, r: 0.8, propId: prop.id }); addGrid(x, z, 0.8)
  }
  // wild chests + floor loot
  for (let i = 0, guard = 0; i < 120 && guard++ < 4000; i++) {
    const a = rnd() * Math.PI * 2, d = 40 + rnd() * 260
    const x = Math.cos(a) * d, z = Math.sin(a) * d
    if (!free(x, z, 3)) { i--; continue }
    chests.push({ id: 'c' + (100 + i), x, z })
  }
  for (let i = 0, guard = 0; i < 300 && guard++ < 6000; i++) {
    const a = rnd() * Math.PI * 2, d = 25 + rnd() * 280
    const x = Math.cos(a) * d, z = Math.sin(a) * d
    if (!free(x, z, 2)) { i--; continue }
    lootSpots.push({ x, z })
  }
  // hop rocks at crater
  const hopSpots = []
  for (let i = 0; i < 7; i++) {
    const a = rnd() * Math.PI * 2, d = 2 + rnd() * (CRATER.r - 4)
    hopSpots.push({ x: CRATER.x + Math.cos(a) * d, z: CRATER.z + Math.sin(a) * d })
  }
  return { props, houses, chests, lootSpots, hopSpots, circles, boxes, crater: CRATER }
}

// ---------- textures ----------
function canvasTex(size, draw) {
  const c = document.createElement('canvas'); c.width = c.height = size
  draw(c.getContext('2d'), size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
export const TEX = {}
function makeTextures() {
  TEX.grass = canvasTex(256, (g, s) => {
    g.fillStyle = '#5aa943'; g.fillRect(0, 0, s, s)
    for (let i = 0; i < 2600; i++) {
      const v = Math.random()
      g.fillStyle = v < 0.5 ? `rgba(${60 + Math.random() * 50 | 0},${150 + Math.random() * 60 | 0},${50 + Math.random() * 40 | 0},0.6)`
        : `rgba(${40 + Math.random() * 40 | 0},${120 + Math.random() * 50 | 0},${45 + Math.random() * 35 | 0},0.5)`
      g.fillRect(Math.random() * s, Math.random() * s, 2, 3)
    }
    for (let i = 0; i < 40; i++) { g.fillStyle = 'rgba(255,255,255,0.06)'; g.beginPath(); g.arc(Math.random() * s, Math.random() * s, 10 + Math.random() * 18, 0, 7); g.fill() }
  })
  TEX.grass.wrapS = TEX.grass.wrapT = THREE.RepeatWrapping; TEX.grass.repeat.set(14, 14)
  TEX.wood = canvasTex(128, (g, s) => {
    g.fillStyle = '#a8703c'; g.fillRect(0, 0, s, s)
    for (let y = 0; y < s; y += 16) {
      g.fillStyle = `rgba(0,0,0,${0.12 + Math.random() * 0.08})`; g.fillRect(0, y, s, 2)
      g.fillStyle = 'rgba(255,220,160,0.14)'; g.fillRect(0, y + 2, s, 2)
      for (let i = 0; i < 6; i++) { g.fillStyle = 'rgba(90,55,25,0.25)'; g.fillRect(Math.random() * s, y + 4 + Math.random() * 10, 8 + Math.random() * 20, 1) }
    }
  })
  TEX.brick = canvasTex(128, (g, s) => {
    g.fillStyle = '#8d8a84'; g.fillRect(0, 0, s, s)
    g.fillStyle = '#a3a09a'
    for (let y = 0; y < s; y += 16) for (let x = -16; x < s; x += 32) g.fillRect(x + ((y / 16) % 2) * 16 + 1, y + 1, 30, 14)
  })
  TEX.metal = canvasTex(128, (g, s) => {
    g.fillStyle = '#93a6ba'; g.fillRect(0, 0, s, s)
    g.fillStyle = 'rgba(255,255,255,0.15)'; for (let i = 0; i < 30; i++) g.fillRect(0, Math.random() * s, s, 1)
    g.fillStyle = 'rgba(40,60,80,0.3)'; for (let i = 0; i < 14; i++) { const x = 6 + Math.random() * (s - 12), y = 6 + Math.random() * (s - 12); g.beginPath(); g.arc(x, y, 2.4, 0, 7); g.fill() }
  })
  TEX.wood.repeat = TEX.brick.repeat = TEX.metal.repeat = new THREE.Vector2(2, 1)
}
function glowSprite(color) {
  const c = document.createElement('canvas'); c.width = c.height = 64
  const g = c.getContext('2d')
  const gr = g.createRadialGradient(32, 32, 2, 32, 32, 30)
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, color); gr.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}
export const GLOW = {}

// ---------- quality ----------
export function detectQuality() {
  let info = ''
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2') || c.getContext('webgl')
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info')
    if (ext) info = (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '').toLowerCase()
  } catch {}
  if (/swiftshader|llvmpipe|software|mesa offscreen/.test(info)) return 'low'
  if (matchMedia('(pointer: coarse)').matches) return 'medium'
  return 'high'
}
export const QUALITY_PRESETS = {
  low:    { px: 1,   shadows: 0,    bloom: false, grass: 0,     aa: false, shadowSize: 0 },
  medium: { px: 1.5, shadows: 1024, bloom: false, grass: 9000,  aa: true,  shadowSize: 1024 },
  high:   { px: 2,   shadows: 2048, bloom: true,  grass: 18000, aa: true,  shadowSize: 2048 },
}

// ---------- scene ----------
export function createRenderer(canvas, quality) {
  const q = QUALITY_PRESETS[quality]
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: q.aa, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, q.px))
  renderer.setSize(innerWidth, innerHeight)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.shadowMap.enabled = q.shadows > 0
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  return renderer
}

function buildSky(scene, sunDir) {
  const geo = new THREE.SphereGeometry(1600, 24, 16)
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { sunDir: { value: sunDir } },
    vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `
      varying vec3 vP; uniform vec3 sunDir;
      void main(){
        vec3 d = normalize(vP);
        float h = clamp(d.y*1.4, 0.0, 1.0);
        vec3 zenith = vec3(0.16,0.42,0.86);
        vec3 horizon = vec3(0.78,0.89,0.99);
        vec3 col = mix(horizon, zenith, pow(h,0.72));
        float sd = max(dot(d, normalize(sunDir)), 0.0);
        col += vec3(1.0,0.92,0.7) * pow(sd, 220.0) * 1.6;   // sun disc
        col += vec3(1.0,0.85,0.55) * pow(sd, 8.0) * 0.28;   // glow
        col = mix(col, vec3(0.99,0.97,0.92), pow(1.0-abs(d.y), 14.0)*0.55); // haze band
        gl_FragColor = vec4(col, 1.0);
      }`,
  })
  const sky = new THREE.Mesh(geo, mat)
  sky.frustumCulled = false
  scene.add(sky)
  return sky
}

function buildWater(scene) {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { t: { value: 0 } },
    vertexShader: `varying vec2 vUv; varying vec3 vW;
      void main(){ vUv=uv; vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz;
      gl_Position=projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `
      varying vec2 vUv; varying vec3 vW; uniform float t;
      void main(){
        float w1 = sin(vW.x*0.32 + t*1.4) * sin(vW.z*0.28 - t*1.1);
        float w2 = sin(vW.x*0.9 - t*2.1) * sin(vW.z*0.7 + t*1.7);
        float sparkle = pow(max(0.0, w1*0.5+w2*0.35), 6.0);
        vec3 deep = vec3(0.05,0.32,0.62);
        vec3 shal = vec3(0.16,0.55,0.82);
        vec3 col = mix(deep, shal, 0.5+0.5*w1) + sparkle*vec3(0.9,0.97,1.0)*0.7;
        gl_FragColor = vec4(col, 0.92);
      }`,
  })
  const water = new THREE.Mesh(new THREE.PlaneGeometry(2600, 2600), mat)
  water.rotation.x = -Math.PI / 2
  water.position.y = -0.05
  scene.add(water)
  return water
}

function buildTerrain(scene) {
  const N = 600, S = 880
  const geo = new THREE.PlaneGeometry(S, S, N, N)
  geo.rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i)
    const h = heightAt(x, z)
    pos.setY(i, h)
    const d = Math.hypot(x, z)
    const noise = vnoise(x * 0.14, z * 0.14)
    if (d > 330 || h < 0.55) c.setHex(0xe8d89a)                       // beach
    else {
      const g1 = 0.36 + noise * 0.14, g2 = 0.62 + vnoise(x * 0.5, z * 0.5) * 0.2
      c.setRGB(0.24 + noise * 0.1, g1 + 0.18, 0.2 + noise * 0.08)
      if (h > 3.2) c.lerp(new THREE.Color(0x8fae5a), Math.min(1, (h - 3.2) / 3))
    }
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.computeVertexNormals()
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: TEX.grass })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.receiveShadow = true
  scene.add(mesh)
  return mesh
}

function buildGrass(scene, count) {
  if (!count) return null
  const blade = new THREE.ConeGeometry(0.075, 0.7, 3)
  blade.translate(0, 0.35, 0)
  const mat = new THREE.MeshLambertMaterial({ color: 0x64c04a, side: THREE.DoubleSide })
  mat.onBeforeCompile = sh => {
    sh.uniforms.uT = { value: 0 }
    mat.userData.sh = sh
    sh.vertexShader = 'uniform float uT;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       float sway = sin(uT*1.6 + float(gl_InstanceID)*1.7 + position.x*2.0) * 0.14 * position.y;
       transformed.x += sway; transformed.z += sway*0.6;`
    )
  }
  const inst = new THREE.InstancedMesh(blade, mat, count)
  inst.frustumCulled = false
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3()
  const col = new THREE.Color()
  let placed = 0, guard = 0
  while (placed < count && guard++ < count * 6) {
    const a = Math.random() * 6.28, d = Math.sqrt(Math.random()) * 330
    const x = Math.cos(a) * d, z = Math.sin(a) * d
    const h = heightAt(x, z)
    if (h < 0.5) continue
    p.set(x, h, z)
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * 6.28)
    const sc = 0.7 + Math.random() * 0.9
    s.set(sc, sc * (0.8 + Math.random() * 0.8), sc)
    m.compose(p, q, s)
    inst.setMatrixAt(placed, m)
    col.setHSL(0.28 + Math.random() * 0.07, 0.55 + Math.random() * 0.25, 0.36 + Math.random() * 0.16)
    inst.setColorAt(placed, col)
    placed++
  }
  inst.count = placed
  scene.add(inst)
  return inst
}

function buildClouds(scene, rnd) {
  const clouds = []
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x9fb8d8, emissiveIntensity: 0.35, flatShading: true })
  for (let i = 0; i < 24; i++) {
    const g = new THREE.Group()
    const n = 3 + Math.floor(rnd() * 3)
    for (let j = 0; j < n; j++) {
      const s = new THREE.Mesh(new THREE.IcosahedronGeometry(3.4 + rnd() * 3, 0), mat)
      s.position.set((j - n / 2) * 3.6 + rnd() * 2, rnd() * 1.6, (rnd() - 0.5) * 3)
      s.scale.y = 0.55
      g.add(s)
    }
    g.position.set((rnd() - 0.5) * 900, 52 + rnd() * 26, (rnd() - 0.5) * 900)
    scene.add(g)
    clouds.push(g)
  }
  return clouds
}

function buildTreesAndProps(scene, data) {
  // instanced pools: trunk, canopy(2 pools of blobs), rocks, metal
  const trees = data.props.filter(p => p.type === 'tree')
  const rocks = data.props.filter(p => p.type === 'rock')
  const metals = data.props.filter(p => p.type === 'metal')

  const trunkGeo = new THREE.CylinderGeometry(0.3, 0.46, 3.4, 7)
  trunkGeo.translate(0, 1.7, 0)
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x8a5a34, flatShading: true })
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length)
  trunks.castShadow = true

  const blobGeo = new THREE.IcosahedronGeometry(2.0, 0)
  const blobMat = new THREE.MeshLambertMaterial({ flatShading: true })
  const blobsPerTree = 3
  const blobs = new THREE.InstancedMesh(blobGeo, blobMat, trees.length * blobsPerTree)
  blobs.castShadow = true

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3()
  const col = new THREE.Color()
  const indexMap = new Map()

  trees.forEach((p, i) => {
    q.setFromEuler(e.set(0, p.rot, 0))
    v.set(p.x, p.y, p.z); sc.set(p.scale, p.scale * (1 + p.tint * 0.3), p.scale)
    m.compose(v, q, sc); trunks.setMatrixAt(i, m)
    const baseH = p.variant ? 0.32 : 0.30
    for (let b = 0; b < blobsPerTree; b++) {
      const idx = i * blobsPerTree + b
      const ang = p.rot + b * 2.1 + p.tint * 6
      const rad = b === 0 ? 0 : 1.15 * p.scale
      v.set(p.x + Math.cos(ang) * rad, p.y + (3.3 + b * 1.35) * p.scale, p.z + Math.sin(ang) * rad)
      const bs = (b === 0 ? 1.55 : 1.15) * p.scale * (0.9 + p.tint * 0.25)
      q.setFromEuler(e.set(p.tint * 3, ang, p.tint * 2))
      sc.set(bs, bs * 0.82, bs)
      m.compose(v, q, sc)
      blobs.setMatrixAt(idx, m)
      col.setHSL(baseH + p.tint * 0.05 - b * 0.012, 0.52 + p.tint * 0.14, 0.36 + p.tint * 0.12 - b * 0.02)
      blobs.setColorAt(idx, col)
      indexMap.set(p.id + ':' + b, idx)
    }
    p._inst = { trunk: i, blobsFrom: i * blobsPerTree, blobsN: blobsPerTree }
  })
  trunks.instanceMatrix.needsUpdate = true
  blobs.instanceMatrix.needsUpdate = true
  if (blobs.instanceColor) blobs.instanceColor.needsUpdate = true
  scene.add(trunks); scene.add(blobs)

  const rockGeo = new THREE.DodecahedronGeometry(1.15, 0)
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x96a0ab, flatShading: true })
  const rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, Math.max(1, rocks.length))
  rockMesh.castShadow = true
  rocks.forEach((p, i) => {
    q.setFromEuler(e.set(p.tint * 2, p.rot, p.tint))
    v.set(p.x, p.y + 0.5 * p.scale, p.z); sc.set(p.scale, p.scale * 0.85, p.scale)
    m.compose(v, q, sc); rockMesh.setMatrixAt(i, m)
    col.setHSL(0.58, 0.06 + p.tint * 0.04, 0.58 + p.tint * 0.12)
    rockMesh.setColorAt(i, col)
    p._inst = { rock: i }
  })
  rockMesh.instanceMatrix.needsUpdate = true
  if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true
  scene.add(rockMesh)

  const barrelGeo = new THREE.CylinderGeometry(0.55, 0.55, 1.3, 10)
  barrelGeo.translate(0, 0.65, 0)
  const boxGeo = new THREE.BoxGeometry(1.3, 1.1, 1.3); boxGeo.translate(0, 0.55, 0)
  const metalMat = new THREE.MeshLambertMaterial({ color: 0x7f93a8, flatShading: true })
  const barrelMesh = new THREE.InstancedMesh(barrelGeo, metalMat, Math.max(1, metals.filter(p => p.variant === 0).length))
  const boxMesh = new THREE.InstancedMesh(boxGeo, new THREE.MeshLambertMaterial({ color: 0x6e8296, flatShading: true }), Math.max(1, metals.filter(p => p.variant === 1).length))
  barrelMesh.castShadow = boxMesh.castShadow = true
  let bi = 0, xi = 0
  metals.forEach(p => {
    q.setFromEuler(e.set(0, p.rot, 0))
    v.set(p.x, p.y, p.z); sc.setScalar(p.scale)
    m.compose(v, q, sc)
    col.setHSL(0.56 + p.tint * 0.06, 0.2, 0.5 + p.tint * 0.15)
    if (p.variant === 0) { barrelMesh.setMatrixAt(bi, m); barrelMesh.setColorAt(bi, col); p._inst = { barrel: bi++ } }
    else { boxMesh.setMatrixAt(xi, m); boxMesh.setColorAt(xi, col); p._inst = { box: xi++ } }
  })
  barrelMesh.instanceMatrix.needsUpdate = boxMesh.instanceMatrix.needsUpdate = true
  if (barrelMesh.instanceColor) barrelMesh.instanceColor.needsUpdate = true
  if (boxMesh.instanceColor) boxMesh.instanceColor.needsUpdate = true
  scene.add(barrelMesh); scene.add(boxMesh)

  return { trunks, blobs, rockMesh, barrelMesh, boxMesh, instMeshes: [trunks, blobs, rockMesh, barrelMesh, boxMesh] }
}

function buildHouses(scene, data) {
  const groups = new Map()
  const matWall = new THREE.MeshLambertMaterial({ color: 0xd9c9a3 })
  const roofMat = new THREE.MeshLambertMaterial({ color: 0xb0413e, flatShading: true })
  const winMat = new THREE.MeshLambertMaterial({ color: 0x2a4a76, emissive: 0x16304f, emissiveIntensity: 0.7 })
  const floorMat = new THREE.MeshLambertMaterial({ color: 0x8a6b4a })

  for (const house of data.houses) {
    const g = new THREE.Group()
    g.position.set(house.x, 0, house.z)
    g.rotation.y = house.rot
    // foundation + floor
    const base = new THREE.Mesh(new THREE.BoxGeometry(9.8, 0.5, 7.8), floorMat)
    base.position.y = heightAt(house.x, house.z) - 0.15
    g.add(base)
    for (const p of data.props.filter(pp => pp.house === house.id)) {
      // wall segment in local coords
      const cosr = Math.cos(-house.rot), sinr = Math.sin(-house.rot)
      const lx = (p.x - house.x) * cosr - (p.z - house.z) * sinr
      const lz = (p.x - house.x) * sinr + (p.z - house.z) * cosr
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(p.hw * 2, 3.1, p.hd * 2), matWall)
      mesh.position.set(lx, heightAt(house.x, house.z) + 1.55, lz)
      mesh.rotation.y = p.yaw - house.rot
      mesh.castShadow = mesh.receiveShadow = true
      g.add(mesh)
      p._mesh = mesh
      // window on side segments
      if (p.hd < 0.3 && Math.abs(lz) > 1 && Math.abs(lz) < 3.5) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.0, 0.08), winMat)
        w.position.set(0, 0.2, p.hd + 0.05)
        mesh.add(w)
      }
    }
    const roof = new THREE.Mesh(new THREE.ConeGeometry(7.6, 2.6, 4), roofMat)
    roof.position.y = heightAt(house.x, house.z) + 3.1 + 1.2
    roof.rotation.y = Math.PI / 4
    roof.scale.set(1.05, 1, 0.86)
    roof.castShadow = true
    g.add(roof)
    scene.add(g)
    groups.set(house.id, g)
  }
  return groups
}

function buildCrater(scene, data) {
  const cr = data.crater
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(cr.r * 0.9, 1.6, 8, 26),
    new THREE.MeshLambertMaterial({ color: 0x6b6258, flatShading: true })
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.set(cr.x, Math.max(0.2, heightAt(cr.x, cr.z) + 1.4), cr.z)
  ring.scale.y = 0.5
  scene.add(ring)
  const rocks = []
  const rnd = mulberry32(7)
  for (let i = 0; i < 6; i++) {
    const a = rnd() * 6.28, d = 3 + rnd() * (cr.r - 5)
    const x = cr.x + Math.cos(a) * d, z = cr.z + Math.sin(a) * d
    const m = new THREE.Mesh(new THREE.DodecahedronGeometry(0.7 + rnd() * 0.7, 0),
      new THREE.MeshLambertMaterial({ color: 0x7a3fff, emissive: 0x5b1fd6, emissiveIntensity: 0.9, flatShading: true }))
    m.position.set(x, heightAt(x, z) + 0.5, z)
    m.castShadow = true
    scene.add(m)
    rocks.push(m)
  }
  return rocks
}

// ---------- full scene assembly ----------
export function buildScene(scene, data, quality) {
  makeTextures()
  GLOW.gold = glowSprite('rgba(255,215,80,0.95)')
  GLOW.blue = glowSprite('rgba(80,170,255,0.95)')
  GLOW.white = glowSprite('rgba(255,255,255,0.9)')
  GLOW.purple = glowSprite('rgba(170,90,255,0.95)')
  const rnd = mulberry32(42)

  const sunDir = new THREE.Vector3(0.55, 0.72, 0.42).normalize()
  const sky = buildSky(scene, sunDir)
  const water = buildWater(scene)

  const hemi = new THREE.HemisphereLight(0xa8ccff, 0x4a7a3a, 0.75)
  scene.add(hemi)
  const ambient = new THREE.AmbientLight(0xffffff, 0.18)
  scene.add(ambient)
  const sun = new THREE.DirectionalLight(0xfff0d0, 2.0)
  sun.position.set(60, 90, 40)
  const q = QUALITY_PRESETS[quality]
  if (q.shadows > 0) {
    sun.castShadow = true
    sun.shadow.mapSize.set(q.shadows, q.shadows)
    const c = sun.shadow.camera
    c.left = -150; c.right = 150; c.top = 150; c.bottom = -150; c.near = 5; c.far = 520
    sun.shadow.bias = -0.0006
    sun.shadow.normalBias = 0.03
  }
  scene.add(sun); scene.add(sun.target)

  scene.fog = new THREE.Fog(0xcfe4f7, 320, 1000)

  const terrain = buildTerrain(scene)
  const grass = buildGrass(scene, q.grass)
  const propMeshes = buildTreesAndProps(scene, data)
  const houseGroups = buildHouses(scene, data)
  const craterRocks = buildCrater(scene, data)
  const clouds = buildClouds(scene, rnd)

  // camera occluders (houses + trunks handled separately)
  const occluders = []
  for (const g of houseGroups.values()) g.traverse(o => { if (o.isMesh) occluders.push(o) })

  const update = (dt, focus, elapsed, inStorm) => {
    water.material.uniforms.t.value = elapsed
    if (grass && grass.material.userData.sh) grass.material.userData.sh.uniforms.uT.value = elapsed
    // sun follows focus for tight shadows
    sun.position.set(focus.x + 46, focus.y + 78, focus.z + 34)
    sun.target.position.set(focus.x, focus.y, focus.z)
    sun.target.updateMatrixWorld()
    for (const cl of clouds) {
      cl.position.x += dt * 0.9
      if (cl.position.x > 450) cl.position.x = -450
    }
    for (const r of craterRocks) { r.material.emissiveIntensity = 0.7 + Math.sin(elapsed * 2.4 + r.position.x) * 0.3 }
    scene.fog.color.setHex(inStorm ? 0x8a63c9 : 0xcfe4f7)
    scene.fog.near = inStorm ? 110 : 320
    scene.fog.far = inStorm ? 420 : 1000
  }

  return { update, occluders, propMeshes, houseGroups, sun, water, grass, sky }
}

// hide a harvested prop (instanced or house wall)
export function hidePropVisual(world, prop) {
  const im = world.propMeshes
  const zero = new THREE.Matrix4().makeScale(0, 0, 0)
  if (prop._inst) {
    if (prop._inst.trunk !== undefined) im.trunks.setMatrixAt(prop._inst.trunk, zero)
    if (prop._inst.blobsFrom !== undefined) for (let b = 0; b < prop._inst.blobsN; b++) im.blobs.setMatrixAt(prop._inst.blobsFrom + b, zero)
    if (prop._inst.rock !== undefined) im.rockMesh.setMatrixAt(prop._inst.rock, zero)
    if (prop._inst.barrel !== undefined) im.barrelMesh.setMatrixAt(prop._inst.barrel, zero)
    if (prop._inst.box !== undefined) im.boxMesh.setMatrixAt(prop._inst.box, zero)
    if (im.trunks.instanceMatrix) im.trunks.instanceMatrix.needsUpdate = true
    if (im.blobs.instanceMatrix) im.blobs.instanceMatrix.needsUpdate = true
    if (im.rockMesh.instanceMatrix) im.rockMesh.instanceMatrix.needsUpdate = true
    if (im.barrelMesh.instanceMatrix) im.barrelMesh.instanceMatrix.needsUpdate = true
    if (im.boxMesh.instanceMatrix) im.boxMesh.instanceMatrix.needsUpdate = true
  }
  if (prop._mesh) prop._mesh.visible = false
}
export function damagePropVisual(prop) {
  if (prop._mesh) {
    const m = prop._mesh.material
    if (!m._orig) m._orig = m.color.clone()
    m.color.copy(m._orig).multiplyScalar(0.72)
    clearTimeout(prop._flashT)
    prop._flashT = setTimeout(() => { if (m._orig) m.color.copy(m._orig) }, 90)
  }
}
