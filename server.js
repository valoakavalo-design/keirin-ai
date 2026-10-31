'use strict';
// 競輪予想AI（外部公開用スタンドアロン版）
// Node 標準ライブラリのみで動作する HTTP サーバー。
// ブラインド規約: 予想フローで結果・払戻ページは開かない。結果はユーザーが手入力する。
const http = require('http');
const fs = require('fs');
const path = require('path');
const kdreams = require('./lib/kdreams');
const model = require('./lib/model');
const { getWind } = require('./lib/wind');
const venuesMaster = require('./venues.json');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'predictions.json');
const SEED_FILE = path.join(ROOT, 'seed', 'predictions-export.json');

// ---------- 履歴ストア（JSON ファイル） ----------
function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('data load failed, reseeding:', e.message); }
  let seed = [];
  try {
    const j = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    seed = (j.data && j.data.predictions) || [];
  } catch (e) { console.error('seed load failed:', e.message); }
  const store = { predictions: seed };
  saveStore(store);
  return store;
}
function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
  fs.renameSync(tmp, DATA_FILE);
}
let store = loadStore();

// ---------- 的中判定・集計 ----------
function resultStr(rec) {
  if (!rec.actualResult) return '';
  if (Array.isArray(rec.actualResult)) return rec.actualResult.join('-');
  return String(rec.actualResult).trim();
}
function setsOf(rec) {
  const shoubu = rec.shoubuTickets || [];
  const ref = rec.tickets || [];
  const ana = (rec.anaTickets || []).map(t => (typeof t === 'string' ? t : t.combo));
  return { shoubu, ref, ana, primary: rec.isShoubu ? shoubu : ref };
}
function applyResult(rec) {
  const r = resultStr(rec);
  const sets = setsOf(rec);
  if (!r) { rec.isHit = null; rec.isShoubuHit = null; rec.isAnaHit = null; return rec; }
  rec.isHit = sets.primary.includes(r);
  rec.isShoubuHit = rec.isShoubu ? sets.shoubu.includes(r) : null;
  rec.isAnaHit = sets.ana.length ? sets.ana.includes(r) : null;
  return rec;
}
function computeStats() {
  const all = store.predictions;
  const resulted = all.filter(p => resultStr(p));
  const agg = (list, setKey) => {
    let hits = 0, n = 0, stake = 0, ret = 0, roiN = 0;
    for (const p of list) {
      const r = resultStr(p); if (!r) continue;
      const set = setKey === 'shoubu' ? setsOf(p).shoubu : setsOf(p).primary;
      if (!set.length) continue;
      n++; if (set.includes(r)) hits++;
      if (p.payoutYen != null) { roiN++; stake += 100 * set.length; if (set.includes(r)) ret += p.payoutYen; }
    }
    return { n, hits, hitRate: n ? +(hits / n * 100).toFixed(1) : null, roi: roiN ? +(ret / stake * 100).toFixed(1) : null, roiN };
  };
  return {
    total: all.length, resulted: resulted.length,
    primary: agg(all, 'primary'),
    shoubu: agg(all.filter(p => p.isShoubu), 'shoubu'),
  };
}

