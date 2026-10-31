'use strict';
// モデルv2: 2024年前半で学習したロジスティック回帰（1着スコア / 3着内スコア）。
// 係数・標準化パラメータは model.json（analyze.py と同一仕様で再フィットし、
// 2024年後半で ◎1着率45.6% を再現済み）。
const MODEL = require('../model.json');

const FEATURE_LABELS = {
  point_rel: '競走得点', rate1: '勝率', rate3: '3連対率', B: 'B回数', S: 'S回数',
  kimari_jiriki: '自力決まり手（逃+捲）', kimari_oikomi: '追込決まり手（差+マ）',
  is_escape: '逃げ脚質', is_both: '両脚質', line_pos: 'ライン位置', line_size: 'ライン人数',
  is_single: '単騎', head_point_rel: '先頭の得点', head_B: '先頭のB',
  bante: '番手×先頭自力', age_num: '年齢', pos3p: 'ライン3番手以降',
};

function buildFeatures(riders, lines) {
  const byCar = new Map(riders.map(r => [r.carNo, r]));
  const lineOf = new Map();
  for (const line of lines) line.members.forEach((car, i) => lineOf.set(car, { line, pos: i + 1 }));
  const meanPoint = riders.reduce((s, r) => s + r.point, 0) / riders.length;
  return riders.map(r => {
    const info = lineOf.get(r.carNo) || { line: { members: [r.carNo], roles: [r.style] }, pos: 1 };
    const line = info.line, pos = info.pos, size = line.members.length;
    const head = byCar.get(line.members[0]) || r;
    const headJiriki = head.nige + head.makuri;
    const feats = {
      point_rel: r.point - meanPoint,
      rate3: r.trifectaRate, rate1: r.winRate, B: r.b, S: r.s,
      kimari_jiriki: r.nige + r.makuri, kimari_oikomi: r.sashi + r.markCnt,
      is_escape: r.style === '逃' ? 1 : 0, is_both: r.style === '両' ? 1 : 0,
      line_pos: pos, line_size: size, is_single: size === 1 ? 1 : 0,
      head_point_rel: head.point - meanPoint, head_B: head.b,
      bante: pos === 2 ? Math.min(headJiriki, 10) : 0,
      age_num: r.age || 35, pos3p: pos >= 3 ? 1 : 0,
    };
    return { rider: r, feats, linePos: pos, lineSize: size, lineHead: line.members[0] };
  });
}

function scoreAll(riders, lines) {
  const built = buildFeatures(riders, lines);
  const calc = (model, feats) => {
    let s = model.b; const contrib = [];
    model.features.forEach((f, i) => {
      const z = (feats[f] - model.mu[i]) / model.sd[i];
      const c = z * model.w[i];
      s += c; contrib.push({ feature: f, label: FEATURE_LABELS[f] || f, value: c });
    });
    return { score: s, contrib };
  };
  for (const b of built) {
    const w = calc(MODEL.win, b.feats); const t = calc(MODEL.top3, b.feats);
    b.rider.scoreWin = +w.score.toFixed(2); b.rider.scorePlace = +t.score.toFixed(2);
    b.rider.winContrib = w.contrib; b.rider.placeContrib = t.contrib;
    b.rider.topFactors = (contrib) => contrib;
    const top = (contrib, n) => contrib.filter(c => Math.abs(c.value) >= 0.05).sort((a, b2) => Math.abs(b2.value) - Math.abs(a.value)).slice(0, n)
      .map(c => `${c.label} ${c.value >= 0 ? '+' : ''}${c.value.toFixed(2)}`);
    b.rider.winFactors = top(w.contrib, 2); b.rider.placeFactors = top(t.contrib, 2);
    b.rider.linePosition = b.linePos - 1; // 既存アプリ互換（0始まり）
    b.rider.lineSize = b.lineSize;
  }
  // 予想勝率 = 1着スコアの softmax
  const maxS = Math.max(...built.map(b => b.rider.scoreWin));
  const exps = built.map(b => Math.exp(b.rider.scoreWin - maxS));
  const sum = exps.reduce((a, b) => a + b, 0);
  built.forEach((b, i) => { b.rider.winProb = +((exps[i] / sum) * 100).toFixed(1); });
  // 3着内確率の近似（Harville 用の相対強度にも使う）
  for (const b of built) b.rider.placeProbRaw = 1 / (1 + Math.exp(-b.rider.scorePlace));
  const byWin = [...built].sort((a, b) => b.rider.scoreWin - a.rider.scoreWin);
  const byPlace = [...built].sort((a, b) => b.rider.scorePlace - a.rider.scorePlace);
  const honmei = byWin[0].rider;
  const others = byPlace.filter(b => b.rider.carNo !== honmei.carNo).map(b => b.rider);
  const marks = { honmei: honmei.carNo, taikou: others[0]?.carNo, tanana: others[1]?.carNo, ana: [others[2]?.carNo].filter(Boolean) };
  built.forEach((b, i) => { b.rider.placeRank = byPlace.indexOf(b) + 1; });
  return { marks, honmei, placeOrder: byPlace.map(b => b.rider) };
}

