const express = require('express'), http = require('http'), path = require('path');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const R = 2500, GAP = 9, TICK = 30, DT = 1 / TICK, MAXFOOD = 600, VIEW = 1300;
const MAX_PLAYERS = 30, MAX_ROOMS = 50, BOTS_PUBLIC = 8;
const NAMES = ['Slinky', 'Noodle', 'Viper', 'Zigzag', 'Coil', 'Mamba', 'Cobra', 'Python', 'Rattler', 'Sidewinder'];

const app = express(), srv = http.createServer(app), io = new Server(srv);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (q, r) => r.send('ok'));

// ---------- MongoDB (optional): persistent leaderboard ----------
let scores = null;
(async () => {
  if (!process.env.MONGODB_URI) return console.log('No MONGODB_URI set: running without database');
  try {
    const c = await new MongoClient(process.env.MONGODB_URI).connect();
    scores = c.db(process.env.DB_NAME || 'wormarena').collection('scores');
    await scores.createIndex({ score: -1 });
    console.log('MongoDB connected');
  } catch (e) { console.error('MongoDB connection failed:', e.message); }
})();
app.get('/api/leaderboard', async (q, res) => {
  if (!scores) return res.json([]);
  try { res.json(await scores.find({}, { projection: { _id: 0, name: 1, score: 1 } }).sort({ score: -1 }).limit(10).toArray()); }
  catch { res.json([]); }
});
async function saveScore(name, score) {
  if (!scores || score < 20) return;
  try { await scores.updateOne({ name }, { $max: { score }, $set: { at: new Date() } }, { upsert: true }); } catch {}
}

// ---------- Game ----------
let wid = 1;
class Worm {
  constructor(room, name, sock) {
    this.id = wid++; this.room = room; this.name = name; this.sock = sock || null;
    this.bot = !sock; this.kills = 0; this.hue = Math.random() * 360 | 0; this.reset();
  }
  reset() {
    const a = Math.random() * 6.283, d = Math.random() * (R - 700);
    this.x = Math.cos(a) * d; this.y = Math.sin(a) * d;
    this.a = Math.random() * 6.283; this.target = this.a;
    this.boost = false; this.mass = 0; this.t = 0; this.alive = true; this.segs = [];
    const n = this.bot ? 20 + Math.random() * 50 | 0 : 24;
    for (let i = 0; i < n; i++) this.segs.push({ x: this.x - Math.cos(this.a) * i * GAP, y: this.y - Math.sin(this.a) * i * GAP });
  }
  get len() { return this.segs.length; }
  get r() { return 9 + Math.min(this.len, 300) * .03; }
  step() {
    if (this.bot) {
      this.t -= DT;
      if (this.t <= 0) { this.target = this.a + (Math.random() - .5) * 2; this.t = .5 + Math.random() * 1.5; this.boost = Math.random() < .1; }
      if (Math.hypot(this.x, this.y) > R - 250) this.target = Math.atan2(-this.y, -this.x);
    }
    const d = Math.atan2(Math.sin(this.target - this.a), Math.cos(this.target - this.a));
    const turn = (this.boost ? 3.2 : 4.2) * DT;
    this.a += Math.max(-turn, Math.min(turn, d));
    if (this.boost && this.len <= 10) this.boost = false;
    if (this.boost) {
      this.mass -= DT * 3;
      if (this.mass < 0) { this.mass += 1; const t = this.segs.pop(); this.room.addFood(t.x, t.y, 1, this.hue); }
    }
    const sp = this.boost ? 300 : 170;
    this.x += Math.cos(this.a) * sp * DT; this.y += Math.sin(this.a) * sp * DT;
    const dd = Math.hypot(this.x, this.y), lim = R - this.r;
    if (dd > lim) { const k = lim / dd; this.x *= k; this.y *= k; }   // wall blocks, never kills
    const s = this.segs; s[0].x = this.x; s[0].y = this.y;
    for (let i = 1; i < s.length; i++) {
      const p = s[i - 1], q = s[i], dx = p.x - q.x, dy = p.y - q.y, l = Math.hypot(dx, dy) || 1;
      if (l > GAP) { q.x = p.x - dx / l * GAP; q.y = p.y - dy / l * GAP; }
    }
  }
  grow(v) {
    this.mass += v;
    while (this.mass >= 1) { this.mass--; const t = this.segs[this.segs.length - 1]; this.segs.push({ x: t.x, y: t.y }); }
  }
  hits(o) {
    const h = this.r * .8 + o.r * .8;
    if (Math.hypot(o.x - this.x, o.y - this.y) > o.segs.length * GAP + h + 20) return false;
    for (let i = 1; i < o.segs.length; i++) if (Math.hypot(o.segs[i].x - this.x, o.segs[i].y - this.y) < h) return true;
    return false;
  }
  die(killer) {
    this.alive = false;
    if (killer) killer.kills++;
    for (let i = 0; i < this.segs.length; i += 2)
      this.room.addFood(this.segs[i].x + Math.random() * 8 - 4, this.segs[i].y + Math.random() * 8 - 4, 3, this.hue);
    this.room.onDeath(this, killer);
  }
}

