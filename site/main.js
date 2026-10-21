// The page is a Cascade-style sequence. Scroll position is the playhead; every element below is
// keyframed against it, and the timeline dock is drawn from the same keyframes.
document.documentElement.classList.add('js')

const FPS = 30
const TOTAL = 68 // seconds
const $ = (id) => document.getElementById(id)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

// ---------- easings (the same family Cascade ships) ----------
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const X = (s) => ((ax * s + bx) * s + cx) * s
  const Y = (s) => ((ay * s + by) * s + cy) * s
  return (p) => {
    let s = p
    for (let i = 0; i < 6; i++) {
      const d = (3 * ax * s + 2 * bx) * s + cx
      if (Math.abs(d) < 1e-6) break
      s -= (X(s) - p) / d
    }
    return Y(clamp(s, 0, 1))
  }
}
function bounce(p) {
  const n = 7.5625, d = 2.75
  if (p < 1 / d) return n * p * p
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375
  return n * (p -= 2.625 / d) * p + 0.984375
}
const E = {
  linear: (p) => p,
  in: (p) => p * p * p,
  out: bezier(0.22, 1, 0.36, 1),
  inOut: bezier(0.65, 0, 0.35, 1),
  spring: (p) => 1 - Math.exp(-6.5 * p) * Math.cos(p * 12),
  elastic: (p) => (p === 0 || p === 1 ? p : 2 ** (-10 * p) * Math.sin((p * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  bounce,
  bezier: bezier(0.16, 1, 0.3, 1)
}

// ---------- keyframes ----------
// key(el, [[t, {prop: value}, easing?], …]). Easing names how the value arrives at that keyframe.
// Props: x/y (cqw/cqh), px/py (% of the element), s (scale), rx (deg), o (opacity), b (blur px), and any --custom-prop.
const REST = { o: 1, x: 0, y: 0, px: 0, py: 0, s: 1, rx: 0, b: 0 }
const anims = []
const effects = []
function key(el, frames) {
  const a = { el, props: {}, times: new Set() }
  for (const [t, v, e = 'out'] of frames) {
    a.times.add(t)
    for (const k in v) (a.props[k] ??= []).push({ t, v: v[k], e })
  }
  for (const k in a.props) a.props[k].sort((m, n) => m.t - n.t)
  a.transform = ['x', 'y', 'px', 'py', 's', 'rx'].some((k) => a.props[k])
  anims.push(a)
  return a
}
function show(el, tin, tout, { from = { o: 0, y: 3, b: 8 }, to = { o: 0, y: -3, b: 6 }, din = 1, dout = 0.7 } = {}) {
  const rest = {}
  for (const k of new Set([...Object.keys(from), ...Object.keys(to)])) rest[k] = REST[k]
  const f = tin == null ? [[0, rest]] : [[tin, from], [tin + din, rest]]
  if (tout != null) f.push([tout - dout, rest, 'linear'], [tout, to, 'in'])
  return key(el, f)
}
const fx = (fn) => effects.push(fn)
function valueAt(ks, t) {
  if (!ks) return undefined
  if (t <= ks[0].t) return ks[0].v
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i], b = ks[i + 1]
    if (t < b.t) return a.v + (b.v - a.v) * E[b.e]((t - a.t) / (b.t - a.t))
  }
  return ks[ks.length - 1].v
}
function apply(a, t) {
  const g = (k) => valueAt(a.props[k], t) ?? REST[k]
  const st = a.el.style
  if (a.transform) {
    // Only emit what isn't identity. A resting element gets no transform (and no 3D context), so the
    // browser paints it directly instead of resampling a composited layer, which blurs images and text.
    const [x, y, px, py, rx, s] = ['x', 'y', 'px', 'py', 'rx', 's'].map(g)
    let tf = ''
    if (rx) tf += `perspective(1400px) `
    if (x || y) tf += `translate(${x}cqw, ${y}cqh) `
    if (px || py) tf += `translate(${px}%, ${py}%) `
    if (rx) tf += `rotateX(${rx}deg) `
    if (s !== 1) tf += `scale(${s})`
    st.transform = tf || 'none'
  }
  if (a.props.o) {
    const o = g('o')
    st.opacity = o
    st.visibility = o < 0.004 ? 'hidden' : ''
  }
  if (a.props.b) { const b = g('b'); st.filter = b > 0.05 && !reduced ? `blur(${b}px)` : '' }
  for (const k in a.props) if (k.startsWith('--')) st.setProperty(k, g(k))
}

// ---------- the sequence ----------
const scenes = [
  { id: 'intro', label: 'Intro', start: 0, end: 12.4, at: 0 },
  { id: 'stage', label: 'Web tech', start: 12.4, end: 24.4, at: 15.6 },
  { id: 'agents', label: 'Copilot', start: 24.4, end: 38.4, at: 26.4 },
  { id: 'motion', label: 'Animate', start: 38.4, end: 47.2, at: 40.4 },
  { id: 'plugins', label: 'Plugins', start: 47.2, end: 55.2, at: 49 },
  { id: 'export', label: 'Export', start: 55.2, end: 61.4, at: 57 },
  { id: 'open', label: 'Open source', start: 61.4, end: TOTAL, at: 63 }
]
for (const s of scenes) s.el = $(s.id)
fx((t) => { for (const s of scenes) s.el.style.visibility = t >= s.start - 1.4 && t <= s.end + 0.4 ? 'visible' : 'hidden' })

// 1 · Intro: the hero is on screen at t=0, the editor rises out of the bottom, then we zoom into its preview.
show($('intro-copy'), null, 3.8, { to: { o: 0, y: -7, s: 0.96, b: 6 }, dout: 2.2 })
key($('hero-shot'), [
  [0, { y: 60, rx: 32, s: 0.84, px: 0, py: 0, o: 1 }],
  [1.6, { y: 56, rx: 30, s: 0.85 }, 'linear'],
  [6.2, { y: 3, rx: 0, s: 1 }, 'inOut'],
  [10.2, { y: 3, s: 1, px: 0, py: 0 }, 'linear'],
  [11.4, { o: 1 }, 'linear'],
  [12.3, { s: 2.8, px: 2, py: 24, y: 3, o: 0 }, 'in']
])
;['co-1', 'co-2', 'co-3', 'co-4'].forEach((id, i) => show($(id), 6.6 + i * 0.55, 10.2, { from: { o: 0, y: 1.6 }, to: { o: 0 }, din: 0.6, dout: 0.5 }))
show($('scroll-hint'), null, 1.4, { to: { o: 0 }, dout: 1.2 })

// 2 · The stage is the DOM: properties are applied one by one to a live HTML frame.
show($('stage-copy'), 12.6, 24.2, { from: { o: 0, y: 3, b: 8 } })
key($('live'), [
  [11.6, { o: 0, s: 1.9, '--k': 1 }],
  [13, { o: 1, s: 1 }],
  [20.4, { '--k': 1 }, 'linear'],
  [21.6, { '--k': 0.42 }, 'inOut'],
  [22.2, { '--k': 0.42 }, 'linear'],
  [23.2, { '--k': 1 }, 'inOut'],
  [23.6, { o: 1, x: 0 }, 'linear'],
  [24.4, { o: 0, x: -3 }, 'in']
])
const liveK = anims.at(-1)
const propTimes = [13.8, 14.8, 15.8, 16.8, 17.8, 18.8]
propTimes.forEach((t, i) => show($(`p-${i + 1}`), t, 24.2, { from: { o: 0, y: 1.4 }, to: { o: 0 }, din: 0.4 }))
key($('lt'), [
  [14.8, { '--fill': 0 }], [15.4, { '--fill': 1 }],
  [15.8, { '--bl': 0 }], [16.4, { '--bl': 1 }],
  [16.8, { '--rad': 0 }], [17.4, { '--rad': 0.9 }],
  [17.8, { '--sh': 0 }], [18.4, { '--sh': 1 }],
  [18.8, { '--slide': 0 }], [19.3, { '--slide': 1 }, 'in'], [20.2, { '--slide': 0 }, 'spring']
])
show($('res-note'), 20.4, 24.2, { from: { o: 0, y: 1.2 } })
fx((t) => {
  $('lt').classList.toggle('raw', t < 14.1)
  propTimes.forEach((pt, i) => $(`p-${i + 1}`).classList.toggle('on', t >= pt && t < pt + 1))
  const k = valueAt(liveK.props['--k'], t)
  const w = Math.round((640 + ((3840 - 640) * (k - 0.42)) / 0.58) / 16) * 16
  $('res').textContent = `${w} × ${Math.round((w * 9) / 16)}`
})

// 3 · Agents: the real exchange from the screenshot, replayed against the playhead.
const PROMPT = 'Add a title card over the first two seconds that says "Bunny trailer": centered, large, fading in and out.'
const REPLY = 'I added a large, centered "Bunny trailer" title with a drop shadow on the empty V4 track from 0:00 to 0:02. It fades in over 0.5s and out over the last 0.5s.'
show($('agents-copy'), 24.6, 34.4, { from: { o: 0, y: 3, b: 8 } })
;[...$('providers').children].forEach((li, i) => show(li, 25.4 + i * 0.18, 34.4, { from: { o: 0, y: 1.2 }, to: { o: 0 }, din: 0.5 }))
show($('chat'), 25, 34.4, { from: { o: 0, y: 4, s: 0.97 } })
show($('live-agent'), 25.4, 34.4, { from: { o: 0, y: 4 } })
const calls = [...$('calls').children]
calls.forEach((li, i) => show(li, 28.3 + i * 0.42, null, { from: { o: 0, x: -0.6 }, din: 0.3 }))
key($('recap'), [[29.6, { o: 0, s: 0.92 }], [30.3, { o: 1, s: 1 }]])
show($('undo'), 30.4, null, { from: { o: 0, y: 1 }, din: 0.5 })
key($('agent-shot'), [
  [34, { o: 0, y: 9, s: 0.92, rx: 14 }],
  [35.4, { o: 1, y: 0, s: 1, rx: 0 }],
  [37.6, { o: 1, y: 0, s: 1 }, 'linear'],
  [38.4, { o: 0, y: -5, s: 0.97 }, 'in']
])
const typed = (text, t, a, b) => text.slice(0, Math.round(text.length * clamp((t - a) / (b - a), 0, 1)))
fx((t) => {
  $('prompt').textContent = typed(PROMPT, t, 25.6, 28)
  $('reply').textContent = typed(REPLY, t, 31.4, 33.4)
})

// 4 · Motion: draw each easing curve, and move a clip with it.
show($('motion-copy'), 38.6, 47, { from: { o: 0, y: 3, b: 8 } })
show($('ease-card'), 39, 47, { from: { o: 0, y: 5, rx: 10 } })
show($('kf-shot'), 39.6, 47, { from: { o: 0, y: 5 } })
const EASES = ['spring', 'elastic', 'bounce', 'bezier']
const curvePath = (f) => {
  const pts = []
  for (let i = 0; i <= 96; i++) { const p = i / 96; pts.push(`${(p * 200).toFixed(1)} ${(100 - f(p) * 100).toFixed(1)}`) }
  pts[0] = 'M' + pts[0]
  return pts
}
const paths = EASES.map((n) => curvePath(E[n]))
const tabs = [...$('ease-tabs').children]
fx((t) => {
  // Each easing draws for 1.2s, then holds on the finished curve before the next one.
  const seg = 1.7, t0 = 39.8
  const i = clamp(Math.floor((t - t0) / seg), 0, 3)
  const p = clamp((t - t0 - i * seg) / 1.2, 0, 1)
  const v = E[EASES[i]](p)
  // Draw the curve up to the dot's x, so the line's tip is always under the dot.
  const n = Math.floor(p * 96)
  const d = paths[i].slice(0, n + 1).join('L') + `L${(p * 200).toFixed(1)} ${(100 - v * 100).toFixed(1)}`
  $('ease-curve').setAttribute('d', d)
  $('ease-dot').setAttribute('cx', p * 200)
  $('ease-dot').setAttribute('cy', 100 - v * 100)
  $('ease-pill').style.setProperty('--v', clamp(v, -0.08, 1.12))
  tabs.forEach((tab, j) => tab.classList.toggle('on', j === i))
})

// 5 · Plugins: the file types itself in, saves, and the wiggle starts.
show($('plugins-copy'), 47.4, 55, { from: { o: 0, y: 3, b: 8 } })
show($('code'), 47.6, 55, { from: { o: 0, y: 4 } })
show($('live-wiggle'), 47.9, 55, { from: { o: 0, y: 4 } })
show($('toast'), 51.9, 55, { from: { o: 0, y: 1, s: 0.95 }, din: 0.4 })
show($('wiggle-chip'), 52.1, null, { from: { o: 0, y: 1 }, din: 0.4 })
const lines = [...document.querySelectorAll('#code .ln')]
const hash = (n) => { const s = Math.sin(n * 127.1) * 43758.5453; return (s - Math.floor(s)) * 2 - 1 }
const noise = (x) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return hash(i) * (1 - u) + hash(i + 1) * u }
fx((t) => {
  lines.forEach((ln, i) => ln.classList.toggle('on', t >= 48 + i * 0.2))
  const a = clamp((t - 52.1) / 0.8, 0, 1)
  const w = t * 2
  $('wiggle-img').style.transform = a ? `translate(${noise(w) * a * 2.6}%, ${noise(w + 9) * a * 2.6}%) rotate(${noise(w + 4) * a * 1.2}deg)` : ''
})

