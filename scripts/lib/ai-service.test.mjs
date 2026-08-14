import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildNoteText,
  isAiConfigured,
  loadAiSettings,
  maskAiSettings,
  saveAiSettings,
} from './ai-service.mjs';

test('buildNoteText 覆盖图文与视频两类内容', () => {
  const text = buildNoteText({
    title: '标题',
    rawContent: '正文内容',
    ocrText: '图片文字',
    transcriptText: '视频文稿',
  });
  assert.ok(text.includes('【标题】标题'));
  assert.ok(text.includes('【正文】正文内容'));
  assert.ok(text.includes('【图片文字】图片文字'));
  assert.ok(text.includes('【视频文稿】视频文稿'));
});

test('buildNoteText 对空内容返回空串', () => {
  assert.equal(buildNoteText({}), '');
});

test('isAiConfigured 只在 enabled + endpoint + apiKey + model 齐全时为真', () => {
  assert.equal(isAiConfigured({ enabled: true, endpoint: 'https://x/v1', apiKey: 'k', model: 'm' }), true);
  assert.equal(isAiConfigured({ enabled: false, endpoint: 'https://x/v1', apiKey: 'k', model: 'm' }), false);
  assert.equal(isAiConfigured({ enabled: true, endpoint: '', apiKey: 'k', model: 'm' }), false);
  assert.equal(isAiConfigured({ enabled: true, endpoint: 'https://x/v1', apiKey: '', model: 'm' }), false);
  assert.equal(isAiConfigured({ enabled: true, endpoint: 'https://x/v1', apiKey: 'k', model: '' }), false);
});

test('maskAiSettings 不回传密钥原文，仅标记是否已设置', () => {
  const masked = maskAiSettings({ enabled: true, endpoint: 'https://x/v1', apiKey: 'secret', model: 'm', autoTranscript: true });
  assert.equal(masked.apiKey, '');
  assert.equal(masked.apiKeySet, true);
  assert.equal(masked.endpoint, 'https://x/v1');
});

test('saveAiSettings / loadAiSettings 往返并保留默认值', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kanbox-ai-'));
  try {
    await saveAiSettings(dir, { enabled: true, endpoint: 'https://x/v1', apiKey: 'k', model: 'm' });
    const loaded = await loadAiSettings(dir);
    assert.equal(loaded.enabled, true);
    assert.equal(loaded.endpoint, 'https://x/v1');
    assert.equal(loaded.apiKey, 'k');
    assert.equal(loaded.model, 'm');
    assert.equal(loaded.autoTranscript, true); // 默认值兜底
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadAiSettings 在 settings.json 缺失时返回默认值', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kanbox-ai-'));
  try {
    const loaded = await loadAiSettings(dir);
    assert.equal(loaded.enabled, false);
    assert.equal(loaded.model, 'gpt-4o-mini');
    assert.equal(loaded.autoTranscript, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