class Room {
  constructor(code, bots, opts = {}) {
    this.respawn = opts.respawn !== false; this.priv = code !== 'PUBLIC'; this.state = this.priv ? 'lobby' : 'playing'; this.host = 0;
    this.code = code; this.worms = new Map(); this.food = new Map(); this.specs = new Set();
    this.nid = 1; this.n = 0; this.added = []; this.removed = []; this.emptySince = Date.now();
    for (let i = 0; i < MAXFOOD; i++) this.spawnFood();
    for (let i = 0; i < bots; i++) this.addBot();
  }
  players() { return [...this.worms.values()].filter(w => w.sock); }
  addFood(x, y, v, hue = Math.random() * 360 | 0) {
    const f = [this.nid++, Math.round(x), Math.round(y), v, hue | 0];
    this.food.set(f[0], f); this.added.push(f);
  }
  spawnFood() { const a = Math.random() * 6.283, d = Math.sqrt(Math.random()) * (R - 40); this.addFood(Math.cos(a) * d, Math.sin(a) * d, 1); }
  addBot() { const w = new Worm(this, NAMES[Math.random() * NAMES.length | 0], null); this.worms.set(w.id, w); }
  addPlayer(sock, name) {
    const w = new Worm(this, name, sock); this.worms.set(w.id, w); this.emptySince = 0;
    if (this.state === 'lobby') w.alive = false;
    if (!this.host) this.host = w.id;
    return w;
  }
  emitLobby() {
    const players = this.players().map(w => ({ id: w.id, n: w.name }));
    for (const p of this.players()) p.sock.emit('lobby', { code: this.code, host: this.host, respawn: this.respawn, players });
  }
  start() {
    this.state = 'playing';
    for (const p of this.players()) { p.reset(); p.kills = 0; p.sock.emit('start'); }
  }
  onLeave(w) {
    if (this.host === w.id) { const p = this.players()[0]; this.host = p ? p.id : 0; }
    if (this.state === 'lobby') this.emitLobby();
  }
  onDeath(w, killer) {
    if (w.bot) {
      this.worms.delete(w.id);
      setTimeout(() => { if (rooms.get(this.code) === this) this.addBot(); }, 2000);
    } else if (w.sock) { w.sock.emit('dead', { len: w.len, by: killer ? killer.name : null, respawn: this.respawn }); if (!this.priv) saveScore(w.name, w.len); }
  }
  eat(w) {
    const rr = w.r + 8;
    for (const [id, f] of this.food)
      if (Math.abs(f[1] - w.x) < rr && Math.abs(f[2] - w.y) < rr && Math.hypot(f[1] - w.x, f[2] - w.y) < rr) {
        w.grow(f[3] * .5); this.food.delete(id); this.removed.push(id);
      }
  }
  update() {
    const all = []; for (const w of this.worms.values()) if (w.alive) all.push(w);
    for (const w of all) { w.step(); this.eat(w); }
    for (const w of all) if (w.alive) for (const o of all) if (o !== w && o.alive && w.hits(o)) { w.die(o); break; }
    while (this.food.size < MAXFOOD) this.spawnFood();
    if (this.priv && !this.respawn && this.state === 'playing') {   // last one standing
      const ps = this.players(), live = ps.filter(p => p.alive);
      if (live.length <= 1) {
        this.state = 'over';
        const win = live[0] || null, board = ps.map(p => [p.name, p.kills, p.len]).sort((a, b) => b[1] - a[1]);
        for (const p of ps) p.sock.emit('over', { winner: win ? win.name : null, winId: win ? win.id : 0, board });
      }
    }
    if (++this.n % 2 === 0) this.broadcast();
    if (!this.emptySince && !this.players().length && this.code !== 'PUBLIC') this.emptySince = Date.now();
  }
  broadcast() {
    const alive = []; for (const w of this.worms.values()) if (w.alive) alive.push(w);
    const lb = alive.slice().sort((a, b) => b.len - a.len).slice(0, 5).map(w => [w.name, w.len, w.kills]);
    const m = alive.map(w => [Math.round(w.x), Math.round(w.y)]);
    const near = (w, vx, vy) => {
      if (Math.hypot(w.x - vx, w.y - vy) < VIEW) return true;
      for (let i = 4; i < w.segs.length; i += 4) if (Math.hypot(w.segs[i].x - vx, w.segs[i].y - vy) < VIEW) return true;
      return false;
    };
    const view = (vx, vy) => alive.filter(w => near(w, vx, vy)).map(w => {
      const s = new Array(w.segs.length * 2);
      for (let i = 0; i < w.segs.length; i++) { s[2 * i] = Math.round(w.segs[i].x); s[2 * i + 1] = Math.round(w.segs[i].y); }
      return { i: w.id, n: w.name, h: w.hue, r: +w.r.toFixed(1), s };
    });
    const fa = this.added, fr = this.removed;
    for (const w of this.worms.values()) if (w.sock)
      w.sock.emit('state', { me: { x: Math.round(w.x), y: Math.round(w.y), l: w.len, k: w.kills }, w: view(w.x, w.y), fa, fr, lb, m });
    if (this.specs.size) {
      const b = alive.find(x => x.bot) || alive[0], vx = b ? b.x : 0, vy = b ? b.y : 0;
      const pkt = { me: { x: Math.round(vx), y: Math.round(vy), l: 0 }, w: view(vx, vy), fa, fr, lb, m };
      for (const s of this.specs) s.emit('state', pkt);
    }
    this.added = []; this.removed = [];
  }
}