// 6 · Export
show($('export-copy'), 55.4, 61.2, { from: { o: 0, y: 3, b: 8 } })
show($('export-shot'), 55.6, 61.2, { from: { o: 0, y: 6, rx: 8 } })
show($('job'), 56, 61.2, { from: { o: 0, y: 3 } })
const formats = [...$('formats').children]
fx((t) => {
  formats.forEach((li, i) => li.classList.toggle('on', t >= 56.4 + i * 0.3))
  const p = clamp((t - 56.4) / 3.2, 0, 1)
  $('job-bar').style.setProperty('--p', p)
  $('job-frames').textContent = `${Math.round(810 * p)} / 810 frames`
  const state = $('job-state')
  state.textContent = p < 1 ? `Rendering · ${Math.round(p * 100)}%` : 'Done'
  state.classList.toggle('done', p >= 1)
})

// 7 · Open source
show($('outro'), 61.6, null, { from: { o: 0, y: 4, b: 10 }, din: 1.2 })

// ---------- timeline dock ----------
const tracks = [
  { id: 'V3', name: 'Titles' },
  { id: 'V2', name: 'Overlays' },
  { id: 'V1', name: 'Screens' },
  { id: 'A1', name: 'Audio' }
]
const clips = [
  ...scenes.map((s) => ({ track: 0, kind: 'element', label: s.label, start: s.start, end: s.end, els: [s.el.querySelector('.copy, .intro-copy, .outro')] })),
  { track: 1, kind: 'element', label: 'Callouts', start: 6.2, end: 10.2, els: [...document.querySelectorAll('.callout')] },
  { track: 1, kind: 'element', label: 'frame.html', start: 11.6, end: 24.4, els: [$('live'), $('lt'), $('props')] },
  { track: 1, kind: 'element', label: 'agent chat', start: 25, end: 34.4, els: [$('chat'), $('live-agent')] },
  { track: 1, kind: 'element', label: 'easing.svg', start: 39, end: 47, els: [$('ease-card')] },
  { track: 1, kind: 'element', label: 'wiggle.ts', start: 47.6, end: 55, els: [$('code'), document.querySelector('.plug-side')] },
  { track: 1, kind: 'element', label: 'render job', start: 56, end: 61.2, els: [$('job')] },
  { track: 2, kind: 'video', label: 'editor.webp', start: 0, end: 12.4, els: [$('hero-shot')] },
  { track: 2, kind: 'video', label: 'agent.webp', start: 34, end: 38.4, els: [$('agent-shot')] },
  { track: 2, kind: 'video', label: 'keyframes.webp', start: 39.6, end: 47, els: [$('kf-shot')] },
  { track: 2, kind: 'video', label: 'export.webp', start: 55.6, end: 61.2, els: [$('export-shot')] }
]
const lanesEl = $('lanes')
const laneEls = tracks.map((tr) => {
  const head = document.createElement('div')
  head.className = 'head'
  head.innerHTML = `<b>${tr.id}</b>${tr.name}`
  $('heads').append(head)
  const lane = document.createElement('div')
  lane.className = 'lane'
  lanesEl.insertBefore(lane, $('playhead'))
  return lane
})
const pct = (t) => `${(t / TOTAL) * 100}%`
const kfs = []
for (const c of clips) {
  const el = document.createElement('div')
  el.className = `clip ${c.kind}`
  el.style.left = `calc(${pct(c.start)} + 1px)`
  el.style.width = `calc(${pct(c.end - c.start)} - 2px)`
  if (c.kind === 'video') el.style.setProperty('--thumb', `url(assets/${c.label})`)
  el.innerHTML = `<span>${c.label}</span>`
  // Diamonds: every keyframe of every element this clip owns (or contains).
  const times = new Set()
  for (const a of anims) if (c.els.some((o) => o && (o === a.el || o.contains(a.el)))) for (const t of a.times) if (t > c.start + 0.05 && t < c.end - 0.05) times.add(Math.round(t * 10) / 10)
  for (const t of times) {
    const d = document.createElement('i')
    d.className = 'kf'
    d.style.left = `${((t - c.start) / (c.end - c.start)) * 100}%`
    el.append(d)
    kfs.push({ d, t })
  }
  laneEls[c.track].append(el)
  c.el = el
}
const wave = document.createElement('canvas')
laneEls[3].append(wave)