// ---------- HTTP ユーティリティ ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ---------- 予想メイン処理 ----------
async function predict({ date, venueSlug, kaisaiDateId, raceNo }) {
  const detail = await kdreams.getRaceDetail(venueSlug, kaisaiDateId, raceNo);
  if (!detail.riders || detail.riders.length < 5) throw new Error('出走表を取得できませんでした（欠場・中止・未発表の可能性があります）');
  let racesInfo = null;
  try { racesInfo = await kdreams.getRaces(venueSlug, kaisaiDateId); } catch { /* 開催情報は任意 */ }
  const raceMeta = racesInfo ? racesInfo.races.find(r => r.raceNo === raceNo) : null;
  const startTime = detail.startTime || (raceMeta ? raceMeta.startTime : '');
  const { marks, honmei } = model.scoreAll(detail.riders, detail.lines);
  const probs = model.comboProbabilities(detail.riders);
  let oddsRes = { status: 'unavailable', odds: {}, time: '', count: 0 };
  try { oddsRes = await kdreams.getOdds(venueSlug, kaisaiDateId, raceNo); } catch { /* オッズ無しでも予想は続行 */ }
  const oddsMap = oddsRes.status === 'ok' ? oddsRes.odds : null;
  const tickets = model.buildTickets(marks, probs, oddsMap);
  const isShoubu = honmei.winProb >= 55;
  const primary = isShoubu ? tickets.shoubu : tickets.reference;
  const anaTickets = model.buildAna(detail.riders, marks, probs, oddsMap);
  const wind = await getWind(venueSlug, date, startTime).catch(() => null);
  const commentary = model.buildCommentary(detail.riders, detail.lines, marks, honmei, wind);
  const venueMeta = venuesMaster[venueSlug] || {};
  const rec = {
    id: (store.predictions.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1),
    createdAt: new Date().toISOString(),
    raceDate: date, venueSlug, venueName: venueMeta.name || (racesInfo ? racesInfo.venueName : venueSlug),
    raceNo, raceClass: detail.raceClass || (raceMeta ? raceMeta.raceClass : ''),
    meetingTitle: racesInfo ? racesInfo.meetingTitle : '', grade: racesInfo ? racesInfo.grade : '',
    startTime, sourceUrl: detail.sourceUrl,
    riders: detail.riders, lines: detail.lines,
    honmei: marks.honmei, taikou: marks.taikou, tanana: marks.tanana, ana: marks.ana,
    honmeiWinProb: honmei.winProb, isShoubu,
    tickets: tickets.reference.combos, ticketDetails: tickets.reference.details,
    shoubuTickets: tickets.shoubu.combos, shoubuTicketDetails: tickets.shoubu.details,
    primaryEv: primary.ev, primaryHitProb: primary.hitProb,
    anaTickets,
    oddsStatus: oddsRes.status, oddsCount: oddsRes.count, oddsTime: oddsRes.time, oddsFetchedAt: new Date().toISOString(),
    wind, lineNotes: commentary.lineNotes, summary: commentary.summary, scenario: commentary.scenario,
    raceReview: detail.raceReview,
    actualResult: null, payoutYen: null, isHit: null, isShoubuHit: null, isAnaHit: null,
  };
  store.predictions.unshift(rec);
  saveStore(store);
  return rec;
}

// ---------- ルーティング ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    if (p === '/api/venues') {
      const date = u.searchParams.get('date') || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
      const venues = await kdreams.getVenues(date);
      return sendJson(res, 200, { ok: true, date, venues: venues.map(v => ({ ...v, venueName: (venuesMaster[v.venueSlug] || {}).name || v.venueSlug })) });
    }
    if (p === '/api/races') {
      const slug = u.searchParams.get('venueSlug'), id = u.searchParams.get('kaisaiDateId');
      if (!slug || !id) return sendJson(res, 400, { ok: false, error: 'venueSlug と kaisaiDateId が必要です' });
      const info = await kdreams.getRaces(slug, id);
      return sendJson(res, 200, { ok: true, ...info });
    }
    if (p === '/api/predict' && req.method === 'POST') {
      const body = await readBody(req);
      const { date, venueSlug, kaisaiDateId, raceNo } = body;
      if (!date || !venueSlug || !kaisaiDateId || !raceNo) return sendJson(res, 400, { ok: false, error: 'パラメータ不足です' });
      const rec = await predict({ date, venueSlug, kaisaiDateId, raceNo: +raceNo });
      return sendJson(res, 200, { ok: true, prediction: rec });
    }
    if (p === '/api/predictions' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, predictions: store.predictions, stats: computeStats() });
    }
    const mRes = /^\/api\/predictions\/(\d+)\/result$/.exec(p);
    if (mRes && req.method === 'POST') {
      const body = await readBody(req);
      const rec = store.predictions.find(x => x.id === +mRes[1]);
      if (!rec) return sendJson(res, 404, { ok: false, error: 'not found' });
      const result = String(body.result || '').replace(/\s/g, '');
      if (result === '') { rec.actualResult = null; rec.payoutYen = null; }
      else {
        if (!/^\d-\d-\d$/.test(result)) return sendJson(res, 400, { ok: false, error: '結果は 1-2-3 の形式で入力してください' });
        rec.actualResult = result;
        rec.payoutYen = body.payoutYen === '' || body.payoutYen == null ? null : +body.payoutYen;
      }
      applyResult(rec); saveStore(store);
      return sendJson(res, 200, { ok: true, prediction: rec, stats: computeStats() });
    }
    if (p.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'not found' });
    // 静的ファイル
    const filePath = p === '/' ? path.join(ROOT, 'public', 'index.html') : path.join(ROOT, 'public', p);
    if (!filePath.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error(e);
    sendJson(res, 502, { ok: false, error: e.message || 'error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`競輪予想AI listening on http://0.0.0.0:${PORT} (data: ${DATA_FILE}, ${store.predictions.length} records)`);
});
