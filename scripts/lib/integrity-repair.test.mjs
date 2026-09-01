import assert from 'node:assert/strict';
import test from 'node:test';

import { findMissingStoredMedia, mergeRepairedMedia, storedMediaFileName } from './integrity-repair.mjs';

const noteId = '1234567890abcdef12345678';

test('完整性检查只接受当前笔记目录下的单层媒体文件', () => {
  assert.equal(storedMediaFileName(`/media/${noteId}/01.webp`, noteId), '01.webp');
  assert.equal(storedMediaFileName(`/media/${noteId}/../notes.json`, noteId), null);
  assert.equal(storedMediaFileName(`/media/${noteId}/%2e%2e%2fnotes.json`, noteId), null);
  assert.equal(storedMediaFileName('/media/ffffffffffffffffffffffff/01.webp', noteId), null);
});

test('完整性检查在大量媒体引用上线性运行并去重', () => {
  const note = {
    id: noteId,
    imageUrls: Array.from({ length: 20_000 }, (_, index) => `/media/${noteId}/${index % 500}.webp`),
  };
  const startedAt = performance.now();
  const missing = findMissingStoredMedia(note, { mediaDirectory: '/tmp/kanbox-media-test', exists: () => false });
  assert.equal(missing.length, 500);
  assert.ok(performance.now() - startedAt < 2_000, '完整性扫描不应在重复引用上退化为二次方复杂度');
});

test('越界媒体路径被标记异常，不会访问笔记目录之外', () => {
  const checked = [];
  const missing = findMissingStoredMedia({ id: noteId, imageUrls: [`/media/${noteId}/../../notes.json`] }, {
    mediaDirectory: '/private/kanbox/media',
    exists(filePath) { checked.push(filePath); return true; },
  });
  assert.deepEqual(missing, ['无效媒体路径']);
  assert.deepEqual(checked, []);
});

test('批量修复提交只更新媒体字段，保留期间的人工整理', () => {
  const current = { id: noteId, title: '最新标题', tags: ['最新'], favorite: true, imageUrls: ['/old.jpg'], mediaStatus: 'error' };
  const repaired = { id: noteId, title: '下载前旧标题', tags: ['旧'], favorite: false, imageUrls: ['/new.jpg'], mediaStatus: 'ready', ocrText: '已恢复' };
  assert.deepEqual(mergeRepairedMedia(current, repaired), {
    ...current,
    imageUrls: ['/new.jpg'],
    mediaStatus: 'ready',
    ocrText: '已恢复',
  });
});