function drawRuler() {
  const ruler = $('ruler')
  ruler.replaceChildren()
  const w = lanesEl.clientWidth
  const step = [1, 2, 5, 10, 15, 30].find((s) => (s / TOTAL) * w >= 56) ?? 30
  for (let s = 0; s <= TOTAL; s += step) {
    const t = document.createElement('span')
    t.className = 'tick'
    t.style.left = pct(s)
    t.textContent = `00:${String(s).padStart(2, '0')}`
    const m = document.createElement('span')
    m.className = 'tick minor'
    m.style.left = pct(s + step / 2)
    ruler.append(t, m)
  }
}
// Linked audio under every screen clip; deterministic "speech" so it looks the same on every load.
function drawWave() {
  const dpr = devicePixelRatio || 1
  const w = wave.clientWidth, h = wave.clientHeight
  wave.width = Math.round(w * dpr)
  wave.height = Math.round(h * dpr)
  const g = wave.getContext('2d')
  g.scale(dpr, dpr)
  const rnd = (n) => { const s = Math.sin(n * 91.7) * 43758.5453; return s - Math.floor(s) }
  for (const c of clips) {
    if (c.kind !== 'video') continue
    const x0 = (c.start / TOTAL) * w + 1, x1 = (c.end / TOTAL) * w - 1
    g.fillStyle = 'rgba(82, 196, 142, 0.16)'
    g.beginPath(); g.roundRect(x0, 0, x1 - x0, h, 5); g.fill()
    g.fillStyle = 'rgba(120, 220, 170, 0.78)'
    for (let x = x0 + 4; x < x1 - 3; x += 2) {
      const phrase = 0.35 + 0.65 * Math.abs(Math.sin(x * 0.045) * Math.sin(x * 0.013 + 1.7))
      const a = (0.15 + 0.85 * rnd(x)) * phrase * (h / 2 - 2)
      g.fillRect(x, h / 2 - a, 1, a * 2)
    }
  }
}

