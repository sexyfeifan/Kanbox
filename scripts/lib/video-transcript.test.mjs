import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatMediaTime,
  paginatePlainText,
  paginateTimedSegments,
} from '../../app/lib/video-transcript.mjs';

test('timed transcript pages follow one-minute video intervals', () => {
  const pages = paginateTimedSegments([
    { start: 2, duration: 3, text: '第一页' },
    { start: 61, duration: 4, text: '第二页' },
    { start: 68, duration: 2, text: '仍在第二页' },
  ]);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].map((item) => item.text), ['第一页']);
  assert.deepEqual(pages[1].map((item) => item.text), ['第二页', '仍在第二页']);
});

test('plain text is split into readable pages', () => {
  assert.deepEqual(paginatePlainText('第一段\n\n第二段', 5), ['第一段', '第二段']);
  assert.equal(formatMediaTime(65.8), '1:05');
  assert.equal(formatMediaTime(3661), '1:01:01');
});
