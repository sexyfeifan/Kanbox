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