// Harville式の近似: 1着は勝率、2・3着は3着内スコア由来の強度で逐次条件付けし、全順列で正規化する
function comboProbabilities(riders) {
  const p = new Map(riders.map(r => [r.carNo, r.winProb / 100]));
  const u = new Map(riders.map(r => [r.carNo, Math.max(r.placeProbRaw, 0.01)]));
  const U = riders.reduce((s, r) => s + u.get(r.carNo), 0);
  const raw = new Map();
  let total = 0;
  for (const a of riders) for (const b of riders) {
    if (b.carNo === a.carNo) continue;
    for (const c of riders) {
      if (c.carNo === a.carNo || c.carNo === b.carNo) continue;
      const denom1 = U - u.get(a.carNo); const denom2 = denom1 - u.get(b.carNo);
      if (denom1 <= 0 || denom2 <= 0) continue;
      const v = p.get(a.carNo) * (u.get(b.carNo) / denom1) * (u.get(c.carNo) / denom2);
      raw.set(`${a.carNo}-${b.carNo}-${c.carNo}`, v); total += v;
    }
  }
  const out = new Map();
  for (const [k, v] of raw) out.set(k, total > 0 ? v / total : 0);
  return out;
}

function ticketDetail(combo, probs, oddsMap) {
  const prob = probs.get(combo) || 0;
  const odds = oddsMap && oddsMap[combo] != null ? oddsMap[combo] : null;
  return {
    combo,
    odds,
    prob: +(prob * 100).toFixed(1),
    ev: odds != null ? Math.round(prob * odds * 100) : null,
  };
}

function summarizeCombos(combos, probs, oddsMap) {
  const details = combos.map(c => ticketDetail(c, probs, oddsMap));
  details.sort((a, b) => (b.ev ?? -1) - (a.ev ?? -1));
  const hitProb = +details.reduce((s, d) => s + (probs.get(d.combo) || 0) * 100, 0).toFixed(1);
  const ev = oddsMap ? Math.round(details.reduce((s, d) => s + (probs.get(d.combo) || 0) * (d.odds || 0), 0) * 100) : null;
  return { combos, details, hitProb, ev };
}

function buildTickets(marks, probs, oddsMap) {
  const H = marks.honmei, T = marks.taikou, A = marks.tanana, D = marks.ana[0];
  const shoubuCombos = [[H, T, A], [H, T, D], [H, A, T], [H, A, D]].map(c => c.join('-'));
  const refCombos = [[H, T, A], [H, T, D], [H, A, T], [H, A, D], [H, D, T], [H, D, A], [T, H, A], [A, H, T]].map(c => c.join('-'));
  return { shoubu: summarizeCombos(shoubuCombos, probs, oddsMap), reference: summarizeCombos(refCombos, probs, oddsMap) };
}

