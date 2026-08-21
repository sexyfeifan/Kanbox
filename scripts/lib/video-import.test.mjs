import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  isAllowedRemoteVideoUrl,
  localizeNoteVideo,
  reanalyzeStoredNoteVideo,
  reflowTranscriptText,
} from './video-import.mjs';

test('video URL allowlist accepts Xiaohongshu CDN only', () => {
  assert.equal(isAllowedRemoteVideoUrl('https://sns-video-hw.xhscdn.com/a.mp4'), true);
  assert.equal(isAllowedRemoteVideoUrl('https://video.xhsimg.com/a.mp4'), true);
  assert.equal(isAllowedRemoteVideoUrl('https://example.com/a.mp4'), false);
  assert.equal(isAllowedRemoteVideoUrl('http://sns-video-hw.xhscdn.com/a.mp4'), false);
});

test('localizeNoteVideo stores video and offline analysis text without credentials', async () => {
  const mediaDirectory = await mkdtemp(path.join(os.tmpdir(), 'kanbox-video-test-'));
  const sourceVideoUrl = 'https://sns-video-hw.xhscdn.com/a.mp4';
  let downloadInit;
  try {
    const note = await localizeNoteVideo({
      id: '64cb12340000000001020304',
      type: 'video',
      sourceVideoUrl,
    }, {
      mediaDirectory,
      publicBaseUrl: 'http://127.0.0.1:4318',
      fetchImpl: async (_url, init) => {
        downloadInit = init;
        return new Response(Buffer.from('video-bytes'), {
          status: 200,
          headers: { 'Content-Type': 'video/mp4' },
        });
      },
      analyzer: async () => ({
        duration: 65,
        transcriptSegments: [
          { start: 1.2, duration: 2.4, text: '第一句文稿' },
          { start: 62, duration: 2, text: '第二句文稿' },
        ],
      }),
    });

    assert.equal(note.videoStatus, 'ready');
    assert.equal(note.videoUrl, 'http://127.0.0.1:4318/media/64cb12340000000001020304/video.mp4');
    assert.equal(note.transcriptText, '第一句文稿第二句文稿');
    assert.equal(downloadInit.credentials, 'omit');
    assert.equal(Object.keys(downloadInit.headers).some((key) => key.toLowerCase() === 'cookie'), false);
    assert.equal(
      (await readFile(path.join(mediaDirectory, '64cb12340000000001020304', 'video.mp4'))).toString(),
      'video-bytes',
    );
  } finally {
    await rm(mediaDirectory, { recursive: true, force: true });
  }
});

test('localizeNoteVideo keeps a saved video when transcription is unavailable', async () => {
  const mediaDirectory = await mkdtemp(path.join(os.tmpdir(), 'kanbox-video-test-'));
  try {
    const note = await localizeNoteVideo({
      id: '64cb12340000000001020304',
      type: 'video',
      sourceVideoUrl: 'https://sns-video-hw.xhscdn.com/a.mp4',
    }, {
      mediaDirectory,
      publicBaseUrl: 'http://127.0.0.1:4318',
      fetchImpl: async () => new Response(Buffer.from('video'), {
        status: 200,
        headers: { 'Content-Type': 'video/mp4' },
      }),
      analyzer: async () => { throw new Error('设备不支持离线语音识别'); },
    });

    assert.equal(note.videoStatus, 'partial');
    assert.match(note.videoError, /不支持离线/);
    assert.match(note.videoUrl, /video\.mp4$/);
  } finally {
    await rm(mediaDirectory, { recursive: true, force: true });
  }
});

test('localizeNoteVideo can restore video bytes without erasing an existing transcript', async () => {
  const mediaDirectory = await mkdtemp(path.join(os.tmpdir(), 'kanbox-video-repair-test-'));
  const noteId = '64cb12340000000001020304';
  try {
    const note = await localizeNoteVideo({
      id: noteId,
      type: 'video',
      sourceVideoUrl: 'https://sns-video-hw.xhscdn.com/a.mp4',
      transcriptText: '保留的文稿',
      transcriptSegments: [{ start: 0, duration: 1, text: '保留的文稿' }],
      transcriptEngine: 'local',
    }, {
      mediaDirectory,
      publicBaseUrl: 'http://127.0.0.1:4318',
      preserveTranscript: true,
      fetchImpl: async () => new Response(Buffer.from('restored-video'), {
        status: 200,
        headers: { 'Content-Type': 'video/mp4' },
      }),
      analyzer: async () => { throw new Error('不应重新转写'); },
    });

    assert.equal(note.transcriptText, '保留的文稿');
    assert.equal(note.transcriptSegments.length, 1);
    assert.equal(note.videoStatus, 'ready');
    assert.equal(
      (await readFile(path.join(mediaDirectory, noteId, 'video.mp4'))).toString(),
      'restored-video',
    );
  } finally {
    await rm(mediaDirectory, { recursive: true, force: true });
  }
});

