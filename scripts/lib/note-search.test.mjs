import assert from 'node:assert/strict';
import test from 'node:test';

import { filterNotesByQuery, noteMatchesQuery, parseSearchQuery } from './note-search.mjs';

const note = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  title: '博物馆网页设计',
  rawContent: '介绍胡同历史与沉浸式导览',
  ocrText: '',
  imageOcr: [{ text: '展期 2023.04—2023.06' }],
  author: { name: 'Leo Hong' },
  category: '设计美学',
  tags: ['网页设计', '传统文化'],
  transcriptText: '视频里讲了本地语音转写',
};

test('search covers body, image OCR, author, tags, and group names', () => {
  assert.equal(noteMatchesQuery(note, '胡同 沉浸式'), true);
  assert.equal(noteMatchesQuery(note, '2023.06'), true);
  assert.equal(noteMatchesQuery(note, 'leo hong'), true);
  assert.equal(noteMatchesQuery(note, '传统文化'), true);
  assert.equal(noteMatchesQuery(note, '客户灵感', '客户灵感'), true);
  assert.equal(noteMatchesQuery(note, '本地语音转写'), true);
  assert.equal(noteMatchesQuery(note, '咖啡'), false);
});

test('filter returns all notes for an empty query', () => {
  assert.deepEqual(filterNotesByQuery([note], ''), [note]);
});

test('search supports exact phrases, exclusions, and field qualifiers', () => {
  assert.equal(noteMatchesQuery(note, '"胡同历史" -咖啡'), true);
  assert.equal(noteMatchesQuery(note, '"胡同 导览"'), false, '精确短语不应跨越中间文字');
  assert.equal(noteMatchesQuery(note, 'title:博物馆 tag:传统文化 -author:小王'), true);
  assert.equal(noteMatchesQuery(note, 'ocr:展期 transcript:语音转写'), true);
  assert.equal(noteMatchesQuery(note, 'category:阅读'), false);
});

test('query parser keeps quoted spaces and exclusion semantics', () => {
  assert.deepEqual(parseSearchQuery('title:"网页设计" -tag:商业 author:Leo'), [
    { value: '网页设计', exclude: false, field: 'title', exact: true },
    { value: '商业', exclude: true, field: 'tag', exact: false },
    { value: 'leo', exclude: false, field: 'author', exact: false },
  ]);
});
