'use strict';
// Open-Meteo（APIキー不要）から開催場の風予報を取得する。
// 風は表示・展開解説の材料のみ。2024年27,715レースの検証で風速帯による1着率の差が
// ほぼ無かったため、スコアには一切使わない。
const venues = require('../venues.json');
const DIRS = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];

function dirLabel(deg) { return DIRS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]; }

function straightLabel(component, speed) {
  if (speed < 1.5) return 'ほぼ無風';
  const ratio = component / speed;
  let base = '横風';
  if (ratio >= 0.5) base = '追い風'; else if (ratio <= -0.5) base = '向かい風';
  return speed < 3 ? `${base}（弱め）` : base;
}

async function getWind(slug, dateStr, startTime) {
  const v = venues[slug];
  if (!v || !startTime) return null;
  const hh = startTime.split(':')[0].padStart(2, '0');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${v.lat}&longitude=${v.lon}` +
    `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&timezone=Asia%2FTokyo&start_date=${dateStr}&end_date=${dateStr}`;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    const times = j.hourly?.time || [];
    const idx = times.findIndex(t => t === `${dateStr}T${hh}:00`);
    if (idx < 0) return null;
    const speedMs = +((j.hourly.wind_speed_10m[idx] || 0) / 3.6).toFixed(1);
    const gustMs = j.hourly.wind_gusts_10m ? +((j.hourly.wind_gusts_10m[idx] || 0) / 3.6).toFixed(1) : null;
    const directionDeg = Math.round(j.hourly.wind_direction_10m[idx] || 0);
    const home = v.home;
    const windTo = (directionDeg + 180) % 360;
    const rad = (d) => (d * Math.PI) / 180;
    const homeComponent = +(speedMs * Math.cos(rad(windTo - home))).toFixed(1);
    const backComponent = +(speedMs * Math.cos(rad(windTo - (home + 180) % 360))).toFixed(1);
    return {
      speedMs, gustMs, directionDeg, directionLabel: dirLabel(directionDeg),
      homeAzimuth: home, homeComponent, backComponent,
      homeLabel: straightLabel(homeComponent, speedMs),
      backLabel: straightLabel(backComponent, speedMs),
      forecastTime: `${dateStr} ${hh}:00`, source: 'Open-Meteo',
    };
  } catch { return null; } finally { clearTimeout(timer); }
}

// 発走時刻の天気（Open-Meteo weather_code の日別予報）。天気も表示のみで、スコアには使わない。
// 場×日付で1回だけ取得し、時間帯ごとのコードを引く。
function weatherLabel(code) {
  if (code == null) return null;
  if (code === 0 || code === 1) return '晴';
  if (code === 2 || code === 3) return '曇';
  if (code === 45 || code === 48) return '霧';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '雪';
  return '雨'; // 51-67 霧雨・雨、80-82 にわか雨、95-99 雷雨
}
const weatherCache = new Map(); // slug|date -> {times, codes} | null
async function getWeather(slug, dateStr, startTime) {
  const v = venues[slug];
  if (!v || !startTime) return null;
  const key = `${slug}|${dateStr}`;
  let h = weatherCache.get(key);
  if (h === undefined) {
    h = null;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${v.lat}&longitude=${v.lon}` +
      `&hourly=weather_code&timezone=Asia%2FTokyo&start_date=${dateStr}&end_date=${dateStr}`;
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (res.ok) {
        const j = await res.json();
        if (j.hourly && Array.isArray(j.hourly.time)) h = { times: j.hourly.time, codes: j.hourly.weather_code || [] };
      }
    } catch { /* 天気は任意表示。取れなければ無し */ } finally { clearTimeout(timer); }
    weatherCache.set(key, h);
  }
  if (!h) return null;
  const hh = startTime.split(':')[0].padStart(2, '0');
  const idx = h.times.findIndex(t => t === `${dateStr}T${hh}:00`);
  if (idx < 0) return null;
  const code = h.codes[idx];
  const label = weatherLabel(code);
  return label ? { code, label } : null;
}

module.exports = { getWind, getWeather };
