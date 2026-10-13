// Shared game config — used by host and guest so both sides agree.
export const WORLD = 700
export const PLAY_R = 320
export const GRID = 4                       // build grid cell size (meters)
export const GRAV = 26

export const TIERS = [
  { id: 0, name: 'Common',    color: 0xb1b1b1, css: '#b1b1b1', mult: 1.00 },
  { id: 1, name: 'Uncommon',  color: 0x5bd75b, css: '#5bd75b', mult: 1.15 },
  { id: 2, name: 'Rare',      color: 0x4d9bff, css: '#4d9bff', mult: 1.32 },
  { id: 3, name: 'Epic',      color: 0xb45bff, css: '#b45bff', mult: 1.52 },
  { id: 4, name: 'Legendary', color: 0xffb02e, css: '#ffb02e', mult: 1.75 },
]

// Fortnite-ish weapon archetypes
export const WEAPONS = {
  ar:     { name: 'Assault Rifle',     icon: '🔫', dmg: 20, cd: 0.135, range: 95, spread: 0.020, pellets: 1, auto: true,  tracer: 0xffe14d, tier0: 0 },
  smg:    { name: 'Submachine Gun',    icon: '💥', dmg: 11, cd: 0.085, range: 42, spread: 0.048, pellets: 1, auto: true,  tracer: 0x7df9ff, tier0: 0 },
  pump:   { name: 'Pump Shotgun',      icon: '🔫', dmg: 9,  cd: 0.90,  range: 24, spread: 0.075, pellets: 9, auto: false, tracer: 0xff5b5b, tier0: 1 },
  bolt:   { name: 'Bolt Sniper',       icon: '🎯', dmg: 78, cd: 1.45,  range: 140,spread: 0.003, pellets: 1, auto: false, tracer: 0xc58bff, tier0: 2 },
  burst:  { name: 'Burst Assault',     icon: '🎯', dmg: 15, cd: 0.34,  range: 80, spread: 0.016, pellets: 1, auto: false, tracer: 0xff9a3d, tier0: 1 },
}
export const WEAPON_KEYS = Object.keys(WEAPONS)

export const BUILD = {
  wall:   { name: 'Wall',   icon: '▤', cost: 10, hp: 0 },   // hp by material below
  ramp:   { name: 'Ramp',   icon: '◺', cost: 10, hp: 0 },
  floor:  { name: 'Floor',  icon: '▦', cost: 10, hp: 0 },
}
export const MATS = {
  wood:  { name: 'Wood',  icon: '🪵', color: 0xb5793a, hp: 150, css: '#b5793a' },
  brick: { name: 'Brick', icon: '🧱', color: 0x9c9a95, hp: 300, css: '#9c9a95' },
  metal: { name: 'Metal', icon: '⚙️', color: 0x8fa3b8, hp: 500, css: '#8fa3b8' },
}
export const MAT_KEYS = Object.keys(MATS)

// Crafting recipes (Fortnite-style upgrade bench on the go)
export const RECIPES = [
  { id: 'shield50', name: 'Shield Potion',   icon: '🧪', desc: '+50 shield',      cost: { wood: 0,  brick: 30, metal: 0  }, time: 2.5, gives: { shield: 50 } },
  { id: 'shield100',name: 'Big Shield',      icon: '🛡️', desc: '+100 shield',     cost: { wood: 0,  brick: 60, metal: 10 }, time: 3.5, gives: { shield: 100 } },
  { id: 'medkit',   name: 'Medkit',          icon: '💊', desc: 'Full heal',       cost: { wood: 50, brick: 0,  metal: 0  }, time: 3.0, gives: { heal: 100 } },
  { id: 'upgrade',  name: 'Weapon Upgrade',  icon: '⬆️', desc: 'Tier +1 (max ⭐)',cost: { wood: 40, brick: 30, metal: 20 }, time: 4.0, gives: { upgrade: 1 } },
  { id: 'hoprock',  name: 'Hop Rock Mix',    icon: '☄️', desc: 'Low gravity 20s', cost: { wood: 10, brick: 10, metal: 30 }, time: 2.0, gives: { hop: 20 } },
]

// Storm (Chapter-style phases)
export const STORM = {
  firstDelay: 26,
  phases: [
    { wait: 30, shrink: 26, dps: 1,  scale: 0.72 },
    { wait: 26, shrink: 24, dps: 2,  scale: 0.55 },
    { wait: 24, shrink: 22, dps: 4,  scale: 0.42 },
    { wait: 22, shrink: 20, dps: 6,  scale: 0.30 },
    { wait: 20, shrink: 18, dps: 8,  scale: 0.20 },
    { wait: 18, shrink: 16, dps: 11, scale: 0.12 },
    { wait: 16, shrink: 14, dps: 15, scale: 0.06 },
    { wait: 14, shrink: 12, dps: 20, scale: 0.001 },
  ],
}

export const HARVEST = {
  tree:  { mat: 'wood',  amount: 9,  hp: 60 },
  rock:  { mat: 'brick', amount: 8,  hp: 70 },
  metal: { mat: 'metal', amount: 8,  hp: 70 },
  house: { mat: 'wood',  amount: 7,  hp: 90 },
}
export const PICKAXE_DMG = 20          // per swing; 3 swings ~= one prop
export const MELEE_RANGE = 3.4

export const BOTS_MAX = 10
export const BOT_NAMES = ['VenomFox','Loopy','Blitz','NoScopeNina','TurboTom','PixelPete','Ziggy','StormChaser','Dusty','ClipIt','WKeyWendy','BoxFighter','BushCamp','TiltedT']
export const BOT_COLORS = [0x38e08c,0xc86cff,0xff6b9d,0x4dd2ff,0xffa53d,0xe8ff47,0x7dff6b,0xff4747,0x47c7ff,0xd147ff,0x8cff9e,0xffc14d,0x5bd75b,0xff5bf0]

export const DROP_ALTITUDE = 130
export const GLIDER_ALT = 46

export const TICK = 1 / 30         // host snapshot rate
export const INPUT_RATE = 1 / 20   // guest input rate

export const rarityRoll = (luck = 1) => {
  // luck 1 = floor loot, 2 = chest
  const r = Math.random() * (5 + luck)
  if (r > 4.6) return 4
  if (r > 3.6) return 3
  if (r > 2.4) return 2
  if (r > 1.2) return 1
  return 0
}