// 3連単フォーメーション: 着順ごとの候補車番から機械的に全組み合わせを生成する
function formationCombos(positions) {
  const out = [];
  for (const x of positions[0]) for (const y of positions[1]) {
    if (y === x) continue;
    for (const z of positions[2]) {
      if (z === x || z === y) continue;
      out.push(`${x}-${y}-${z}`);
    }
  }
  return out;
}
function permutations3(set) {
  const [x, y, z] = set;
  return [[x, y, z], [x, z, y], [y, x, z], [y, z, x], [z, x, y], [z, y, x]].map(c => c.join('-'));
}
const formationNotation = (positions) => positions.map(p => p.join('')).join('-');

// 複数フォーメーションプラン（a=◎, b=○, c=▲, d=△, e=3着内スコア5番目の選手）
function buildPlans(marks, riders, probs, oddsMap) {
  const a = marks.honmei, b = marks.taikou, c = marks.tanana, d = (marks.ana || [])[0];
  if (a == null || b == null || c == null || d == null) return [];
  const partners = [...riders].sort((r1, r2) => r2.scorePlace - r1.scorePlace).map(r => r.carNo).filter(car => car !== a);
  const e = partners[3];
  const defs = [
    {
      id: 'basic', name: '基本プラン',
      note: '勝負レースの標準プラン。成績集計（勝負）の基準はこのプランのままです。',
      positions: [[a], [b, c], [b, c, d]],
    },
    {
      id: 'nagashi', name: '1着流しプラン',
      note: '的中率を上げたい時用（検証: ◎勝率55%以上で 2024年5〜8月 回収率104.7%・的中率35.8%／9〜12月 回収率102.9%・的中率38.3%）',
      positions: [[a], [b, c, d], [b, c, d]],
    },
    {
      id: 'aitegashira', name: '相手頭プラン',
      note: '高配当狙い・ハイリスク（検証では期間で大きくブレる: 回収率116.8%／62.6%）',
      positions: [[b, c], [a], [b, c, d]],
    },
    {
      id: 'nikashira', name: '2頭軸プラン',
      note: '的中率最大（43.5%/44.2%）・点数多め、回収率は低め（92.6%/73.7%）',
      multiSets: [[a, b, c], [a, b, d]],
    },
    {
      id: 'sanchakukotei', name: '3着固定プラン',
      note: '△の3着に期待する形（回収率101.6%／81.1%）',
      positions: [[a, b, c], [a, b, c], [d]],
    },
  ];
  return defs.map(def => {
    const combos = def.multiSets
      ? def.multiSets.flatMap(set => permutations3(set))
      : formationCombos(def.positions);
    const s = summarizeCombos(combos, probs, oddsMap);
    return {
      id: def.id, name: def.name, note: def.note,
      notation: def.multiSets ? def.multiSets.map(set => set.join('')).join('マルチ＋') + 'マルチ' : formationNotation(def.positions),
      positions: def.positions || null, multiSets: def.multiSets || null,
      fifth: e != null ? e : null,
      combos: s.combos, details: s.details, hitProb: s.hitProb, ev: s.ev,
    };
  });
}

// 穴狙い: 3着内スコア上位なのに印が薄い「伏兵」を含み、EV>=120% の組み合わせ
function buildAna(riders, marks, probs, oddsMap) {
  if (!oddsMap) return [];
  const fukubyo = riders.filter(r => r.placeRank <= 3 && r.carNo !== marks.honmei && r.carNo !== marks.taikou)
    .sort((a, b) => a.placeRank - b.placeRank);
  if (!fukubyo.length) return [];
  const fukuCars = new Set(fukubyo.map(r => r.carNo));
  const list = [];
  for (const [combo, prob] of probs) {
    const cars = combo.split('-').map(Number);
    const fuku = fukubyo.find(f => cars.includes(f.carNo));
    if (!fuku) continue;
    const odds = oddsMap[combo];
    if (odds == null) continue;
    const ev = prob * odds;
    if (ev < 1.2) continue;
    list.push({
      combo, odds, prob: +(prob * 100).toFixed(1), ev: Math.round(ev * 100),
      reason: `伏兵${fuku.carNo}番${fuku.name}は3着内スコア${fuku.scorePlace.toFixed(2)}（全体${fuku.placeRank}位）なのにオッズは${odds}倍と割高。モデル確率${(prob * 100).toFixed(1)}%×${odds}倍で想定回収率${Math.round(ev * 100)}%`,
    });
  }
  list.sort((a, b) => b.ev - a.ev);
  return list.slice(0, 4);
}

