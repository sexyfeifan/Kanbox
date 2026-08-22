const DAY_MS = 24 * 60 * 60 * 1000;

function localDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function stableHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function dailyReviewKey(now = new Date()) {
  return localDayKey(now);
}

/**
 * 每天从旧收藏中稳定挑选一组回顾内容：同一天多次打开顺序不变，第二天自动轮换。
 * 优先选择保存超过 24 小时的内容，资料太少时再用当天收藏补足。
 */
export function selectDailyReviewNotes(notes, { now = new Date(), count = 5 } = {}) {
  const safeCount = Math.max(1, Math.min(20, Number(count) || 5));
  const unique = [];
  const seen = new Set();
  for (const note of Array.isArray(notes) ? notes : []) {
    const id = String(note?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(note);
  }

  const cutoff = now.getTime() - DAY_MS;
  const older = [];
  const recent = [];
  for (const note of unique) {
    const savedAt = new Date(note?.savedAt || 0).getTime();
    (Number.isFinite(savedAt) && savedAt <= cutoff ? older : recent).push(note);
  }

  const key = dailyReviewKey(now);
  const score = (note) => stableHash(`${key}:${note.id}`);
  older.sort((left, right) => score(left) - score(right));
  recent.sort((left, right) => score(left) - score(right));
  return [...older, ...recent].slice(0, safeCount);
}

