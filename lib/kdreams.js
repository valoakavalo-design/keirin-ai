'use strict';
// 楽天Kドリームス (keirin.kdreams.jp) 公開ページの取得と解析。
// このモジュールは出走表・並び予想・コメント・オッズ（レース前情報）のみを取得する。
// 結果・払戻ページ (raceresult / pageType=result 等) には絶対にアクセスしない。
const BASE = 'https://keirin.kdreams.jp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function fetchText(url) {
const ctl = new AbortController();
const timer = setTimeout(() => ctl.abort(), 25000);
try {
const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja'}, signal: ctl.signal, redirect: 'follow'});
if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
return await res.text();
} finally { clearTimeout(timer);}
}

function decodeEntities(s) {
return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&yen;/g, '¥');
}
function cellText(html) {
return decodeEntities(String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))
.replace(/　/g, ' ').replace(/\s+/g, ' ').trim();
}
function stripText(html) {
return decodeEntities(String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
.replace(/<[^>]+>/g, '\n')).replace(/　/g, ' ');
}

// <table> を rowspan/colspan 展開した二次元テキスト配列にする
function parseTable(tableHtml) {
const rows = [];
const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
let m;
const rawRows = [];
while ((m = trRe.exec(tableHtml))) {
const cells = [];
const tdRe = /<(t[dh])([^>]*)>([\s\S]*?)<\/\1>/gi;
let c;
while ((c = tdRe.exec(m[1]))) {
const rs = /rowspan="?(\d+)"?/i.exec(c[2]); const cs = /colspan="?(\d+)"?/i.exec(c[2]);
cells.push({ text: cellText(c[3]), rowspan: rs? +rs[1]: 1, colspan: cs? +cs[1]: 1});
}
rawRows.push(cells);
}
const carry = {}; // col -> {text, left}
for (const cells of rawRows) {
const row = [];
let col = 0, ci = 0;
while (ci < cells.length || carry[col]) {
if (carry[col] && carry[col].left > 0) {
row[col] = carry[col].text; carry[col].left--; col++;
} else if (ci < cells.length) {
const cell = cells[ci++];
for (let k = 0; k < cell.colspan; k++) {
row[col] = cell.text;
if (cell.rowspan > 1) carry[col] = { text: cell.text, left: cell.rowspan - 1};
col++;
}
} else break;
}
// 末尾の carry を埋める
while (carry[col] && carry[col].left > 0) { row[col] = carry[col].text; carry[col].left--; col++;}
rows.push(row.map(v => v === undefined? '': v));
}
return rows;
}

function findTables(html, className) {
const out = [];
const re = new RegExp(`<table[^>]*class="[^"]*${className}[^"]*"[^>]*>([\\s\\S]*?)</table>`, 'gi');
let m; while ((m = re.exec(html))) out.push(m[1]);
return out;
}

function addDays(dateStr, n) {
const [y, m, d] = dateStr.split('-').map(Number);
const dt = new Date(Date.UTC(y, m - 1, d + n));
return dt.toISOString().slice(0, 10);
}

// 指定日に開催がある競輪場一覧。kaisaiDateId = 場コード2桁 + 節初日YYYYMMDD + 日次2桁 + '00'
async function getVenues(dateStr) {
const [y, mo, d] = dateStr.split('-');
const html = await fetchText(`${BASE}/kaisai/${y}/${mo}/${d}/`);
const seen = new Map();
const re = /keirin\.kdreams\.jp\/([a-z]+)\/racecard\/(\d{14})\//g;
let m;
while ((m = re.exec(html))) {
const slug = m[1], id = m[2];
const start = `${id.slice(2, 6)}-${id.slice(6, 8)}-${id.slice(8, 10)}`;
const dayIdx = parseInt(id.slice(10, 12), 10);
const actual = addDays(start, dayIdx - 1);
if (actual!== dateStr) continue;
if (!seen.has(slug + id)) seen.set(slug + id, { venueSlug: slug, kaisaiDateId: id, dayIndex: dayIdx});
}
return [...seen.values()];
}

