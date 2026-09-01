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

function uniqueIds(values, allowedIds = null) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const id = String(value || '').trim();
    if (!id || seen.has(id) || (allowedIds && !allowedIds.has(id))) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function dailyReviewKey(now = new Date()) {
  return localDayKey(now);
}

export function normalizeDailyReviewState(value) {
  const source = value && typeof value === 'object' ? value : {};
  const count = Math.max(1, Math.min(20, Number(source?.settings?.count) || 5));
  const days = {};
  for (const [key, raw] of Object.entries(source.days || {}).slice(-400)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !raw || typeof raw !== 'object') continue;
    const noteIds = uniqueIds(raw.noteIds).slice(0, 20);
    const allowed = new Set(noteIds);
    days[key] = {
      noteIds,
      reviewedIds: uniqueIds(raw.reviewedIds, allowed),
      laterIds: uniqueIds(raw.laterIds, allowed),
      completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : '',
    };
  }
  return { version: 1, settings: { count }, days };
}

/** 同一天顺序稳定；优先“历史上的今天”，其次长期未回顾，再用近期内容补足。 */
export function selectDailyReviewNotes(notes, { now = new Date(), count = 5, state = {} } = {}) {
  const safeCount = Math.max(1, Math.min(20, Number(count) || 5));
  const unique = [];
  const seen = new Set();
  for (const note of Array.isArray(notes) ? notes : []) {
    const id = String(note?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(note);
  }

  const key = dailyReviewKey(now);
  const previousReviewAt = new Map();
  for (const [dayKey, day] of Object.entries(normalizeDailyReviewState(state).days)) {
    for (const id of day.reviewedIds) {
      if (!previousReviewAt.has(id) || dayKey > previousReviewAt.get(id)) previousReviewAt.set(id, dayKey);
    }
  }
  const cutoff = now.getTime() - DAY_MS;
  const anniversary = [];
  const older = [];
  const recent = [];
  for (const note of unique) {
    const savedAt = new Date(note?.savedAt || 0);
    const savedTime = savedAt.getTime();
    const bucket = Number.isFinite(savedTime)
      && savedAt.getMonth() === now.getMonth()
      && savedAt.getDate() === now.getDate()
      && savedAt.getFullYear() < now.getFullYear()
      ? anniversary
      : Number.isFinite(savedTime) && savedTime <= cutoff ? older : recent;
    bucket.push(note);
  }

  const score = (note) => stableHash(`${key}:${note.id}`);
  const sort = (left, right) => {
    const priority = (note) => note?.readState === 'later' ? 0 : (note?.readState || 'unread') === 'unread' ? 1 : 2;
    if (priority(left) !== priority(right)) return priority(left) - priority(right);
    const leftReview = previousReviewAt.get(left.id) || '';
    const rightReview = previousReviewAt.get(right.id) || '';
    if (leftReview !== rightReview) return leftReview.localeCompare(rightReview);
    return score(left) - score(right);
  };
  anniversary.sort(sort);
  older.sort(sort);
  recent.sort(sort);
  return [...anniversary, ...older, ...recent].slice(0, safeCount);
}

function streakForDays(days, todayKey) {
  let streak = 0;
  const cursor = new Date(`${todayKey}T12:00:00`);
  while (streak < 400) {
    const key = localDayKey(cursor);
    if (!days[key]?.completedAt) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export function buildDailyReview(notes, rawState, { now = new Date() } = {}) {
  const state = normalizeDailyReviewState(rawState);
  const key = dailyReviewKey(now);
  let day = state.days[key];
  const noteById = new Map((Array.isArray(notes) ? notes : []).map((note) => [String(note?.id || ''), note]));
  if (!day) {
    const selected = selectDailyReviewNotes(notes, { now, count: state.settings.count, state });
    day = { noteIds: selected.map((note) => note.id), reviewedIds: [], laterIds: [], completedAt: '' };
    state.days[key] = day;
  } else {
    day.noteIds = uniqueIds(day.noteIds, new Set(noteById.keys())).slice(0, state.settings.count);
    const missing = state.settings.count - day.noteIds.length;
    if (missing > 0) {
      const selected = selectDailyReviewNotes(notes, { now, count: state.settings.count, state });
      day.noteIds.push(...selected.map((note) => note.id).filter((id) => !day.noteIds.includes(id)).slice(0, missing));
    }
  }
  const allowed = new Set(day.noteIds);
  day.reviewedIds = uniqueIds(day.reviewedIds, allowed);
  day.laterIds = uniqueIds(day.laterIds, allowed).filter((id) => !day.reviewedIds.includes(id));
  if (day.noteIds.length > 0 && day.noteIds.every((id) => day.reviewedIds.includes(id))) {
    day.completedAt ||= now.toISOString();
  } else {
    day.completedAt = '';
  }
  const items = day.noteIds.map((id) => noteById.get(id)).filter(Boolean).map((note) => ({
    note,
    status: day.reviewedIds.includes(note.id) ? 'reviewed' : day.laterIds.includes(note.id) ? 'later' : 'pending',
    reason: (() => {
      const savedAt = new Date(note.savedAt || 0);
      return Number.isFinite(savedAt.getTime()) && savedAt.getMonth() === now.getMonth() && savedAt.getDate() === now.getDate() && savedAt.getFullYear() < now.getFullYear()
        ? 'on-this-day' : 'rediscovery';
    })(),
  }));
  const completedDays = Object.values(state.days).filter((entry) => entry.completedAt).length;
  return {
    state,
    review: {
      date: key,
      count: state.settings.count,
      items,
      reviewedCount: day.reviewedIds.length,
      pendingCount: items.filter((item) => item.status !== 'reviewed').length,
      completed: Boolean(day.completedAt),
      completedAt: day.completedAt,
      stats: { streak: streakForDays(state.days, key), completedDays },
    },
  };
}

export function applyDailyReviewAction(notes, rawState, action, { now = new Date() } = {}) {
  const built = buildDailyReview(notes, rawState, { now });
  const day = built.state.days[built.review.date];
  if (action?.type === 'reset') {
    day.reviewedIds = [];
    day.laterIds = [];
    day.completedAt = '';
  } else {
    const noteId = String(action?.noteId || '');
    if (!day.noteIds.includes(noteId)) throw new Error('该笔记不在今天的回顾列表中');
    if (action?.type === 'reviewed') {
      day.reviewedIds = uniqueIds([...day.reviewedIds, noteId]);
      day.laterIds = day.laterIds.filter((id) => id !== noteId);
    } else if (action?.type === 'later') {
      day.laterIds = uniqueIds([...day.laterIds, noteId]);
      day.reviewedIds = day.reviewedIds.filter((id) => id !== noteId);
    } else {
      throw new Error('不支持的回顾操作');
    }
  }
  return buildDailyReview(notes, built.state, { now });
}