// テンプレートによる展開解説（外部AIは使わない）
function buildCommentary(riders, lines, marks, honmei, wind) {
  const byCar = new Map(riders.map(r => [r.carNo, r]));
  const lineNotes = lines.map(line => {
    const head = byCar.get(line.members[0]);
    if (!head) return null;
    const label = line.members.length === 1 ? `${head.name}（単騎）` : `${head.name}ライン（${line.members.length}車）`;
    let note;
    if (line.members.length === 1) {
      note = `単騎の${head.carNo}番${head.name}は得点${head.point.toFixed(2)}。ラインの動きに乗りながら、自力の脚を残して浮上を狙う。`;
    } else {
      const second = byCar.get(line.members[1]);
      note = `先頭${head.carNo}番${head.name}（得点${head.point.toFixed(2)}・勝率${head.winRate}%・B${head.b}・逃${head.nige}）が主導権を握る${line.members.length}車ライン。番手${second.carNo}番${second.name}（得点${second.point.toFixed(2)}）が追走から差しを狙う。`;
      if (line.members.length >= 3) note += '3番手以降は1着面では減点対象だが、ラインの厚みで3着内には残りやすい。';
    }
    return { label, members: line.members, note };
  }).filter(Boolean);
  const H = byCar.get(marks.honmei), T = byCar.get(marks.taikou), A = byCar.get(marks.tanana), D = byCar.get(marks.ana[0]);
  const prob = H ? H.winProb : 0;
  const isShoubu = prob >= 55;
  let summary = `◎${H.carNo}番${H.name}は1着スコア${H.scoreWin.toFixed(2)}（予想勝率${prob}%）で本命。○${T.carNo}番${T.name}は3着内スコア最上位の相手、▲${A.carNo}番${A.name}${D ? `と△${D.carNo}番${D.name}` : ''}は3着内スコア順のヒモ候補。`;
  summary += isShoubu
    ? `◎の予想勝率が${prob}%で55%以上あるため勝負レースとし、3連単フォーメーション4点で勝負する。`
    : `◎の予想勝率は${prob}%で55%未満のため、見送り推奨。参考買い目のみ提示する。`;
  let scenario = '';
  const mainLine = lines.find(l => l.members.includes(H.carNo)) || lines[0];
  if (mainLine) {
    const head = byCar.get(mainLine.members[0]);
    scenario += mainLine.members.length === 1
      ? `${head.carNo}番${head.name}の単騎戦が鍵。`
      : `${head.carNo}番${head.name}が先行・自力で主導権を握り、${mainLine.members.length}車ラインで押し切る展開が本線。`;
  }
  if (T) scenario += `番手・相手の${T.carNo}番${T.name}は3着内スコア${T.scorePlace.toFixed(2)}で、追走からの差し・浮上が対抗。`;
  if (wind && wind.speedMs >= 2) {
    scenario += `風は${wind.directionLabel}の風${wind.speedMs}m/sで、ホームは${wind.homeLabel}、バックは${wind.backLabel}（風は展開の材料のみで、スコアには反映していない）。`;
  } else if (wind) {
    scenario += `風は${wind.directionLabel}の風${wind.speedMs}m/sと穏やかで、風の影響は小さい見込み。`;
  }
  return { lineNotes, summary, scenario };
}

module.exports = { scoreAll, comboProbabilities, buildTickets, buildPlans, buildAna, buildCommentary };
