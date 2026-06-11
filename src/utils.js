// ── GAME CONSTANTS ────────────────────────────────────────
export const FEE         = 10
export const PAY         = 0.8
export const MIN_PLAYERS = 2
export const MAX_CARDS   = 2
export const TIMER_SEC   = 40
export const REDIRECT_SEC = 10

// ── BINGO HELPERS ─────────────────────────────────────────
export function colClass(n) {
  if (n <= 15) return 'called-b'
  if (n <= 30) return 'called-i'
  if (n <= 45) return 'called-n'
  if (n <= 60) return 'called-g'
  return 'called-o'
}

export function letter(n) {
  if (n <= 15) return 'B'
  if (n <= 30) return 'I'
  if (n <= 45) return 'N'
  if (n <= 60) return 'G'
  return 'O'
}

export function bubClass(n) {
  if (n <= 15) return 'hb'
  if (n <= 30) return 'hi'
  if (n <= 45) return 'hn'
  if (n <= 60) return 'hg'
  return 'ho'
}

export function sanitizeKey(raw) {
  return raw.toString().replace(/[.#$[\]/]/g, '_')
}

// ── BINGO PATTERNS ────────────────────────────────────────
export const PATTERNS = [
  { n: 'Row 1',     i: [0,1,2,3,4] },
  { n: 'Row 2',     i: [5,6,7,8,9] },
  { n: 'Row 3',     i: [10,11,12,13,14] },
  { n: 'Row 4',     i: [15,16,17,18,19] },
  { n: 'Row 5',     i: [20,21,22,23,24] },
  { n: 'Col B',     i: [0,5,10,15,20] },
  { n: 'Col I',     i: [1,6,11,16,21] },
  { n: 'Col N',     i: [2,7,12,17,22] },
  { n: 'Col G',     i: [3,8,13,18,23] },
  { n: 'Col O',     i: [4,9,14,19,24] },
  { n: 'Diag \\',   i: [0,6,12,18,24] },
  { n: 'Diag /',    i: [4,8,12,16,20] },
  { n: '4 Corners', i: [0,4,20,24] },
  { n: 'T-shape',   i: [0,1,2,3,4,2,7,12,17,22] },
  { n: 'L-shape',   i: [0,5,10,15,20,21,22,23,24] },
  { n: 'Full Card',  i: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24] },
]

// ── AUDIO ─────────────────────────────────────────────────
let _audioCtx = null
export function getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  return _audioCtx
}

export function playNum(n, muted) {
  if (muted) return
  try {
    const a = new Audio(`sounds/${n}.mp3`)
    a.volume = 0.75
    const p = a.play()
    if (p) p.catch(() => {})
  } catch (e) {}
}

export function playWinnerSound(muted) {
  if (muted) return
  try {
    const a = new Audio('sounds/winner.mp3')
    a.volume = 1.0
    const p = a.play()
    if (p) p.catch(() => {
      try { new Audio('sounds/bingo.mp3').play().catch(() => {}) } catch (e) {}
    })
  } catch (e) {}
}

// ── FIREWORKS ─────────────────────────────────────────────
export function startFireworks(canvas) {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  canvas.width  = window.innerWidth
  canvas.height = window.innerHeight
  const W = canvas.width, H = canvas.height
  const COLS = ['#FFB800','#FF6B00','#ff3366','#00ff88','#00d4ff','#9d4edd','#ffffff','#ffe066']

  class Spark {
    constructor(x, y, col, isTail) {
      this.x = x; this.y = y; this.col = col; this.isTail = isTail
      if (isTail) {
        this.vx = (Math.random() - .5) * 1.2; this.vy = Math.random() * -1.5 - .5
        this.r = Math.random() * 1.5 + .5; this.life = 1; this.decay = Math.random() * .04 + .025
      } else {
        const a = Math.random() * Math.PI * 2, sp = Math.random() * 7 + 2
        this.vx = Math.cos(a) * sp; this.vy = Math.sin(a) * sp
        this.grav = 0.13; this.life = 1; this.decay = Math.random() * .016 + .008
        this.shape = Math.random() > .45 ? 'rect' : 'circle'
        this.w = Math.random() * 7 + 3; this.h = Math.random() * 12 + 5
        this.rot = Math.random() * 360; this.rs = (Math.random() - .5) * 10
      }
    }
    update() {
      this.x += this.vx; this.y += this.vy
      if (!this.isTail) { this.vy += this.grav; this.vx *= .985; this.rot += this.rs }
      this.life -= this.decay
    }
    draw() {
      ctx.save(); ctx.globalAlpha = Math.max(0, this.life); ctx.fillStyle = this.col
      if (this.isTail || this.shape === 'circle') {
        ctx.beginPath(); ctx.arc(this.x, this.y, this.r || 2, 0, Math.PI * 2); ctx.fill()
      } else {
        ctx.translate(this.x, this.y); ctx.rotate(this.rot * Math.PI / 180)
        ctx.fillRect(-this.w / 2, -this.h / 2, this.w, this.h)
      }
      ctx.restore()
    }
  }

  class Rocket {
    constructor() {
      this.x = Math.random() * W * .7 + W * .15; this.y = H + 8
      this.ty = Math.random() * H * .4 + H * .04
      this.col = COLS[Math.floor(Math.random() * COLS.length)]
      this.spd = Math.random() * 7 + 9; this.done = false; this.trail = []
    }
    update(parts) {
      if (this.done) return
      this.y -= this.spd
      this.trail.push(new Spark(this.x + (Math.random() - .5) * 2, this.y, 'rgba(255,255,255,0.6)', true))
      if (this.y <= this.ty) { this.done = true; this.burst(parts) }
    }
    burst(parts) {
      const n = Math.floor(Math.random() * 55) + 65
      for (let i = 0; i < n; i++) parts.push(new Spark(this.x, this.y, this.col, false))
      for (let i = 0; i < 18; i++) parts.push(new Spark(this.x, this.y, '#ffffff', false))
    }
    draw() {
      if (this.done) return
      ctx.save(); ctx.globalAlpha = 1; ctx.fillStyle = this.col
      ctx.beginPath(); ctx.arc(this.x, this.y, 3, 0, Math.PI * 2); ctx.fill(); ctx.restore()
      this.trail.forEach(t => { t.update(); t.draw() })
      this.trail = this.trail.filter(t => t.life > 0)
    }
  }

  const rockets = [], parts = []
  const burst = (x, y, col, n = 90) => { for (let i = 0; i < n; i++) parts.push(new Spark(x, y, col, false)) }
  setTimeout(() => burst(W / 2, H * .32, '#FFB800'), 60)
  setTimeout(() => burst(W * .28, H * .38, '#00ff88', 70), 280)
  setTimeout(() => burst(W * .72, H * .35, '#00d4ff', 70), 480)
  setTimeout(() => burst(W / 2, H * .25, '#ff3366', 60), 700)

  let t = 0; const start = Date.now(), DUR = 10000; let frame
  function loop() {
    if (Date.now() - start > DUR) { cancelAnimationFrame(frame); ctx.clearRect(0, 0, W, H); return }
    ctx.fillStyle = 'rgba(4,1,12,0.14)'; ctx.fillRect(0, 0, W, H)
    if (t % 18 === 0 && Date.now() - start < DUR - 1800) rockets.push(new Rocket())
    t++
    rockets.forEach(r => { r.update(parts); r.draw() })
    parts.forEach(p => { p.update(); p.draw() })
    const alive = parts.filter(p => p.life > 0); parts.length = 0; parts.push(...alive)
    frame = requestAnimationFrame(loop)
  }
  loop()
}
