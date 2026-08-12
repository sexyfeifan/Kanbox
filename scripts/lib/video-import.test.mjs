import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  isAllowedRemoteVideoUrl,
  localizeNoteVideo,
  reanalyzeStoredNoteVideo,
} from './video-import.mjs';

test('video URL allowlist accepts Xiaohongshu CDN only', () => {
  assert.equal(isAllowedRemoteVideoUrl('https://sns-video-hw.xhscdn.com/a.mp4'), true);
  assert.equal(isAllowedRemoteVideoUrl('https://video.xhsimg.com/a.mp4'), true);
  assert.equal(isAllowedRemoteVideoUrl('https://example.com/a.mp4'), false);
  assert.equal(isAllowedRemoteVideoUrl('http://sns-video-hw.xhscdn.com/a.mp4'), false);
});

test('localizeNoteVideo stores video and offline analysis text without credentials', async () => {
  const mediaDirectory = await mkdtemp(path.join(os.tmpdir(), 'kankan-video-test-'));
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
    assert.equal(note.transcriptText, '第一句文稿\n\n第二句文稿');
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
  const mediaDirectory = await mkdtemp(path.join(os.tmpdir(), 'kankan-video-test-'));
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

test('reanalyzeStoredNoteVideo reuses the local video and removes legacy frame OCR', async () => {
  const mediaDirectory = await mkdtemp(path.join(os.tmpdir(), 'kankan-video-test-'));
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
    assert.equal('videoOcrText' in note, false);
    assert.equal('videoOcrSegments' in note, false);
  } finally {
    await rm(mediaDirectory, { recursive: true, force: true });
  }
});
