import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildKnowledgeSource,
  buildNoteText,
  buildTimedSegments,
  computePendingAiKinds,
  hasTranscript,
  isAiConfigured,
  isTranscriptEnhanceConfigured,
  loadAiSettings,
  normalizeTranscriptResult,
  parseWavHeader,
  publicAiSettings,
  resolveTranscriptSettings,
  saveAiSettings,
  splitWavIntoChunks,
  stripAiPreamble,
  VideoNeedsTranscriptError,
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

test('computePendingAiKinds 识别待处理的转写/摘要/拓展', () => {
  const aiOn = { enabled: true, endpoint: 'https://x/v1', apiKey: 'k', model: 'm' };
  const aiOff = { enabled: false };
  const video = (extra) => ({ type: 'video', videoUrl: 'http://127.0.0.1/media/x/video.mp4', ...extra });

  // 视频无文稿：只转写，摘要/拓展等文稿就绪后再补排（避免基于标题的浅拓展）。
  assert.deepEqual(computePendingAiKinds(video({}), aiOn), ['transcript']);
  assert.deepEqual(computePendingAiKinds(video({ transcriptText: '已有' }), aiOn), ['summary', 'expansion']);
  assert.deepEqual(computePendingAiKinds(video({ transcriptText: '已有', aiSummary: '有', aiExpansion: '有' }), aiOn), []);
  assert.deepEqual(computePendingAiKinds(video({ transcriptText: '', transcriptSkipped: true }), aiOn), []);
  assert.deepEqual(computePendingAiKinds(video({}), aiOff), ['transcript']);
  assert.deepEqual(computePendingAiKinds({ type: 'normal' }, aiOn), ['summary', 'expansion']);
  assert.deepEqual(computePendingAiKinds({ type: 'normal' }, aiOff), []);
});

test('hasTranscript 判定视频是否已有可用文稿', () => {
  assert.equal(hasTranscript({ type: 'video', transcriptText: '有内容' }), true);
  assert.equal(hasTranscript({ type: 'video', transcriptText: '   ' }), false);
  assert.equal(hasTranscript({ type: 'video' }), false);
  assert.equal(hasTranscript({}), false);
});

test('buildKnowledgeSource 按类型区分内容源', () => {
  // 视频：以文稿为准，且不混入正文（避免把「仅标题/正文」当拓展素材）
  const videoSource = buildKnowledgeSource({ type: 'video', title: '标题', transcriptText: '视频文稿内容' });
  assert.ok(videoSource.includes('【视频文稿】视频文稿内容'));
  assert.ok(!videoSource.includes('【正文】'));
  // 视频无文稿 → null（调用方据此等待转写）
  assert.equal(buildKnowledgeSource({ type: 'video', title: '标题' }), null);
  assert.equal(buildKnowledgeSource({ type: 'video', transcriptText: '   ' }), null);
  // 图文：标题 + 正文 + OCR
  const noteSource = buildKnowledgeSource({ type: 'normal', title: '标题', rawContent: '正文', ocrText: 'OCR' });
  assert.ok(noteSource.includes('【标题】标题'));
  assert.ok(noteSource.includes('【正文】正文'));
  assert.ok(noteSource.includes('【图片文字】OCR'));
  assert.ok(!noteSource.includes('【视频文稿】'));
  assert.equal(buildKnowledgeSource({ type: 'normal' }), '');
});

test('VideoNeedsTranscriptError 携带可判定的 code', () => {
  const err = new VideoNeedsTranscriptError();
  assert.equal(err.code, 'VIDEO_NEEDS_TRANSCRIPT');
  assert.ok(err instanceof Error);
});

/** 构造一段标准 44 字节头 + PCM 的 WAV（16kHz 单声道 16-bit）。 */
function makeWav(seconds, sampleRate = 16000) {
  const bytesPerSec = sampleRate * 2;
  const dataSize = Math.floor(seconds * bytesPerSec);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.alloc(dataSize)]);
}

test('parseWavHeader 解析标准 WAV 头并推算时长', () => {
  const info = parseWavHeader(makeWav(2.5));
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.dataSize, Math.floor(2.5 * 32000));
  assert.ok(Math.abs(info.duration - 2.5) < 0.001);
  assert.throws(() => parseWavHeader(Buffer.alloc(10)), /不是有效的 WAV 数据/);
  assert.throws(() => parseWavHeader(Buffer.alloc(100)), /不是有效的 WAV 文件/);
});

test('splitWavIntoChunks 小音频整体为一片，超阈值按目标时长切块且时间连续', () => {
  const single = splitWavIntoChunks(makeWav(2));
  assert.equal(single.length, 1);
  assert.equal(single[0].startSec, 0);
  assert.ok(Math.abs(single[0].durationSec - 2) < 0.001);

  // 用极小的 maxBase64 强制切块（模拟超长音频触发分片）
  const chunks = splitWavIntoChunks(makeWav(10), 2, 64);
  assert.ok(chunks.length > 1);
  let expectedStart = 0;
  for (const chunk of chunks) {
    assert.ok(Math.abs(chunk.startSec - expectedStart) < 0.001);
    const info = parseWavHeader(chunk.buffer);
    assert.ok(info.dataSize > 0);
    assert.ok(Math.abs(info.duration - chunk.durationSec) < 0.001);
    expectedStart = chunk.startSec + chunk.durationSec;
  }
  assert.ok(Math.abs(expectedStart - 10) < 0.001);
});

test('buildTimedSegments 把分片文本切成句子级带时间码分段', () => {
  const segments = buildTimedSegments([
    { text: '第一句。第二句！', start: 0, duration: 10 },
    { text: '第三句？', start: 10, duration: 5 },
  ]);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].text, '第一句。');
  assert.equal(segments[0].start, 0);
  assert.ok(segments[0].duration > 0 && segments[0].duration < 10);
  assert.equal(segments[1].text, '第二句！');
  assert.ok(segments[1].start > 0);
  assert.equal(segments[2].text, '第三句？');
  assert.equal(segments[2].start, 10);
});

test('stripAiPreamble 摘掉开场白、保留正文、不误删正常内容', () => {
  const withPreamble = '好的，围绕「用AI做日程管理」这个主题，这里整理了一份知识拓展，帮你更系统地理解背后的技术、玩法和实践建议。\n\n1. 第一点\n2. 第二点';
  const stripped = stripAiPreamble(withPreamble);
  assert.ok(!stripped.startsWith('好的'));
  assert.ok(stripped.includes('1. 第一点'));
  assert.ok(stripped.includes('2. 第二点'));

  const clean = '- 要点一\n- 要点二';
  assert.equal(stripAiPreamble(clean), clean);

  assert.equal(stripAiPreamble('这是一个正常的知识点说明'), '这是一个正常的知识点说明');
  assert.equal(stripAiPreamble(''), '');
});