test('reanalyzeStoredNoteVideo reuses the local video and preserves legacy frame OCR', async () => {
  const mediaDirectory = await mkdtemp(path.join(os.tmpdir(), 'kanbox-video-test-'));
  const noteId = '64cb12340000000001020304';
  try {
    await mkdir(path.join(mediaDirectory, noteId), { recursive: true });
    await writeFile(path.join(mediaDirectory, noteId, 'video.mp4'), 'video');
    const note = await reanalyzeStoredNoteVideo({
      id: noteId,
      type: 'video',
      videoOcrText: '旧的逐帧 OCR',
      videoOcrSegments: [{ start: 0, text: '旧的逐帧 OCR' }],
    }, {
      mediaDirectory,
      publicBaseUrl: 'http://127.0.0.1:4318',
      analyzer: async () => ({
        duration: 120,
        transcriptSegments: [{ start: 0, duration: 8, text: '完整视频文稿' }],
      }),
    });

    assert.equal(note.transcriptText, '完整视频文稿');
    assert.equal(note.videoUrl, `http://127.0.0.1:4318/media/${noteId}/video.mp4`);
    // 视频重分析不应删除与文稿无关的字段（修复字段级数据丢失）
    assert.equal(note.videoOcrText, '旧的逐帧 OCR');
    assert.deepEqual(note.videoOcrSegments, [{ start: 0, text: '旧的逐帧 OCR' }]);
  } finally {
    await rm(mediaDirectory, { recursive: true, force: true });
  }
});

test('reflowTranscriptText 按句末标点与转折词分段', () => {
  const out = reflowTranscriptText('今天天气很好。我们去了公园散步。公园里有很多人。但是后来下起了雨。于是我们回家了。');
  const paragraphs = out.split('\n\n');
  assert.ok(paragraphs.length >= 3, `应分多段，实际 ${paragraphs.length} 段`);
  assert.ok(paragraphs[0].endsWith('。'));
  // 转折词「但是」「于是」应另起一段
  assert.ok(paragraphs.some((p) => p.startsWith('但是')));
  assert.ok(paragraphs.some((p) => p.startsWith('于是')));
});

test('reflowTranscriptText 空文本返回空串', () => {
  assert.equal(reflowTranscriptText(''), '');
  assert.equal(reflowTranscriptText('   \n  '), '');
});

test('reflowTranscriptText 合并已有换行并规整空白', () => {
  const out = reflowTranscriptText('第一句。\n\n第二句！第三句？');
  assert.equal(out.split('\n\n').length, 1); // 3 句内为一段（上限 3 句）
  assert.ok(!out.includes('  ')); // 无连续空格
  assert.ok(out.includes('第一句。'));
});

test('reflowTranscriptText 无标点长文本按字数硬切兜底', () => {
  // 完全没有标点的长文本：不应退化成「一面墙」，而应按 hardSplitMax 硬切分段
  const long = '这是一段非常长的没有任何标点符号的文本内容它应该被按字数硬切分成多个段落而不是挤在一个段落里展示给用户阅读体验会更好否则就失去了智能分段的意义';
  const out = reflowTranscriptText(long, { maxChars: 20 });
  const paragraphs = out.split('\n\n');
  assert.ok(paragraphs.length >= 2, `无标点长文本应被硬切分段，实际 ${paragraphs.length} 段`);
  for (const p of paragraphs) {
    assert.ok(p.length <= 40, `每段不应超过 hardSplitMax(2×maxChars=40)，实际 ${p.length} 字`);
  }
});

test('localizeNoteVideo deferTranscript 标记待转写而不转写', async () => {
  const mediaDirectory = await mkdtemp(path.join(os.tmpdir(), 'kanbox-video-test-'));
  try {
    const note = await localizeNoteVideo({
      id: '64cb12340000000001020304',
      type: 'video',
      sourceVideoUrl: 'https://sns-video-hw.xhscdn.com/a.mp4',
    }, {
      mediaDirectory,
      publicBaseUrl: 'http://127.0.0.1:4318',
      fetchImpl: async () => new Response(Buffer.from('video-bytes'), { status: 200, headers: { 'Content-Type': 'video/mp4' } }),
      deferTranscript: true,
      analyzer: async () => { throw new Error('不应调用本地转写'); },
    });
    assert.equal(note.transcriptStatus, 'pending');
    assert.equal(note.transcriptText, '');
    assert.equal(note.videoStatus, 'ready');
    assert.equal(note.transcriptSkipped, undefined);
  } finally {
    await rm(mediaDirectory, { recursive: true, force: true });
  }
});