const rooms = new Map([['PUBLIC', new Room('PUBLIC', BOTS_PUBLIC)]]);
function newCode() {
  let c; do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join(''); } while (rooms.has(c));
  return c;
}
setInterval(() => { for (const r of rooms.values()) r.update(); }, 1000 / TICK);
setInterval(() => {   // delete private rooms that stayed empty for 60s
  for (const [code, r] of rooms) if (code !== 'PUBLIC' && r.emptySince && Date.now() - r.emptySince > 60000 && !r.players().length) rooms.delete(code);
}, 5000);

// ---------- Sockets ----------
io.on('connection', sock => {
  let w = null, room = null;
  const leave = () => {
    if (room) { room.specs.delete(sock); if (w) { w.sock = null; if (w.alive) w.die(); room.worms.delete(w.id); room.onLeave(w); } }
    w = null; room = null;
  };
  sock.on('watch', () => { leave(); room = rooms.get('PUBLIC'); room.specs.add(sock); });
  sock.on('create', (d, cb) => {
    if (typeof cb !== 'function') return;
    if (rooms.size >= MAX_ROOMS) return cb({ ok: false, err: 'Server busy, try again soon' });
    const code = newCode(); rooms.set(code, new Room(code, 0, { respawn: !(d && d.respawn === false) })); cb({ ok: true, code });
  });
  sock.on('join', (d, cb) => {
    if (typeof cb !== 'function') return;
    leave();
    const code = String(d && d.room || 'PUBLIC').toUpperCase().slice(0, 6), rm = rooms.get(code);
    if (!rm) return cb({ ok: false, err: 'Room not found' });
    if (rm.priv && rm.state !== 'lobby') return cb({ ok: false, err: 'Game already started' });
    if (rm.players().length >= MAX_PLAYERS) return cb({ ok: false, err: 'Room is full' });
    const name = String(d && d.name || 'Player').replace(/[<>&"']/g, '').trim().slice(0, 14) || 'Player';
    room = rm; w = rm.addPlayer(sock, name);
    cb({ ok: true, code, id: w.id, R, f: [...rm.food.values()], lobby: rm.state === 'lobby', host: rm.host, respawn: rm.respawn, players: rm.players().map(p => ({ id: p.id, n: p.name })) });
    if (rm.state === 'lobby') rm.emitLobby();
  });
  sock.on('input', d => {
    if (!w || !w.alive || !d) return;
    if (Number.isFinite(d.a)) w.target = d.a;
    w.boost = !!d.b;
  });
  sock.on('respawn', () => { if (w && !w.alive && room.respawn && room.state === 'playing') w.reset(); });
  sock.on('start', (_, cb) => {
    if (!w || !room || room.state !== 'lobby' || room.host !== w.id) return;
    if (room.players().length < 2) return typeof cb === 'function' && cb({ ok: false, err: 'Need at least 2 players' });
    room.start(); if (typeof cb === 'function') cb({ ok: true });
  });
  sock.on('leave', leave);
  sock.on('disconnect', leave);
});

srv.listen(PORT, () => console.log('Worm Arena listening on ' + PORT));
