import test from 'node:test';
import assert from 'node:assert/strict';
import { countNoteViews, filterNotesByView, sortNotesForView } from './note-views.mjs';

const now = new Date('2026-09-01T12:00:00+08:00');
const notes = [
  { id: 'a', title: '未读', savedAt: '2026-09-01T08:00:00+08:00', favorite: true },
  { id: 'b', title: '稍后', savedAt: '2026-08-20T08:00:00+08:00', readState: 'later', lastReadAt: '2026-08-31T08:00:00+08:00' },
  { id: 'c', title: '已读', savedAt: '2026-08-01T08:00:00+08:00', readState: 'read', lastReadAt: '2026-08-10T08:00:00+08:00', syncConflict: true },
];

test('智能视图兼容旧笔记并统计今日、最近阅读和阅读状态', () => {
  const counts = countNoteViews(notes, now);
  assert.deepEqual(counts, { all: 3, favorite: 1, unread: 1, later: 1, read: 1, recent: 1, today: 1, conflict: 1 });
  assert.deepEqual(filterNotesByView(notes, 'unread', now).map((note) => note.id), ['a']);
  assert.deepEqual(filterNotesByView(notes, 'conflict', now).map((note) => note.id), ['c']);
});

test('最近阅读排序将未阅读笔记置后，并用收藏时间稳定兜底', () => {
  assert.deepEqual(sortNotesForView(notes, 'lastRead').map((note) => note.id), ['b', 'c', 'a']);
  assert.deepEqual(sortNotesForView(notes, 'newest').map((note) => note.id), ['a', 'b', 'c']);
});
