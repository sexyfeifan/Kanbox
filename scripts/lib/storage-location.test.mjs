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
  migrateDataDirectory,
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
    assert.deepEqual(JSON.parse(await readFile(path.join(target, 'notes.json'), 'utf8')), JSON.parse(notes));
    const rootEntries = await import('node:fs/promises').then(({ readdir }) => readdir(root));
    assert.ok(!rootEntries.some((name) => name.includes('migration-in-progress')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const NOTE_A = { id: '64cb12340000000001020304', title: '来源笔记', revision: 2, updatedAt: '2026-08-30T10:00:00.000Z' };
const NOTE_B = { id: '64cb12340000000001020305', title: '目标笔记', revision: 1, updatedAt: '2026-08-20T10:00:00.000Z' };

async function seedLibrary(directory, notes, label) {
  await mkdir(path.join(directory, 'media', notes[0]?.id || 'empty'), { recursive: true });
  await mkdir(path.join(directory, 'backups'), { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, 'notes.json'), `${JSON.stringify(notes)}\n`, 'utf8'),
    writeFile(path.join(directory, 'workspace.json'), `${JSON.stringify({ groups: [{ id: label, name: label }], revision: 1, updatedAt: '2026-08-20T00:00:00.000Z' })}\n`, 'utf8'),
    writeFile(path.join(directory, 'settings.json'), `${JSON.stringify({ owner: label })}\n`, 'utf8'),
    writeFile(path.join(directory, 'media', notes[0]?.id || 'empty', `${label}.jpg`), label, 'utf8'),
    writeFile(path.join(directory, 'backups', `${label}.json`), label, 'utf8'),
  ]);
}

test('目标已有资料时合并笔记、媒体和备份，并保留完整旧目标快照', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kanbox-storage-merge-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  try {
    await seedLibrary(source, [NOTE_A], 'source');
    await seedLibrary(target, [NOTE_B], 'target');
    await writeFile(path.join(source, 'workspace 2.json'), '{"icloudConflictCopy":true}\n', 'utf8');
    const result = await migrateDataDirectory(source, target);
    assert.equal(result.migrated, true);
    assert.equal(result.noteCount, 2);
    assert.ok(result.backup);
    assert.deepEqual((JSON.parse(await readFile(path.join(target, 'notes.json'), 'utf8'))).map((note) => note.id).sort(), [NOTE_A.id, NOTE_B.id]);
    assert.equal(JSON.parse(await readFile(path.join(target, 'settings.json'), 'utf8')).owner, 'source');
    assert.equal(await readFile(path.join(target, 'backups', 'source.json'), 'utf8'), 'source');
    assert.equal(await readFile(path.join(target, 'backups', 'target.json'), 'utf8'), 'target');
    assert.equal(JSON.parse(await readFile(path.join(target, 'workspace 2.json'), 'utf8')).icloudConflictCopy, true);
    assert.deepEqual(JSON.parse(await readFile(path.join(result.backup, 'notes.json'), 'utf8')), [NOTE_B]);
    assert.deepEqual(JSON.parse(await readFile(path.join(source, 'notes.json'), 'utf8')), [NOTE_A]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('七种位置切换组合都从当前活动目录迁移，而不是固定本机目录', async () => {
  const combinations = [
    ['local', 'icloud'], ['icloud', 'local'], ['local', 'custom-a'], ['custom-a', 'local'],
    ['icloud', 'custom-a'], ['custom-a', 'icloud'], ['custom-a', 'custom-b'],
  ];
  const root = await mkdtemp(path.join(os.tmpdir(), 'kanbox-storage-matrix-'));
  try {
    for (const [fromName, toName] of combinations) {
      const caseRoot = path.join(root, `${fromName}-to-${toName}`);
      const source = path.join(caseRoot, fromName);
      const target = path.join(caseRoot, toName);
      await seedLibrary(source, [NOTE_A], fromName);
      const result = await migrateDataDirectory(source, target);
      assert.equal(result.migrated, true, `${fromName} -> ${toName}`);
      assert.equal(JSON.parse(await readFile(path.join(target, 'notes.json'), 'utf8'))[0].id, NOTE_A.id);
      assert.equal(JSON.parse(await readFile(path.join(target, 'settings.json'), 'utf8')).owner, fromName);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('提交前异常不会替换目标或删除源，并保留可恢复迁移标记', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kanbox-storage-interrupt-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  try {
    await seedLibrary(source, [NOTE_A], 'source');
    await seedLibrary(target, [NOTE_B], 'target');
    await assert.rejects(
      migrateDataDirectory(source, target, { beforeCommit: async () => { throw new Error('模拟断电'); } }),
      /模拟断电/,
    );
    assert.deepEqual(JSON.parse(await readFile(path.join(target, 'notes.json'), 'utf8')), [NOTE_B]);
    assert.deepEqual(JSON.parse(await readFile(path.join(source, 'notes.json'), 'utf8')), [NOTE_A]);
    const entries = await import('node:fs/promises').then(({ readdir }) => readdir(root));
    assert.ok(entries.some((name) => name === 'target.kanbox-migration-in-progress.json'));
    assert.ok(!entries.some((name) => name.includes('migration-stage')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('拒绝互相嵌套的源目录和目标目录，避免递归复制资料库', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kanbox-storage-nested-'));
  const source = path.join(root, 'source');
  try {
    await seedLibrary(source, [NOTE_A], 'source');
    await assert.rejects(migrateDataDirectory(source, path.join(source, 'nested')), /不能互相嵌套/);
    await assert.rejects(migrateDataDirectory(source, root), /不能互相嵌套/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('空资料库切换仍迁移设置，而不是错误回退到其他旧目录', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kanbox-storage-empty-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  try {
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'settings.json'), '{"theme":"paper"}\n', 'utf8');
    const result = await migrateDataDirectory(source, target);
    assert.equal(result.migrated, true);
    assert.equal(result.noteCount, 0);
    assert.equal(JSON.parse(await readFile(path.join(target, 'settings.json'), 'utf8')).theme, 'paper');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
