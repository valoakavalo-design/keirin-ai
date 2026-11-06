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

// 参考買い目（印ベース）: ◎○▲△から機械的に作る3連単8点。
// 特定の買い方戦略ではないため、戦略名・回収率・EVの訴求は付けない
// （2026-11-06: リークなし再検証で100%超の買い方戦略が残らなかったため、戦略機能は全て廃止した）。
function buildTickets(marks, probs, oddsMap) {
  const H = marks.honmei, T = marks.taikou, A = marks.tanana, D = marks.ana[0];
  const refCombos = [[H, T, A], [H, T, D], [H, A, T], [H, A, D], [H, D, T], [H, D, A], [T, H, A], [A, H, T]].map(c => c.join('-'));
  return { reference: summarizeCombos(refCombos, probs, oddsMap) };
}

// ---------- 展開パターン（2〜3通り） ----------
// 予想の提示方法の改善であり、買い方戦略ではない（回収率・EVの訴求は付けない。確率はモデル確率のみ）。
// 作り方（決定論的・モデル由来のみ。手作業の展開ルールは作らない）:
//   「誰が勝つか」で全選手をグループに割り、各グループを1つの展開パターンとする（勝者ベース分割）。
//   パターンのシェア = そのグループの1着確率（winProb）の合計を全体で割ったもの。全パターンで100%になる。
//   パターン1「本線」    = ◎ + ◎ラインの番手（◎が単騎なら◎のみ）
//   パターン2「対抗ライン」= ◎以外の最も強いライン（ライン合計確率が最大）の先頭 + 番手
//   パターン3「穴・崩壊」 = 残り全員（ライン3番手以降・弱いラインの番手・単騎など、本線で拾いにくい選手）
//   統合ルール（機械的）: グループが空ならそのパターンは作らない（2パターンに縮む）。
//   シェア3%未満のパターンは、対抗→穴・崩壊へ／穴・崩壊→対抗へ寄せて統合する（3パターンある間だけ適用）。
const PATTERN_MIN_SHARE = 3; // %