// 出走表一覧ページから開催情報とレース一覧を取る
async function getRaces(slug, kaisaiDateId) {
const url = `${BASE}/${slug}/racecard/${kaisaiDateId}/`;
const html = await fetchText(url);
const titleM = /<title>([^<]+)<\/title>/.exec(html);
const parts = (titleM? titleM[1]: '').split('|').map(s => s.trim());
const venueName = (parts[0] || '').replace(/競輪.*$/, '');
const grade = parts[1] || '';
const meetingTitle = parts[2] || '';
const races = [];
const re = /<span class="num">(\d+)R<\/span><span class="name">([^<]*)<\/span>([\s\S]{0,900}?)<dt>発走<\/dt><dd>(\d{1,2}:\d{2})<\/dd>/g;
let m;
while ((m = re.exec(html))) {
const tM = /<p class="title">([^<]*)<\/p>/.exec(m[3]);
races.push({ raceNo: +m[1], raceClass: cellText(m[2]), headline: tM? cellText(tM[1]): '', startTime: m[4]});
}
races.sort((a, b) => a.raceNo - b.raceNo);
return { venueName, grade, meetingTitle, races, sourceUrl: url};
}

function parseLineup(html) {
const segM = /<div class="line_position">([\s\S]*?)<\/div>/.exec(html);
if (!segM) return [];
const seg = segM[1];
// icon_p の出現順に走査する状態機械（入れ子 span のため）
const items = [];
const re = /<span class="icon_p( space)?">|<span class="p0\d+">(\d+)<\/span>|<span class="p[12]\d+">([^<]*)<\/span>/g;
let m; let curItem = null;
while ((m = re.exec(seg))) {
if (m[0].startsWith('<span class="icon_p')) {
if (m[1]) { items.push(null); curItem = null; }
else { curItem = { carNo: 0, role: '' }; items.push(curItem); }
} else if (m[2] !== undefined && curItem) { curItem.carNo = +m[2]; }
else if (m[3] !== undefined && curItem) { curItem.role = cellText(m[3]); }
}
for (let i = items.length - 1; i >= 0; i--) if (items[i] && !items[i].carNo) items.splice(i, 1);
const lines = [];
let cur = [];
for (const it of items) {
if (it === null) { if (cur.length) lines.push(cur); cur = [];}
else cur.push(it);
}
if (cur.length) lines.push(cur);
return lines.map(members => ({ members: members.map(x => x.carNo), roles: members.map(x => x.role)}));
}

// レース詳細ページ（出走表・コメント・並び予想・レース評）を取得して解析する
async function getRaceDetail(slug, kaisaiDateId, raceNo) {
const url = `${BASE}/${slug}/racedetail/${kaisaiDateId}${String(raceNo).padStart(2, '0')}/`;
const html = await fetchText(url);
const text = stripText(html);
const titleM = /<title>([^<]+)<\/title>/.exec(html);
const title = titleM? titleM[1]: '';
const classM = new RegExp(`${raceNo}R\\s+([^|]+?)\\s*\\|`).exec(title);
const raceClass = classM? classM[1].trim(): '';
const startM = /発走予定\s*\n?\s*(\d{1,2}:\d{2})/.exec(text);
const startTime = startM? startM[1]: '';
const reviewM = /<p class="racereview">([\s\S]*?)<\/p>/.exec(html);
const raceReview = reviewM? cellText(reviewM[1]): '';

// 出走表テーブル（ヘッダに競走得点を含む最初の racecard_table）
const tables = findTables(html, 'racecard_table');
let riders = [];
let commentMap = {};
for (const t of tables) {
const grid = parseTable(t);
if (!grid.length) continue;
const headerText = grid.slice(0, 2).flat().join(' ').replace(/\s/g, '');
if (headerText.includes('選手コメント')) {
for (const row of grid.slice(2)) {
const car = parseInt(row[4], 10);
if (!car) continue;
// 列構成: 予想/好気合/総評/枠番/車番/選手名/級班/脚質/ギヤ/得点/コメント/短評
commentMap[car] = row[10] || '';
}
continue;
}
if (!headerText.includes('競走得点') ||!headerText.includes('勝率') ||!headerText.includes('着外')) continue;
// 列インデックスをヘッダ名から決める
const h0 = grid[0], h1 = grid[1] || [];
const colOf = (names, rows) => {
for (const r of rows) for (let i = 0; i < r.length; i++) if (names.includes(r[i].replace(/\s/g, ''))) return i;
return -1;
};
const col = {
frame: colOf(['枠番'], [h0]), car: colOf(['車番'], [h0]),
name: colOf(['選手名府県/年齢/期別', '選手名'], [h0]),
classBand: colOf(['級班'], [h0]), style: colOf(['脚質'], [h0]), gear: colOf(['ギヤ倍数', 'ギヤ'], [h0]),
point: colOf(['競走得点'], [h0, h1]), s: colOf(['S'], [h1, h0]), b: colOf(['B'], [h1, h0]),
nige: colOf(['逃'], [h1, h0]), makuri: colOf(['捲'], [h1, h0]), sashi: colOf(['差'], [h1, h0]), mark: colOf(['マ'], [h1, h0]),
first: colOf(['1着'], [h1, h0]), second: colOf(['2着'], [h1, h0]), third: colOf(['3着'], [h1, h0]), out: colOf(['着外'], [h1, h0]),
winRate: colOf(['勝率'], [h1, h0]), quinellaRate: colOf(['2連対率'], [h1, h0]), trifectaRate: colOf(['3連対率'], [h1, h0]),
jmark: colOf(['予想'], [h0]),
};
for (const row of grid.slice(2)) {
const carNo = parseInt(row[col.car], 10);
if (!carNo || carNo < 1 || carNo > 9) continue;
const nameCell = row[col.name] || '';
const nm = /^(.+)\/(\d+)\/(\d+)$/.exec(nameCell);
const nameParts = nm ? nm[1].split(' ') : [];
const nmName = nameParts.length >= 3 ? nameParts.slice(0, 2).join(' ') : (nameParts[0] || nameCell);
const nmPref = nameParts.length >= 3 ? nameParts.slice(2).join('') : (nameParts[1] || '');
const num = (v) => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n)? 0: n;};
riders.push({
carNo, frameNo: parseInt(row[col.frame], 10) || carNo,
name: nm? nmName: nameCell, prefecture: nm? nmPref: '', age: nm? +nm[2]: 0, term: nm? +nm[3]: 0,
classBand: row[col.classBand] || '', style: row[col.style] || '', gear: num(row[col.gear]),
point: num(row[col.point]), s: num(row[col.s]), b: num(row[col.b]),
nige: num(row[col.nige]), makuri: num(row[col.makuri]), sashi: num(row[col.sashi]), markCnt: num(row[col.mark]),
first: num(row[col.first]), second: num(row[col.second]), third: num(row[col.third]), out: num(row[col.out]),
winRate: num(row[col.winRate]), quinellaRate: num(row[col.quinellaRate]), trifectaRate: num(row[col.trifectaRate]),
journalistMark: row[col.jmark] || '',
});
}
}
riders.sort((a, b) => a.carNo - b.carNo);
for (const r of riders) r.comment = commentMap[r.carNo] || '';
const lines = parseLineup(html);
return { riders, lines, raceClass, startTime, raceReview, sourceUrl: url};
}

