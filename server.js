'use strict';
// 競輪予想AI（外部公開用スタンドアロン版）
// Node 標準ライブラリのみで動作する HTTP サーバー。
// ブラインド規約: 予想フローで結果・払戻ページは開かない。結果はユーザーが手入力する。
const http = require('http');
const fs = require('fs');
const path = require('path');
const kdreams = require('./lib/kdreams');
const model = require('./lib/model');
const { getWind, getWeather } = require('./lib/wind');
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
  // 的中判定の対象は印ベースの参考買い目（3連単8点）のみ（2026-11-06: 買い方戦略は全て廃止）
  return { primary: rec.tickets || [] };
}
function applyResult(rec) {
  const r = resultStr(rec);
  // 廃止した戦略の判定フィールドは掃除する（旧レコード互換）
  rec.isShoubuHit = null; rec.isAnaHit = null; rec.isChosenPlanHit = null; rec.sHit = null; rec.coverHit = null; rec.spotHit = null;
  if (!r) { rec.isHit = null; rec.winnerPattern = null; return rec; }
  rec.isHit = setsOf(rec).primary.includes(r);
  // 実際の勝者がどの展開パターンだったか（振り返り用。的中判定とは別枠）
  rec.winnerPattern = model.winnerPatternOf(rec.patterns, r);
  return rec;
}
function computeStats() {
  const all = store.predictions;
  const resulted = all.filter(p => resultStr(p));
  let hits = 0, n = 0, stake = 0, ret = 0, roiN = 0;
  for (const p of all) {
    const r = resultStr(p); if (!r) continue;
    const set = setsOf(p).primary;
    if (!set.length) continue;
    n++; if (set.includes(r)) hits++;
    if (p.payoutYen != null) { roiN++; stake += 100 * set.length; if (set.includes(r)) ret += p.payoutYen; }
  }
  return {
    total: all.length, resulted: resulted.length,
    primary: { n, hits, hitRate: n ? +(hits / n * 100).toFixed(1) : null, roi: roiN ? +(ret / stake * 100).toFixed(1) : null, roiN },
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
  const primary = tickets.reference;
  const wind = await getWind(venueSlug, date, startTime).catch(() => null);
  const venueMeta = venuesMaster[venueSlug] || {};
  // バンク情報は表示・展開解説の材料のみ（スコア・確率・買い目・EVには一切使わない）
  const bank = venueMeta.bank ? { ...venueMeta.bank, traitComment: model.bankTraitComment(venueMeta.bank) } : null;
  // 展開パターン（2〜3通り）: 勝者ベースのグループ分割。提示方法の改善であり買い方戦略ではない（EV・回収率の訴求なし）
  const patterns = model.buildPatterns(detail.riders, detail.lines, marks, probs, oddsMap, bank);
  const commentary = model.buildCommentary(detail.riders, detail.lines, marks, honmei, wind, bank);
  const rec = {
    id: (store.predictions.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1),
    createdAt: new Date().toISOString(),
    raceDate: date, venueSlug, venueName: venueMeta.name || (racesInfo ? racesInfo.venueName : venueSlug),
    raceNo, raceClass: detail.raceClass || (raceMeta ? raceMeta.raceClass : ''),
    meetingTitle: racesInfo ? racesInfo.meetingTitle : '', grade: racesInfo ? racesInfo.grade : '',
    startTime, sourceUrl: detail.sourceUrl,
    riders: detail.riders, lines: detail.lines,
    honmei: marks.honmei, taikou: marks.taikou, tanana: marks.tanana, ana: marks.ana,
    honmeiWinProb: honmei.winProb, isShoubu: false,
    tickets: tickets.reference.combos, ticketDetails: tickets.reference.details,
    primaryHitProb: primary.hitProb,
    patterns, winnerPattern: null,
    oddsStatus: oddsRes.status, oddsCount: oddsRes.count, oddsTime: oddsRes.time, oddsFetchedAt: new Date().toISOString(),
    wind, bank, lineNotes: commentary.lineNotes, summary: commentary.summary, scenario: commentary.scenario,
    raceReview: detail.raceReview,
    actualResult: null, payoutYen: null, isHit: null,
  };
  store.predictions.unshift(rec);
  saveStore(store);
  return rec;
}

// ---------- 次走レース一覧（全レース一括分析） ----------
// 出走表のみからモデルv2で採点する（オッズは取得しない。オッズ・展開パターンは各レースを開いた時に計算）。
// 勝負度 = ◎の予想勝率、荒れ度 = 100 −（予想勝率1位＋2位）。定義は画面の注記にも明示する。
const analyzeMemCache = new Map(); // date -> data
const analyzeInflight = new Map(); // date -> Promise<data>
const ANALYZE_TTL_MS = 30 * 60 * 1000; // 当日・未来日は30分で再計算（出走表の後出し・欠場変更に追随）。過去日は固定

function todayJST() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); }
function raceStartMs(dateStr, startTime) {
  if (!startTime) return null;
  const [h, m] = startTime.split(':').map(Number);
  return new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`).getTime();
}
function badgeFor(topWinProb, arareDo) {
  if (topWinProb >= 55) return '本命堅い';
  if (arareDo > 55) return '混戦';
  if (topWinProb >= 45) return '本命寄り';
  return '様子見';
}
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (idx < items.length) { const k = idx++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}
// 1レース分: その日の予想記録が既にあればその◎勝率を再利用し、なければ出走表を取得して採点する。
// 出走表が取れないレースは null（呼び出し側で静かに除外）。
async function analyzeOneRace(date, venue, venueName, raceMeta) {
  let top = null, second = null;
  const saved = store.predictions.find(p => p.raceDate === date && p.venueSlug === venue.venueSlug && p.raceNo === raceMeta.raceNo && p.honmeiWinProb != null);
  if (saved) {
    const probs = (saved.riders || []).map(r => r.winProb).filter(v => v != null).sort((a, b) => b - a);
    if (probs.length >= 2) { top = saved.honmeiWinProb; second = probs[1]; }
  }
  if (top == null) {
    const detail = await kdreams.getRaceDetail(venue.venueSlug, venue.kaisaiDateId, raceMeta.raceNo);
    if (!detail.riders || detail.riders.length < 5) return null;
    model.scoreAll(detail.riders, detail.lines);
    const probs = detail.riders.map(r => r.winProb).sort((a, b) => b - a);
    top = probs[0]; second = probs[1];
  }
  const arareDo = +(100 - top - second).toFixed(1);
  let weather = null, weatherCode = null;
  try {
    const w = await getWeather(venue.venueSlug, date, raceMeta.startTime);
    if (w) { weather = w.label; weatherCode = w.code; }
  } catch { /* 天気は任意表示 */ }
  return {
    venueSlug: venue.venueSlug, venueName, kaisaiDateId: venue.kaisaiDateId,
    dayIndex: venue.dayIndex || null, // 節の○日目（kaisaiDateId 由来。無ければ null で表示しない）
    raceNo: raceMeta.raceNo, raceClass: raceMeta.raceClass || '', startTime: raceMeta.startTime || '',
    weather, weatherCode,
    topWinProb: top, secondWinProb: second,
    arareDo, shoubuDo: top, badge: badgeFor(top, arareDo), shoubu: top >= 55,
  };
}
async function computeAnalyze(date) {
  const venues = await kdreams.getVenues(date);
  const infos = await pool(venues, 4, async v => {
    try { return { v, info: await kdreams.getRaces(v.venueSlug, v.kaisaiDateId) }; }
    catch { return { v, info: null }; }
  });
  const tasks = [];
  for (const { v, info } of infos) {
    if (!info) continue;
    const venueName = (venuesMaster[v.venueSlug] || {}).name || info.venueName || v.venueSlug;
    for (const rm of info.races) tasks.push({ v, venueName, rm });
  }
  const results = await pool(tasks, 5, async t => {
    try { return await analyzeOneRace(date, t.v, t.venueName, t.rm); } catch { return null; }
  });
  return { date, generatedAt: new Date().toISOString(), races: results.filter(Boolean) };
}
async function getAnalyze(date) {
  const fresh = (genAt) => date < todayJST() || (Date.now() - new Date(genAt).getTime() < ANALYZE_TTL_MS);
  const mem = analyzeMemCache.get(date);
  if (mem && fresh(mem.generatedAt)) return mem;
  const file = path.join(DATA_DIR, `analyze-${date}.json`);
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && Array.isArray(j.races) && j.races.length && fresh(j.generatedAt)) { analyzeMemCache.set(date, j); return j; }
  } catch { /* キャッシュなし */ }
  if (!analyzeInflight.has(date)) {
    const pr = computeAnalyze(date).then(data => {
      analyzeInflight.delete(date);
      if (data.races.length) {
        analyzeMemCache.set(date, data);
        try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch { /* 保存失敗は無視 */ }
      }
      return data;
    }).catch(e => { analyzeInflight.delete(date); throw e; });
    analyzeInflight.set(date, pr);
  }
  return analyzeInflight.get(date);
}
function analyzePayload(data, date) {
  const now = Date.now();
  const races = data.races.map(r => {
    const ms = raceStartMs(date, r.startTime);
    return { ...r, started: ms != null && now >= ms };
  });
  // 未発走を発走時刻順に先へ、発走済は後ろへ
  races.sort((a, b) => (a.started - b.started) || String(a.startTime || '99').localeCompare(String(b.startTime || '99')) || a.raceNo - b.raceNo);
  return {
    ok: true, date, generatedAt: data.generatedAt,
    counts: {
      honmei: races.filter(r => r.topWinProb >= 45).length,
      arare: races.filter(r => r.arareDo >= 50).length,
      shoubu: races.filter(r => r.shoubu).length,
    },
    races,
  };
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
    if (p === '/api/races/analyze') {
      const date = u.searchParams.get('date');
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { ok: false, error: 'date=YYYY-MM-DD が必要です' });
      const data = await getAnalyze(date);
      return sendJson(res, 200, analyzePayload(data, date));
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