function buildPatterns(riders, lines, marks, probs, oddsMap, bank) {
  const byCar = new Map(riders.map(r => [r.carNo, r]));
  // ライン所属: carNo -> { lineIdx, pos(1始まり), size, head }
  const lineOf = new Map();
  (lines || []).forEach((line, li) => line.members.forEach((car, i) => lineOf.set(car, { lineIdx: li, pos: i + 1, size: line.members.length, head: line.members[0] })));
  for (const r of riders) if (!lineOf.has(r.carNo)) lineOf.set(r.carNo, { lineIdx: -r.carNo, pos: 1, size: 1, head: r.carNo });
  const pw = new Map(riders.map(r => [r.carNo, (r.winProb || 0) / 100]));
  const totalPw = riders.reduce((s, r) => s + pw.get(r.carNo), 0) || 1;
  const shareOf = (members) => +(members.reduce((s, c) => s + pw.get(c), 0) / totalPw * 100).toFixed(1);
  // ライン強度 = 所属選手の1着確率合計
  const lineStrength = new Map();
  for (const r of riders) { const li = lineOf.get(r.carNo).lineIdx; lineStrength.set(li, (lineStrength.get(li) || 0) + pw.get(r.carNo)); }
  const honmei = marks.honmei;
  const honLine = lineOf.get(honmei);
  const lineMembers = (li) => riders.filter(r => lineOf.get(r.carNo).lineIdx === li).map(r => r.carNo);
  const headAndBante = (li) => lineMembers(li).filter(c => lineOf.get(c).pos <= 2);

  // グループ構築
  let groups = [];
  const g1 = [...new Set([honmei, ...headAndBante(honLine.lineIdx)])];
  groups.push({ key: 'honmei', title: '本線', members: g1 });
  const otherLines = [...lineStrength.keys()].filter(li => li !== honLine.lineIdx)
    .sort((a, b) => lineStrength.get(b) - lineStrength.get(a));
  let g2 = [];
  if (otherLines.length) {
    g2 = headAndBante(otherLines[0]).filter(c => !g1.includes(c));
    if (g2.length) groups.push({ key: 'taikou', title: '対抗ライン', members: g2 });
  }
  const used = new Set([...g1, ...g2]);
  const g3 = riders.map(r => r.carNo).filter(c => !used.has(c));
  if (g3.length) groups.push({ key: 'ana', title: '穴・崩壊', members: g3 });

  // シェア極小パターンの統合（3パターンある間だけ。対抗→穴、穴→対抗）
  const withShare = () => groups.forEach(g => { g.share = shareOf(g.members); });
  withShare();
  while (groups.length >= 3) {
    const tai = groups.find(g => g.key === 'taikou');
    const ana = groups.find(g => g.key === 'ana');
    if (tai && tai.share < PATTERN_MIN_SHARE && ana) {
      ana.members = [...new Set([...ana.members, ...tai.members])];
      groups = groups.filter(g => g !== tai);
    } else if (ana && ana.share < PATTERN_MIN_SHARE && tai) {
      tai.members = [...new Set([...tai.members, ...ana.members])];
      groups = groups.filter(g => g !== ana);
    } else break;
    withShare();
  }

  // パターン別買い目: 頭 = グループ内の勝者候補（1着確率上位2人）。
  // 2・3着プール = そのパターンの浮上候補（グループ残りメンバー）を先に、3着内スコア上位で補って4人。
  // 買い目は頭の所属パターンに帰属させるので、パターン間で重複しない。
  const byPlaceDesc = (a, b) => (byCar.get(b).scorePlace || 0) - (byCar.get(a).scorePlace || 0);
  function patternTickets(group) {
    const heads = [...group.members].sort((a, b) => pw.get(b) - pw.get(a)).slice(0, 2);
    const tickets = [];
    for (const h of heads) {
      const inGroup = group.members.filter(c => c !== h).sort(byPlaceDesc);
      const others = riders.map(r => r.carNo).filter(c => c !== h && !group.members.includes(c)).sort(byPlaceDesc);
      const pool = [...inGroup, ...others].slice(0, 4).sort(byPlaceDesc);
      if (pool.length < 2) continue;
      const pairs = heads.length >= 2
        ? [[0, 1], [0, 2], [1, 0]]
        : [[0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1]];
      for (const [i, j] of pairs) {
        if (pool[i] == null || pool[j] == null || pool[i] === pool[j]) continue;
        const combo = `${h}-${pool[i]}-${pool[j]}`;
        const prob = probs ? (probs.get(combo) || 0) : 0;
        tickets.push({ combo, odds: oddsMap && oddsMap[combo] != null ? oddsMap[combo] : null, prob: +(prob * 100).toFixed(1) });
      }
    }
    tickets.sort((a, b) => b.prob - a.prob);
    return tickets.slice(0, 6);
  }

  const label = (car) => { const r = byCar.get(car); return r ? `${car}番${r.name}` : `${car}番`; };
  function describe(group) {
    if (group.key === 'honmei') {
      const head = byCar.get(honLine.head);
      const hon = byCar.get(honmei);
      let s;
      if (honLine.size === 1) {
        s = `単騎の◎${label(honmei)}が展開を読み切って浮上する世界。`;
      } else if (honLine.pos === 1) {
        const bante = lineMembers(honLine.lineIdx).find(c => lineOf.get(c).pos === 2);
        s = `◎${label(honmei)}がいる${honLine.size}車ラインが主導権を握る世界。先頭の◎（脚質${head.style}・B${head.b}）が引っ張ってそのまま押し切るか、番手${bante ? label(bante) : ''}の差しが届く展開。`;
      } else if (honLine.pos === 2) {
        s = `${honLine.size}車ラインの先頭${label(honLine.head)}（脚質${head.style}・B${head.b}）が主導権を握って引っ張り、番手の◎${label(honmei)}が差し切る世界。`;
      } else {
        s = `${honLine.size}車ラインが主導権を握る世界。先頭${label(honLine.head)}（脚質${head.style}・B${head.b}）が引っ張り、ラインの◎${label(honmei)}まで届く展開。`;
      }
      const trait = bankTraitComment(bank);
      if (trait) s += `バンクは${trait}。`;
      return s;
    }
    if (group.key === 'taikou') {
      const li = lineOf.get(group.members[0]).lineIdx;
      const headCar = lineMembers(li).find(c => lineOf.get(c).pos === 1);
      const head = byCar.get(headCar);
      const bante = lineMembers(li).find(c => lineOf.get(c).pos === 2);
      if (lineOf.get(headCar).size === 1) {
        return `単騎の${label(headCar)}（1着確率${byCar.get(headCar).winProb}%）が主導権争いに割って入る世界。◎ラインの出方次第でそのまま押し切る・浮上する。`;
      }
      return `対抗の${lineOf.get(headCar).size}車ラインが主導権を奪う世界。先頭${label(headCar)}（脚質${head.style}・B${head.b}）が◎ラインと競り合い、${bante ? `番手${label(bante)}の差し・追走まで` : '先頭の粘り込みが'}浮上する。`;
    }
    // ana
    const heroes = [...group.members].sort((a, b) => pw.get(b) - pw.get(a)).slice(0, 2);
    const phrases = heroes.map(car => {
      const info = lineOf.get(car);
      if (info.size === 1) return `単騎${label(car)}の切り替え浮上`;
      if (info.pos === 2) return `別線の番手${label(car)}の差し浮上`;
      if (info.pos >= 3) return `${label(info.head)}ラインの${info.pos}番手${label(car)}が切り替えての浮上`;
      return `別線先頭${label(car)}の粘り込み`;
    });
    return `本線と対抗が競り合って崩れる世界。${phrases.join('、')}が候補になる。`;
  }

  // シェア表示の丸め調整: 小数1桁に丸めた合計が100.0に一致するよう、最大シェアのパターンに残差を寄せる
  const rounded = groups.map(g => g.share);
  const residual = +(100 - rounded.reduce((s, v) => s + v, 0)).toFixed(1);
  if (residual !== 0 && groups.length) {
    const mi = rounded.indexOf(Math.max(...rounded));
    groups[mi].share = +(groups[mi].share + residual).toFixed(1);
  }

  return groups.map((g, i) => {
    const members = [...g.members].sort((a, b) => pw.get(b) - pw.get(a));
    return {
      no: i + 1, key: g.key, title: g.title, share: g.share,
      members,
      heroes: members.slice(0, 3).map(car => ({ carNo: car, name: byCar.get(car) ? byCar.get(car).name : '', winProb: byCar.get(car).winProb })),
      description: describe(g),
      tickets: patternTickets(g),
    };
  });
}

