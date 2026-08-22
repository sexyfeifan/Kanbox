import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyReviewKey, selectDailyReviewNotes } from '../../app/lib/daily-review.mjs';

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

