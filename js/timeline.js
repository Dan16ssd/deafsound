// Persistent event timeline + daily summary (on-device, localStorage).
// Pure functions except load/save, which are guarded.

const KEY = 'deafsound.timeline';
export const TIMELINE_MAX = 500;

export function loadTimeline() {
  try { const v = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function saveTimeline(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(-TIMELINE_MAX))); } catch { /* storage full or blocked */ }
}

// Compact record of one alert; never contains audio or embeddings.
export function toRecord(ev) {
  return { t: ev.t, key: ev.key, lo: ev.lo, en: ev.en, icon: ev.icon, tier: ev.tier, wrong: !!ev.wrong, approach: !!ev.approach, level: ev.risk?.level };
}

export function addRecord(list, ev) {
  list.push(toRecord(ev));
  if (list.length > TIMELINE_MAX) list.splice(0, list.length - TIMELINE_MAX);
  return list;
}

export function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }

// → { total, danger, caution, info, critical, approaching, top: [{lo,en,icon,tier,count}], byHour: number[24] }
export function summarize(list, since = startOfDay(Date.now())) {
  const rows = list.filter((r) => r.t >= since && !r.wrong);
  const s = { total: rows.length, danger: 0, caution: 0, info: 0, critical: 0, approaching: 0, top: [], byHour: Array(24).fill(0) };
  const by = new Map();
  for (const r of rows) {
    s[r.tier]++;
    if (r.level === 'critical') s.critical++;
    if (r.approach) s.approaching++;
    s.byHour[new Date(r.t).getHours()]++;
    const g = by.get(r.key) ?? { lo: r.lo, en: r.en, icon: r.icon, tier: r.tier, count: 0 };
    g.count++;
    by.set(r.key, g);
  }
  s.top = [...by.values()].sort((a, b) => b.count - a.count).slice(0, 5);
  return s;
}
