import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '../..');

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`local-api 提前退出：${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('local-api 启动超时');
}

async function jsonRequest(baseUrl, pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

test('local API batch import and full media archive restore work end to end', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kanbox-e2e-'));
  const dataDirectory = path.join(root, 'data');
  const discoveredLibrary = `${dataDirectory}.kanbox-before-migration-e2e`;
  const discoveredNote = {
    id: 'ffffffffffffffffffffffff',
    title: '自动发现的旧资料',
    savedAt: '2025-01-01T00:00:00.000Z',
    sourceUrl: 'https://www.xiaohongshu.com/explore/ffffffffffffffffffffffff',
  };
  await mkdir(path.join(discoveredLibrary, 'media', discoveredNote.id), { recursive: true });
  await writeFile(path.join(discoveredLibrary, 'notes.json'), `${JSON.stringify([discoveredNote])}\n`);
  await writeFile(path.join(discoveredLibrary, 'workspace.json'), '{"groups":[],"noteGroupMap":{},"knownNoteIds":[]}\n');
  await writeFile(path.join(discoveredLibrary, 'media', discoveredNote.id, 'old.jpg'), 'old-media');
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectRoot, 'scripts/local-api.mjs')], {
    cwd: projectRoot,
    env: {
      ...process.env,
      LOCAL_API_PORT: String(port),
      KANBOX_DATA_DIRECTORY: dataDirectory,
      KANBOX_DEVICE_STATE_PATH: path.join(root, 'device.json'),
      KANBOX_LEGACY_DATA_DIRECTORY: path.join(root, 'legacy'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });

  try {
    await waitForHealth(baseUrl, child);
    const items = Array.from({ length: 12 }, (_, index) => {
      const id = (index + 1).toString(16).padStart(24, '0');
      return {
        note: {
          id,
          sourceUrl: `https://www.xiaohongshu.com/explore/${id}`,
          title: `端到端笔记 ${index + 1}`,
          content: `用于批量导入测试的正文 ${index + 1}`,
          author: { name: 'Kanbox Test' },
        },
      };
    });
    const batch = await jsonRequest(baseUrl, '/notes/import/batch', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
    assert.equal(batch.succeeded, 12);
    assert.equal(batch.failed, 0);
    assert.equal(batch.notes.length, 12);
    const partialBatch = await jsonRequest(baseUrl, '/notes/import/batch', {
      method: 'POST',
      body: JSON.stringify({ items: [items[0], { input: '这不是笔记链接' }] }),
    });
    assert.equal(partialBatch.succeeded, 1);
    assert.equal(partialBatch.failed, 1);
    assert.equal(partialBatch.notes.length, 12, '单条失败不应回滚或重复整批数据');

    const singleStatus = await jsonRequest(baseUrl, `/notes/${items[0].note.id}`, {
      method: 'PATCH', body: JSON.stringify({ favorite: true, readState: 'later' }),
    });
    assert.equal(singleStatus.note.favorite, true);
    assert.equal(singleStatus.note.readState, 'later');
    const batchStatus = await jsonRequest(baseUrl, '/notes/batch-status', {
      method: 'POST', body: JSON.stringify({ ids: [items[1].note.id, items[2].note.id], updates: { readState: 'read' } }),
    });
    assert.equal(batchStatus.updatedCount, 2);
    assert.equal(batchStatus.notes.filter((note) => [items[1].note.id, items[2].note.id].includes(note.id)).every((note) => note.readState === 'read' && note.lastReadAt), true);
    const organized = await jsonRequest(baseUrl, '/notes/batch-organize', {
      method: 'POST', body: JSON.stringify({ ids: [items[0].note.id, items[1].note.id], updates: { addTags: ['待读', '共同'], removeTags: ['共同'], category: '批量整理' } }),
    });
    assert.equal(organized.updatedCount, 2);
    assert.equal(organized.notes.filter((note) => [items[0].note.id, items[1].note.id].includes(note.id)).every((note) => note.category === '批量整理' && note.tags.includes('待读') && !note.tags.includes('共同')), true);
    await assert.rejects(() => jsonRequest(baseUrl, '/notes/batch-organize', {
      method: 'POST', body: JSON.stringify({ ids: [items[0].note.id, 'aaaaaaaaaaaaaaaaaaaaaaaa'], updates: { addTags: ['不应写入'] } }),
    }), /不存在/);
    const afterRejectedOrganize = await jsonRequest(baseUrl, '/notes');
    assert.equal(afterRejectedOrganize.notes.some((note) => note.tags.includes('不应写入')), false, '批量整理校验失败时不得部分写入');
    const initialReview = await jsonRequest(baseUrl, '/daily-review');
    assert.equal(initialReview.review.items.length, 5);
    const configuredReview = await jsonRequest(baseUrl, '/daily-review/settings', {
      method: 'POST', body: JSON.stringify({ count: 3 }),
    });
    assert.equal(configuredReview.review.items.length, 3);
    const reviewNoteId = configuredReview.review.items[0].note.id;
    const deferredReview = await jsonRequest(baseUrl, '/daily-review/action', {
      method: 'POST', body: JSON.stringify({ type: 'later', noteId: reviewNoteId }),
    });
    assert.equal(deferredReview.review.items.find((item) => item.note.id === reviewNoteId)?.status, 'later');
    const reviewed = await jsonRequest(baseUrl, '/daily-review/action', {
      method: 'POST', body: JSON.stringify({ type: 'reviewed', noteId: reviewNoteId }),
    });
    assert.equal(reviewed.review.reviewedCount, 1);
    assert.equal(existsSync(path.join(dataDirectory, 'daily-review.json')), true, '回顾进度必须写入资料库');

    const mediaDirectory = path.join(dataDirectory, 'media', items[0].note.id);
    await mkdir(mediaDirectory, { recursive: true });
    await writeFile(path.join(mediaDirectory, '01.jpg'), Buffer.from('e2e-image-bytes'));
    await writeFile(path.join(mediaDirectory, 'video.mp4'), Buffer.from('e2e-video-bytes'));

    const archive = await jsonRequest(baseUrl, '/data/archive', { method: 'POST', body: '{}' });
    assert.equal(archive.noteCount, 12);
    const archiveResponse = await fetch(`${baseUrl}${archive.downloadUrl}`);
    assert.equal(archiveResponse.ok, true);
    const archiveBytes = Buffer.from(await archiveResponse.arrayBuffer());
    assert.ok(archiveBytes.length > 0);

    await jsonRequest(baseUrl, '/daily-review/action', {
      method: 'POST', body: JSON.stringify({ type: 'reset' }),
    });

    await writeFile(path.join(dataDirectory, 'notes.json'), '[]\n');
    await rm(path.join(dataDirectory, 'media'), { recursive: true, force: true });
    const restoreResponse = await fetch(`${baseUrl}/data/archive/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: archiveBytes,
    });
    const restored = await restoreResponse.json();
    assert.equal(restoreResponse.ok, true, restored.error);
    assert.equal(restored.notes.length, 12);
    assert.equal(restored.added, 12);
    assert.equal(existsSync(path.join(dataDirectory, 'media', items[0].note.id, 'video.mp4')), true);
    assert.equal(await readFile(path.join(dataDirectory, 'media', items[0].note.id, '01.jpg'), 'utf8'), 'e2e-image-bytes');
    const restoredReview = await jsonRequest(baseUrl, '/daily-review');
    assert.equal(restoredReview.review.count, 3);
    assert.equal(restoredReview.review.items.find((item) => item.note.id === reviewNoteId)?.status, 'reviewed', '完整归档应恢复回顾进度');

    const deletedBatch = await jsonRequest(baseUrl, '/notes/batch-delete', {
      method: 'POST', body: JSON.stringify({ ids: [items[10].note.id, items[11].note.id] }),
    });
    assert.equal(deletedBatch.deletedCount, 2);
    assert.equal(deletedBatch.notes.length, 10);

    await jsonRequest(baseUrl, `/notes/${items[1].note.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: '本机较新的标题' }),
    });
    await jsonRequest(baseUrl, `/notes/${items[0].note.id}`, { method: 'DELETE', body: '{}' });
    const staleRestoreResponse = await fetch(`${baseUrl}/data/archive/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: archiveBytes,
    });
    const staleRestore = await staleRestoreResponse.json();
    assert.equal(staleRestoreResponse.ok, true, staleRestore.error);
    assert.equal(staleRestore.notes.some((note) => note.id === items[0].note.id), false, '旧归档不能复活已删除笔记');
    assert.equal(staleRestore.notes.find((note) => note.id === items[1].note.id)?.title, '本机较新的标题');

    const discovery = await jsonRequest(baseUrl, '/libraries/discover');
    const candidate = discovery.candidates.find((item) => item.path === discoveredLibrary);
    assert.ok(candidate, '应发现当前资料库旁的迁移快照');
    await assert.rejects(
      jsonRequest(baseUrl, '/libraries/preview', {
        method: 'POST', body: JSON.stringify({ candidateId: '../../untrusted-path' }),
      }),
      /不存在或已移动/,
    );
    const preview = await jsonRequest(baseUrl, '/libraries/preview', {
      method: 'POST', body: JSON.stringify({ candidateId: candidate.id }),
    });
    assert.equal(preview.preview.added, 1);
    assert.equal(preview.preview.resultNoteCount, staleRestore.notes.length + 1);
    const recoveredLibrary = await jsonRequest(baseUrl, '/libraries/restore', {
      method: 'POST', body: JSON.stringify({ candidateId: candidate.id }),
    });
    assert.equal(recoveredLibrary.notes.some((note) => note.id === discoveredNote.id), true);
    assert.equal(await readFile(path.join(dataDirectory, 'media', discoveredNote.id, 'old.jpg'), 'utf8'), 'old-media');
    assert.ok(recoveredLibrary.safetyArchive, '恢复非空资料库前必须自动创建完整安全归档');
  } catch (error) {
    error.message = `${error.message}\nlocal-api logs:\n${logs}`;
    throw error;
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});