// 結果の勝者がどのパターンだったか（振り返り用。的中判定とは別枠）
function winnerPatternOf(patterns, actualResult) {
  if (!patterns || !patterns.length || !actualResult) return null;
  const r = Array.isArray(actualResult) ? actualResult.join('-') : String(actualResult);
  const winner = +String(r).split('-')[0];
  if (!winner) return null;
  const pat = patterns.find(p => (p.members || []).includes(winner));
  return pat ? { no: pat.no, key: pat.key, title: pat.title } : null;
}

// バンク特性の一言コメント（傾向ラベル×直線長から導出）。
// バンク情報は表示と展開解説の材料のみ。2024年データで検証した結果、
// バンク特徴を入れても予測精度は上がらなかったため、スコアには一切使わない。
function bankTraitComment(bank) {
  if (!bank || !bank.label) return null;
  const st = bank.straight;
  switch (bank.label) {
    case '差し寄り':
      if (st != null && st >= 58) return '直線が長く差しが届きやすいバンク';
      if (st != null && st <= 50) return '直線は短めだが差しが決まりやすいバンク';
      return '差しが決まりやすいバンク';
    case '逃げ寄り':
      if (st != null && st <= 50) return '直線が短く先行有利のバンク';
      if (st != null && st >= 58) return '直線は長めだが先行が残りやすいバンク';
      return '先行が残りやすいバンク';
    case '捲り寄り':
      return '捲りが決まりやすいバンク';
    case 'バランス':
      return '脚質の偏りが少ないバランス型バンク';
    default:
      return null;
  }
}

// テンプレートによる展開解説（外部AIは使わない）
function buildCommentary(riders, lines, marks, honmei, wind, bank) {
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
    ? `◎の予想勝率は${prob}%と比較的高く、本命中心の組み立てです。`
    : `◎の予想勝率は${prob}%で、混戦寄りの組み立てです。`;
  let scenario = '';
  const bankTrait = bankTraitComment(bank);
  if (bankTrait) scenario += `バンクは${bankTrait}。`;
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

module.exports = { scoreAll, comboProbabilities, buildTickets, buildPatterns, winnerPatternOf, buildCommentary, bankTraitComment };
