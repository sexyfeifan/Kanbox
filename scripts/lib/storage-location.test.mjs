import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  classifyLocation,
  copyDataDirectory,
  icloudDriveRoot,
  icloudKanboxPath,
  isIcloudAvailable,
  localDefaultDataDirectory,
  storageInfo,
  storagePointerPath,
} from './storage-location.mjs';

test('icloudKanboxPath 是 iCloud 根目录下的 kanbox 文件夹', () => {
  assert.equal(icloudKanboxPath(), path.join(icloudDriveRoot(), 'kanbox'));
});

test('localDefaultDataDirectory 是绝对路径且包含 com.kanbox.app', () => {
  const p = localDefaultDataDirectory();
  assert.ok(path.isAbsolute(p));
  assert.ok(p.includes('com.kanbox.app') || p.endsWith('.kanbox'));
});

test('classifyLocation 正确区分 iCloud / 本机 / 自定义', () => {
  assert.equal(classifyLocation(icloudKanboxPath()), 'icloud');
  assert.equal(classifyLocation(localDefaultDataDirectory()), 'local');
  assert.equal(classifyLocation('/tmp/kanbox-custom'), 'custom');
});

test('storagePointerPath 位于本机稳定目录下', () => {
  assert.equal(storagePointerPath(), path.join(localDefaultDataDirectory(), 'storage-location.json'));
});

test('storageInfo 返回完整字段', () => {
  const info = storageInfo(localDefaultDataDirectory());
  assert.equal(info.location, 'local');
  assert.equal(info.localPath, localDefaultDataDirectory());
  assert.equal(typeof info.icloudAvailable, 'boolean');
  if (isIcloudAvailable()) {
    assert.equal(info.icloudPath, icloudKanboxPath());
  } else {
    assert.equal(info.icloudPath, null);
  }
});

test('copyDataDirectory verifies notes and removes the migration marker only after success', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kanbox-storage-migration-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  try {
    await mkdir(source, { recursive: true });
    const notes = '[{"id":"64cb12340000000001020304","title":"测试"}]\n';
    await writeFile(path.join(source, 'notes.json'), notes, 'utf8');
    await copyDataDirectory(source, target);
    assert.equal(await readFile(path.join(target, 'notes.json'), 'utf8'), notes);
    await assert.rejects(readFile(path.join(target, '.kanbox-migration-in-progress'), 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
