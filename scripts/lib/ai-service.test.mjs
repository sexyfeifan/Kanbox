import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildNoteText,
  isAiConfigured,
  isTranscriptEnhanceConfigured,
  loadAiSettings,
  normalizeTranscriptResult,
  publicAiSettings,
  resolveTranscriptSettings,
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

test('publicAiSettings 回传密钥原文并标记是否已设置', () => {
  const out = publicAiSettings({ enabled: true, endpoint: 'https://x/v1', apiKey: 'k', model: 'm', autoTranscript: true });
  assert.equal(out.apiKey, 'k');
  assert.equal(out.apiKeySet, true);
  assert.equal(out.endpoint, 'https://x/v1');
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
    assert.equal(loaded.enhanceTranscript, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveTranscriptSettings 转写专用字段优先，留空回退 AI 摘要配置，模型兜底 whisper-1', () => {
  const withDedicated = resolveTranscriptSettings({
    endpoint: 'https://summary/v1',
    apiKey: 'summary-key',
    model: 'gpt-4o-mini',
    transcribeEndpoint: 'https://stt/v1',
    transcribeApiKey: 'stt-key',
    transcribeModel: 'whisper-1',
  });
  assert.deepEqual(withDedicated, { endpoint: 'https://stt/v1', apiKey: 'stt-key', model: 'whisper-1' });

  const fallback = resolveTranscriptSettings({
    endpoint: 'https://summary/v1',
    apiKey: 'summary-key',
    model: 'mimo-v2.5-pro',
    transcribeEndpoint: '',
    transcribeApiKey: '',
    transcribeModel: '',
  });
  assert.deepEqual(fallback, { endpoint: 'https://summary/v1', apiKey: 'summary-key', model: 'mimo-v2.5-pro' });

  const noModel = resolveTranscriptSettings({ endpoint: 'https://summary/v1', apiKey: 'k' });
  assert.equal(noModel.model, 'whisper-1');
});

test('isTranscriptEnhanceConfigured 需 enhanceTranscript=true 且配置齐全', () => {
  assert.equal(isTranscriptEnhanceConfigured({ enhanceTranscript: false }), false);
  assert.equal(isTranscriptEnhanceConfigured({ enhanceTranscript: true, endpoint: '', apiKey: '' }), false);
  assert.equal(isTranscriptEnhanceConfigured({ enhanceTranscript: true, endpoint: 'https://x/v1', apiKey: 'k', model: 'whisper-1' }), true);
  assert.equal(isTranscriptEnhanceConfigured({ enhanceTranscript: true, transcribeEndpoint: 'https://x/v1', transcribeApiKey: 'k' }), true);
});

test('normalizeTranscriptResult 规整 verbose_json 与纯 text 两种返回', () => {
  const verbose = normalizeTranscriptResult({
    text: '第一句 第二句',
    segments: [
      { start: 0, end: 2.5, text: '第一句' },
      { start: 2.5, end: 5, text: '第二句' },
    ],
  });
  assert.equal(verbose.text, '第一句 第二句');
  assert.equal(verbose.segments.length, 2);
  assert.equal(verbose.segments[0].duration, 2.5);

  const plain = normalizeTranscriptResult({ text: '只有一段' });
  assert.equal(plain.text, '只有一段');
  assert.equal(plain.segments.length, 1);
  assert.equal(plain.segments[0].text, '只有一段');

  assert.equal(normalizeTranscriptResult({}).text, '');
  assert.equal(normalizeTranscriptResult({}).segments.length, 0);
});

test('publicAiSettings 同时标记转写密钥', () => {
  const out = publicAiSettings({
    enabled: true,
    endpoint: 'https://x/v1',
    apiKey: 'k',
    transcribeApiKey: 'tk',
  });
  assert.equal(out.apiKey, 'k');
  assert.equal(out.transcribeApiKey, 'tk');
  assert.equal(out.apiKeySet, true);
  assert.equal(out.transcribeApiKeySet, true);
});
