import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { discoverLibraries, findCandidate } from './library-discovery.mjs';

const NOTE = { id: '64cb12340000000001020304', title: '旧资料', savedAt: '2026-01-02T00:00:00.000Z' };

async function seed(directory, notes = [NOTE]) {
  await mkdir(path.join(directory, 'media', NOTE.id), { recursive: true });
  await writeFile(path.join(directory, 'notes.json'), `${JSON.stringify(notes)}\n`);
  await writeFile(path.join(directory, 'media', NOTE.id, 'image.jpg'), 'image');
}

test('发现当前、已知旧目录、迁移快照和本地完整归档', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kanbox-discovery-'));
  const current = path.join(root, 'current');
  const old = path.join(root, 'old');
  const snapshot = `${old}.kanbox-before-migration-123`;
  try {
    await seed(current, []);
    await seed(old);
    await seed(snapshot, [{ ...NOTE, id: '64cb12340000000001020305' }]);
    await mkdir(path.join(old, 'backups'), { recursive: true });
    await writeFile(path.join(old, 'backups', 'kanbox-full-test.kanbox'), 'archive');
    const candidates = await discoverLibraries({ currentDirectory: current, knownDirectories: [old], homeDirectory: path.join(root, 'home') });
    assert.equal(candidates.filter((item) => item.kind === 'directory').length, 3);
    assert.equal(candidates.filter((item) => item.kind === 'archive').length, 1);
    assert.equal(candidates[0].isCurrent, true);
    assert.equal(candidates.find((item) => item.path === old)?.noteCount, 1);
    assert.equal(candidates.find((item) => item.path === old)?.mediaFiles, 1);
    assert.equal(findCandidate(candidates, candidates[1].id)?.path, candidates[1].path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('损坏 notes.json 作为可见候选返回但明确标记 damaged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kanbox-discovery-damaged-'));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'notes.json'), '{broken');
    const candidates = await discoverLibraries({ currentDirectory: root, homeDirectory: path.join(root, 'home') });
    assert.equal(candidates[0].status, 'damaged');
    assert.match(candidates[0].issue, /无法解析/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('不跟随符号链接候选，也不扫描未知目录', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kanbox-discovery-scope-'));
  const current = path.join(root, 'current');
  const unknown = path.join(root, 'unrelated');
  try {
    await seed(current, []);
    await seed(unknown);
    const candidates = await discoverLibraries({ currentDirectory: current, homeDirectory: path.join(root, 'home') });
    assert.ok(!candidates.some((item) => item.path === unknown));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
