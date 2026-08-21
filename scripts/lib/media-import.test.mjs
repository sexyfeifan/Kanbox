import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isAllowedRemoteImageUrl, localizeNoteMedia } from './media-import.mjs';

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test('image URL allowlist accepts Xiaohongshu CDN only', () => {
  assert.equal(isAllowedRemoteImageUrl('https://sns-webpic-qc.xhscdn.com/a.webp'), true);
  assert.equal(isAllowedRemoteImageUrl('https://images.xhsimg.com/a.jpg'), true);
  assert.equal(isAllowedRemoteImageUrl('https://example.com/a.jpg'), false);
  assert.equal(isAllowedRemoteImageUrl('http://sns-webpic-qc.xhscdn.com/a.webp'), false);
});

test('localizeNoteMedia saves images and combines local OCR text', async () => {
  const mediaDirectory = await mkdtemp(path.join(os.tmpdir(), 'kanbox-media-test-'));
  const sourceUrl = 'https://sns-webpic-qc.xhscdn.com/a.png';
  let downloadInit;

  try {
    const note = await localizeNoteMedia({
      id: '64cb12340000000001020304',
      imageUrls: [sourceUrl],
      coverUrl: sourceUrl,
    }, {
      mediaDirectory,
      publicBaseUrl: 'http://127.0.0.1:4318',
      fetchImpl: async (_url, init) => {
        downloadInit = init;
        return new Response(tinyPng, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      },
      ocrRunner: async (paths) => paths.map((imagePath) => ({
        path: imagePath,
        text: '图片里的中文',
      })),
    });

    assert.equal(note.mediaStatus, 'ready');
    assert.equal(note.ocrText, '图片里的中文');
    assert.deepEqual(note.sourceImageUrls, [sourceUrl]);
    assert.deepEqual(note.imageUrls, [
      'http://127.0.0.1:4318/media/64cb12340000000001020304/01.png',
    ]);
    assert.equal(downloadInit.credentials, 'omit');
    assert.doesNotThrow(() => new Headers(downloadInit.headers));
    assert.equal(
      Object.keys(downloadInit.headers).some((name) => name.toLowerCase() === 'cookie'),
      false,
    );
    const stored = await readFile(path.join(
      mediaDirectory,
      '64cb12340000000001020304',
      '01.png',
    ));
    assert.deepEqual(stored, tinyPng);
  } finally {
    await rm(mediaDirectory, { recursive: true, force: true });
  }
});

test('localizeNoteMedia repairs localized images from sourceImageUrls', async () => {
  const mediaDirectory = await mkdtemp(path.join(os.tmpdir(), 'kanbox-media-repair-test-'));
  const noteId = '64cb12340000000001020304';
  const sourceUrl = 'https://sns-webpic-qc.xhscdn.com/original.png';
  try {
    const repaired = await localizeNoteMedia({
      id: noteId,
      imageUrls: [`http://127.0.0.1:4318/media/${noteId}/01.png`],
      sourceImageUrls: [sourceUrl],
      ocrText: '旧 OCR',
      imageOcr: [{ imageUrl: 'local', text: '旧 OCR' }],
      mediaStatus: 'partial',
    }, {
      mediaDirectory,
      publicBaseUrl: 'http://127.0.0.1:4318',
      fetchImpl: async () => new Response(tinyPng, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
      ocrRunner: async (paths) => paths.map((imagePath) => ({ path: imagePath, text: '新 OCR' })),
    });

    assert.deepEqual(repaired.sourceImageUrls, [sourceUrl]);
    assert.equal(repaired.ocrText, '新 OCR');
    assert.equal(repaired.mediaStatus, 'ready');
    assert.equal((await readFile(path.join(mediaDirectory, noteId, '01.png'))).length, tinyPng.length);
  } finally {
    await rm(mediaDirectory, { recursive: true, force: true });
  }
});

test('localizeNoteMedia never clears existing metadata without a recovery source', async () => {
  const original = {
    id: '64cb12340000000001020304',
    imageUrls: ['http://127.0.0.1:4318/media/64cb12340000000001020304/01.png'],
    sourceImageUrls: [],
    ocrText: '不可丢失的 OCR',
    imageOcr: [{ imageUrl: 'local', text: '不可丢失的 OCR' }],
    mediaStatus: 'partial',
  };
  const repaired = await localizeNoteMedia(original, {
    mediaDirectory: '/tmp/kanbox-media-no-write',
    publicBaseUrl: 'http://127.0.0.1:4318',
  });
  assert.deepEqual(repaired.imageUrls, original.imageUrls);
  assert.equal(repaired.ocrText, original.ocrText);
  assert.deepEqual(repaired.imageOcr, original.imageOcr);
});
