import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  copyFileAtomic,
  createFullArchive,
  extractAndVerifyArchive,
  validateArchiveEntryNames,
  verifyExtractedArchive,
} from './full-archive.mjs';

test('archive path validation rejects traversal and unknown roots', () => {
  assert.throws(() => validateArchiveEntryNames(['../notes.json']), /越界/);
  assert.throws(() => validateArchiveEntryNames(['/tmp/notes.json']), /绝对路径/);
  assert.throws(() => validateArchiveEntryNames(['settings.json']), /未知内容/);
  assert.doesNotThrow(() => validateArchiveEntryNames(['manifest.json', 'media/0123456789abcdef01234567/video.mp4']));
});

test('full archive includes and verifies image and video bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kanbox-archive-test-'));
  try {
    const noteId = '0123456789abcdef01234567';
    const media = path.join(root, 'data', 'media', noteId);
    await mkdir(media, { recursive: true });
    await writeFile(path.join(media, '01.jpg'), Buffer.from('image-bytes'));
    await writeFile(path.join(media, 'video.mp4'), Buffer.from('video-bytes'));
    const result = await createFullArchive({
      dataDirectory: path.join(root, 'data'),
      destinationDirectory: path.join(root, 'out'),
      notes: [{ id: noteId, title: 'archive test' }],
      workspace: { groups: [], noteGroupMap: {} },
      dailyReview: { version: 1, settings: { count: 5 }, days: { today: {} } },
      syncMeta: { tombstones: { [noteId]: { revision: 2 } } },
      deviceId: 'device-test',
    });
    assert.equal(existsSync(result.path), true);
    const extracted = await extractAndVerifyArchive(result.path);
    try {
      assert.equal(await readFile(path.join(extracted.tempDirectory, 'media', noteId, '01.jpg'), 'utf8'), 'image-bytes');
      assert.equal(await readFile(path.join(extracted.tempDirectory, 'media', noteId, 'video.mp4'), 'utf8'), 'video-bytes');
      assert.equal(JSON.parse(await readFile(path.join(extracted.tempDirectory, 'sync-meta.json'), 'utf8')).tombstones[noteId].revision, 2);
    } finally {
      await rm(extracted.tempDirectory, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest verification detects interrupted or tampered data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kanbox-manifest-test-'));
  try {
    await writeFile(path.join(root, 'notes.json'), '[]\n');
    await writeFile(path.join(root, 'workspace.json'), '{}\n');
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
      schema: 'kanbox-full-archive',
      formatVersion: 1,
      files: [{ path: 'notes.json', size: 3, sha256: '0'.repeat(64) }],
    }));
    await assert.rejects(() => verifyExtractedArchive(root), /校验失败/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('atomic media copy preserves the old file when interrupted before rename', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kanbox-copy-test-'));
  try {
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await writeFile(source, 'new');
    await writeFile(target, 'old');
    await assert.rejects(() => copyFileAtomic(source, target, {
      beforeRename: () => { throw new Error('simulated interruption'); },
    }), /simulated interruption/);
    assert.equal(await readFile(target, 'utf8'), 'old');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
