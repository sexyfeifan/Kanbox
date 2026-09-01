import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractNoteIdFromUrl,
  extractSharedNoteUrl,
  mergeImportedNote,
  normalizeImportedNote,
  noteFromSharedText,
  parseDraggedCardInput,
  parseDraggedNoteInput,
  removeStoredNote,
  serializeDraggedNote,
} from './note-import.mjs';

const sourceUrl = 'https://www.xiaohongshu.com/explore/64cb12340000000001020304?xsec_token=abc';

test('extractSharedNoteUrl finds a note URL inside copied text', () => {
  assert.equal(extractSharedNoteUrl(`这条不错 ${sourceUrl} 复制后打开`), sourceUrl);
});

test('extractNoteIdFromUrl supports current and legacy note paths', () => {
  assert.equal(extractNoteIdFromUrl(sourceUrl), '64cb12340000000001020304');
  assert.equal(
    extractNoteIdFromUrl('https://www.xiaohongshu.com/search_result/64cb12340000000001020304?xsec_token=abc'),
    '64cb12340000000001020304'
  );
  assert.equal(
    extractNoteIdFromUrl('https://www.xiaohongshu.com/discovery/item/601a87f50000000001000a07'),
    '601a87f50000000001000a07'
  );
});

test('drag payload round-trips without network access', () => {
  const payload = { sourceUrl, title: '标题', content: '正文内容' };
  assert.deepEqual(parseDraggedNoteInput(serializeDraggedNote(payload)), payload);
});

test('card drag payload preserves the anonymous resolver token', () => {
  const payload = `KANBOX_CARD:${JSON.stringify({
    id: '64cb12340000000001020304',
    sourceUrl,
    title: '卡片标题',
  })}`;
  assert.deepEqual(parseDraggedCardInput(payload), {
    id: '64cb12340000000001020304',
    sourceUrl,
    title: '卡片标题',
  });
});

test('normalizeImportedNote keeps visible page data only', () => {
  const note = normalizeImportedNote({
    sourceUrl,
    title: '标题',
    content: '正文内容',
    author: { name: '作者' },
    imageUrls: ['https://sns-webpic-qc.xhscdn.com/a.jpg'],
    type: 'video',
    videoUrl: 'https://sns-video-hw.xhscdn.com/a.mp4',
  });

  assert.equal(note.id, '64cb12340000000001020304');
  assert.equal(note.sourceUrl, 'https://www.xiaohongshu.com/explore/64cb12340000000001020304?xsec_token=abc');
  assert.equal(note.author.name, '作者');
  assert.equal(note.coverUrl, 'https://sns-webpic-qc.xhscdn.com/a.jpg');
  assert.deepEqual(note.sourceImageUrls, ['https://sns-webpic-qc.xhscdn.com/a.jpg']);
  assert.equal(note.mediaStatus, 'pending');
  assert.equal(note.sourceVideoUrl, 'https://sns-video-hw.xhscdn.com/a.mp4');
  assert.equal(note.videoStatus, 'pending');
});

test('noteFromSharedText rejects a bare link and accepts pasted content', () => {
  assert.throws(() => noteFromSharedText(sourceUrl), /需要匿名解析正文/);
  const note = noteFromSharedText(`这是标题\n这是已经复制出来的完整笔记正文内容\n${sourceUrl}`);
  assert.equal(note.title, '这是标题');
});

test('mergeImportedNote replaces duplicates', () => {
  const created = mergeImportedNote([{ id: 'old' }], { id: 'new', title: 'new' });
  assert.equal(created.created, true);
  const updated = mergeImportedNote(created.notes, { id: 'new', title: 'updated' });
  assert.equal(updated.created, false);
  assert.equal(updated.notes[0].title, 'updated');
});

test('mergeImportedNote preserves manual curation on re-import (P1#1)', () => {
  const existing = {
    id: 'note1',
    title: '旧标题',
    category: '编程开发',   // 用户手动拖拽确定过的分类
    tags: ['手动标签'],
    aiSummary: '已生成的摘要',
    aiExpansion: '已生成的拓展',
    favorite: true,
    readState: 'later',
    lastReadAt: '2026-02-01T00:00:00.000Z',
    savedAt: '2026-01-01T00:00:00.000Z',
  };
  // 重新导入「刷新内容」：只更新内容性字段，category/tags/AI/savedAt 都要保留
  const reimported = {
    id: 'note1',
    title: '新标题',
    category: '其他',       // 机器新推断出的过渡态
    tags: [],
    savedAt: '2026-08-17T00:00:00.000Z',
  };
  const result = mergeImportedNote([existing], reimported);
  assert.equal(result.created, false);
  const merged = result.notes[0];
  assert.equal(merged.title, '新标题');                    // 内容性字段被刷新
  assert.equal(merged.category, '编程开发');               // 手动分类不被机器过渡值顶掉
  assert.deepEqual(merged.tags, ['手动标签']);             // 新 tags 为空时保留旧的
  assert.equal(merged.aiSummary, '已生成的摘要');          // AI 摘要保留
  assert.equal(merged.aiExpansion, '已生成的拓展');        // AI 拓展保留
  assert.equal(merged.savedAt, '2026-01-01T00:00:00.000Z'); // 首次收录时间不顶到最前
  assert.equal(merged.favorite, true);                       // 收藏状态保留
  assert.equal(merged.readState, 'later');                   // 阅读状态保留
  assert.equal(merged.lastReadAt, '2026-02-01T00:00:00.000Z');
});

test('mergeImportedNote re-infers category when old value is transient', () => {
  // 旧分类是「待分类」这种机器过渡态时，应让新推断结果接管
  const result = mergeImportedNote(
    [{ id: 'note1', category: '待分类', tags: ['a'] }],
    { id: 'note1', category: '旅行户外', tags: [] },
  );
  assert.equal(result.notes[0].category, '旅行户外');
  assert.deepEqual(result.notes[0].tags, ['a']);
});

test('removeStoredNote removes only the requested note', () => {
  const first = { id: 'first', title: 'first' };
  const second = { id: 'second', title: 'second' };
  const removed = removeStoredNote([first, second], 'first');
  assert.equal(removed.deletedNote, first);
  assert.deepEqual(removed.notes, [second]);

  const missing = removeStoredNote([second], 'missing');
  assert.equal(missing.deletedNote, null);
  assert.deepEqual(missing.notes, [second]);
});
