import assert from 'node:assert/strict';
import test from 'node:test';

import { stripDuplicateTagSuffix } from '../../app/lib/note-content.mjs';

test('removes the duplicated Xiaohongshu topic tail and author handle from displayed body', () => {
  const content = '这是正文。\n\n#好视频扶持计划[话题]# #数码好视频[话题]# #AI[话题]#\n@HOWTO薯';
  assert.equal(
    stripDuplicateTagSuffix(content, ['好视频扶持计划', '数码好视频', 'AI']),
    '这是正文。',
  );
});

test('preserves hashtags used inside normal prose', () => {
  const content = '正文里讨论 #AI，也有更多说明。';
  assert.equal(stripDuplicateTagSuffix(content, ['AI']), content);
});