// ---------- playhead ----------
const reel = $('reel')
const dock = $('dock')
const navLinks = [...document.querySelectorAll('.bar-menu a')]
let pps = 1 // scroll px per second
const pad = (n) => String(n).padStart(2, '0')
const timecode = (sec) => {
  const f = Math.max(0, Math.round(sec * FPS))
  const s = Math.floor(f / FPS)
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f % FPS)}`
}
const target = () => clamp((scrollY - reel.offsetTop) / pps, 0, TOTAL)
const seek = (t, behavior = 'instant') => scrollTo({ top: reel.offsetTop + clamp(t, 0, TOTAL) * pps + 1, behavior })

for (const s of scenes) { const tc = s.el.querySelector('[data-tc]'); if (tc) tc.textContent = timecode(s.start) }

function render(t) {
  for (const a of anims) apply(a, t)
  for (const f of effects) f(t)
  $('playhead').style.transform = `translateX(${(t / TOTAL) * lanesEl.clientWidth}px)`
  $('dock-tc').textContent = timecode(t)
  for (const c of clips) c.el.classList.toggle('on', t >= c.start && t < c.end)
  for (const k of kfs) k.d.classList.toggle('hit', t >= k.t)
  const cur = scenes.findLast((s) => t >= s.start - 0.01)
  for (const a of navLinks) a.classList.toggle('on', a.dataset.jump === cur.id)
}

let shown = -1
let playing = false
let last = performance.now()
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  if (playing) {
    const next = target() + dt
    if (next >= TOTAL) setPlaying(false)
    scrollTo({ top: reel.offsetTop + Math.min(next, TOTAL) * pps, behavior: 'instant' })
  }
  const goal = target()
  // A little inertia makes scrubbing feel like a playhead instead of a page.
  const next = reduced || playing || shown < 0 ? goal : shown + (goal - shown) * Math.min(1, dt * 9)
  if (Math.abs(next - shown) > 0.0005) { shown = Math.abs(goal - next) < 0.002 ? goal : next; render(shown) }
  requestAnimationFrame(frame)
}

function setPlaying(on) {
  playing = on
  dock.classList.toggle('playing', on)
  $('play').setAttribute('aria-label', on ? 'Pause' : 'Play')
  if (on && target() >= TOTAL - 0.05) seek(0)
  last = performance.now()
}
$('play').addEventListener('click', () => setPlaying(!playing))
addEventListener('wheel', () => playing && setPlaying(false), { passive: true })
addEventListener('touchstart', () => playing && setPlaying(false), { passive: true })

// Scrub: drag anywhere on the lanes.
let scrubbing = false
const scrubTo = (e) => { const r = lanesEl.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * TOTAL) }
lanesEl.addEventListener('pointerdown', (e) => { scrubbing = true; setPlaying(false); lanesEl.setPointerCapture(e.pointerId); scrubTo(e) })
lanesEl.addEventListener('pointermove', (e) => scrubbing && scrubTo(e))
lanesEl.addEventListener('pointerup', () => { scrubbing = false })
lanesEl.addEventListener('pointercancel', () => { scrubbing = false })

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || /input|textarea/i.test(e.target.tagName)) return
  const k = e.key.toLowerCase()
  if (k === ' ' && (e.target === document.body || e.target === $('play')) && scrollY < reel.offsetTop + reel.offsetHeight - innerHeight) {
    e.preventDefault()
    setPlaying(!playing)
  } else if (k === 'j' || k === 'l' || k === 'k') {
    if (k === 'k') return setPlaying(false)
    setPlaying(false)
    const t = target()
    const i = scenes.findLastIndex((s) => t >= s.at - 0.05)
    const to = k === 'l' ? scenes[Math.min(scenes.length - 1, i + 1)].at : t - scenes[Math.max(i, 0)].at > 1 ? scenes[Math.max(i, 0)].at : scenes[Math.max(0, i - 1)].at
    seek(to, 'smooth')
  }
})
document.querySelectorAll('[data-jump]').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault()
  setPlaying(false)
  seek(scenes.find((s) => s.id === a.dataset.jump).at, 'smooth')
}))

document.querySelectorAll('.w').forEach((w, i) => { w.style.animationDelay = `${120 + i * 70}ms` })
$('intro-lede').style.animationDelay = '620ms'
$('intro-cta').style.animationDelay = '760ms'
// Windows visitors get the installer; everyone else the AppImage. /download lists every build.
if (/Win/.test(navigator.userAgentData?.platform ?? navigator.platform ?? '')) {
  document.querySelectorAll('[data-download]').forEach((el) => {
    el.href = 'https://github.com/MileniumHQ/Cascade/releases/latest/download/Cascade-windows-x64-setup.exe'
    el.querySelector('span').textContent = 'Download for Windows'
  })
}
document.querySelectorAll('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear() })

function layout() {
  const keep = shown < 0 ? 0 : target()
  pps = Math.max(120, innerHeight * 0.27)
  reel.style.height = `${TOTAL * pps + innerHeight}px`
  drawRuler()
  drawWave()
  if (shown >= 0) scrollTo({ top: reel.offsetTop + keep * pps, behavior: 'instant' })
  shown = -1
}
addEventListener('resize', layout)
layout()
render(target())
requestAnimationFrame(frame)