// 3連単オッズ（レース前情報）。結果・払戻ページは開かない。
async function getOdds(slug, kaisaiDateId, raceNo) {
const url = `${BASE}/${slug}/racedetail/${kaisaiDateId}${String(raceNo).padStart(2, '0')}/?pageType=odds&kakeshikiType=3rentan`;
const html = await fetchText(url);
const segStart = html.indexOf('JS_ODDSCONTENTS_3rentan');
if (segStart < 0) return { status: 'unavailable', odds: {}, time: '', count: 0};
const segEnd = html.indexOf('JS_ODDSCONTENTS_2shatan', segStart);
const seg = html.slice(segStart, segEnd > 0? segEnd: segStart + 400000);
const statusIdx = html.indexOf('JS_ODDSSTATUS_3rentan');
const timeM = statusIdx >= 0 ? /<p class="time">([^<]+)<\/p>/.exec(html.slice(statusIdx, statusIdx + 2000)) : null;
const odds = {};
const tableRe = /<table class="odds_table bt5[^"]*">([\s\S]*?)<\/table>/g;
let tm;
while ((tm = tableRe.exec(seg))) {
const grid = parseTable(tm[1]);
if (grid.length < 4) continue;
const firstM = /(\d+)/.exec(grid[0].join(' '));
if (!firstM) continue;
const first = +firstM[1];
const cols = grid[1].map(v => parseInt(v, 10)).filter(v => v >= 1 && v <= 9);
for (let r = 3; r < grid.length; r++) {
const third = parseInt(grid[r][0], 10);
if (!third) continue;
for (let c = 0; c < cols.length; c++) {
const v = parseFloat(grid[r][c + 1]);
if (v > 0 && v < 9999.9) odds[`${first}-${cols[c]}-${third}`] = v; // 9999.9 は発売実績なしの上限表示なので除外
}
}
}
const count = Object.keys(odds).length;
return { status: count? 'ok': 'unavailable', odds, time: timeM? cellText(timeM[1]): '', count};
}

module.exports = { getVenues, getRaces, getRaceDetail, getOdds, BASE};
