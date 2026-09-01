import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDailyReviewAction,
  buildDailyReview,
  dailyReviewKey,
  normalizeDailyReviewState,
  selectDailyReviewNotes,
} from './daily-review.mjs';

const notes = Array.from({ length: 12 }, (_, index) => ({
  id: `note-${index}`,
  title: `笔记 ${index}`,
  savedAt: new Date(`2026-07-${String(index + 1).padStart(2, '0')}T08:00:00+08:00`),
}));

test('dailyReviewKey 使用本地日期', () => {
  assert.equal(dailyReviewKey(new Date(2026, 7, 22, 23, 59)), '2026-08-22');
});

test('每日回顾同一天稳定、跨天轮换且不重复', () => {
  const first = selectDailyReviewNotes(notes, { now: new Date(2026, 7, 22, 10), count: 5 });
  const again = selectDailyReviewNotes([...notes].reverse(), { now: new Date(2026, 7, 22, 20), count: 5 });
  const nextDay = selectDailyReviewNotes(notes, { now: new Date(2026, 7, 23, 10), count: 5 });
  assert.deepEqual(first.map((note) => note.id), again.map((note) => note.id));
  assert.notDeepEqual(first.map((note) => note.id), nextDay.map((note) => note.id));
  assert.equal(new Set(first.map((note) => note.id)).size, 5);
});

test('每日回顾优先旧收藏并安全处理空库', () => {
  const now = new Date(2026, 7, 22, 10);
  const recent = { id: 'recent', savedAt: new Date(2026, 7, 22, 9) };
  const old = { id: 'old', savedAt: new Date(2026, 7, 1, 9) };
  assert.deepEqual(selectDailyReviewNotes([recent, old], { now, count: 1 }).map((note) => note.id), ['old']);
  assert.deepEqual(selectDailyReviewNotes([], { now }), []);
});

test('历史上的今天优先于普通旧收藏', () => {
  const now = new Date(2026, 8, 1, 10);
  const anniversary = { id: 'anniversary', savedAt: new Date(2024, 8, 1, 9) };
  const old = { id: 'old', savedAt: new Date(2024, 7, 1, 9) };
  assert.equal(selectDailyReviewNotes([old, anniversary], { now, count: 1 })[0].id, 'anniversary');
});

test('每日回顾优先稍后阅读与未读内容', () => {
  const now = new Date(2026, 8, 1, 10);
  const items = [
    { id: 'read', savedAt: new Date(2024, 7, 1), readState: 'read' },
    { id: 'unread', savedAt: new Date(2024, 7, 1), readState: 'unread' },
    { id: 'later', savedAt: new Date(2024, 7, 1), readState: 'later' },
  ];
  assert.deepEqual(selectDailyReviewNotes(items, { now, count: 3 }).map((note) => note.id), ['later', 'unread', 'read']);
});

test('回顾进度、稍后复习与完成统计持久化', () => {
  const now = new Date(2026, 8, 1, 10);
  const initial = buildDailyReview(notes, { settings: { count: 3 } }, { now });
  assert.equal(initial.review.items.length, 3);
  const firstId = initial.review.items[0].note.id;
  const secondId = initial.review.items[1].note.id;
  const later = applyDailyReviewAction(notes, initial.state, { type: 'later', noteId: firstId }, { now });
  assert.equal(later.review.items[0].status, 'later');
  let progress = applyDailyReviewAction(notes, later.state, { type: 'reviewed', noteId: firstId }, { now });
  progress = applyDailyReviewAction(notes, progress.state, { type: 'reviewed', noteId: secondId }, { now });
  progress = applyDailyReviewAction(notes, progress.state, { type: 'reviewed', noteId: progress.review.items[2].note.id }, { now });
  assert.equal(progress.review.completed, true);
  assert.equal(progress.review.stats.streak, 1);
  assert.equal(progress.review.stats.completedDays, 1);
  assert.equal(buildDailyReview(notes, progress.state, { now }).review.completed, true);
});

test('损坏状态被收敛且回顾数量限制在 1 到 20', () => {
  const state = normalizeDailyReviewState({
    settings: { count: 999 },
    days: { 'bad-key': {}, '2026-09-01': { noteIds: ['a', 'a', ''], reviewedIds: ['a', 'x'] } },
  });
  assert.equal(state.settings.count, 20);
  assert.deepEqual(Object.keys(state.days), ['2026-09-01']);
  assert.deepEqual(state.days['2026-09-01'].noteIds, ['a']);
  assert.deepEqual(state.days['2026-09-01'].reviewedIds, ['a']);
});
