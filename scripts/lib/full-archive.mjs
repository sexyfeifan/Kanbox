import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { mergeNoteCollections, mergeWorkspaceRecords } from './sync-merge.mjs';

const execFileAsync = promisify(execFile);
const ARCHIVE_SCHEMA = 'kanbox-full-archive';
const ARCHIVE_FORMAT_VERSION = 1;
const SAFE_TOP_LEVEL = new Set(['manifest.json', 'notes.json', 'workspace.json', 'media']);

function portableRelative(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function walkFiles(root, current = root) {
  if (!existsSync(current)) return [];
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(current, entry.name);
    const relative = portableRelative(root, filePath);
    if (entry.isSymbolicLink()) throw new Error(`归档不允许符号链接：${relative}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, filePath));
    else if (entry.isFile()) files.push(filePath);
    else throw new Error(`归档包含不支持的文件类型：${relative}`);
  }
  return files;
}

export function validateArchiveEntryNames(entries) {
  for (const rawEntry of entries) {
    const entry = String(rawEntry || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!entry) continue;
    if (entry.startsWith('/') || entry.includes('\0')) throw new Error('归档包含非法绝对路径');
    const segments = entry.split('/').filter(Boolean);
    if (segments.some((segment) => segment === '..')) throw new Error('归档包含越界路径');
    if (!SAFE_TOP_LEVEL.has(segments[0])) throw new Error(`归档包含未知内容：${segments[0]}`);
    if (segments[0] === 'media' && segments[1] && !/^[0-9a-f]{24}$/i.test(segments[1])) {
      throw new Error('归档包含非法媒体目录');
    }
  }
}

async function buildManifest(root, { notes, deviceId, createdAt }) {
  const files = [];
  for (const filePath of await walkFiles(root)) {
    const relative = portableRelative(root, filePath);
    if (relative === 'manifest.json') continue;
    const fileStats = await stat(filePath);
    files.push({ path: relative, size: fileStats.size, sha256: await sha256File(filePath) });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schema: ARCHIVE_SCHEMA,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    appVersion: '0.8.2',
    createdAt,
    sourceDeviceId: deviceId || '',
    noteCount: notes.length,
    files,
  };
}

export async function verifyExtractedArchive(root) {
  const manifestPath = path.join(root, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('完整归档缺少 manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest?.schema !== ARCHIVE_SCHEMA || manifest?.formatVersion !== ARCHIVE_FORMAT_VERSION) {
    throw new Error('不支持的 Kanbox 完整归档格式');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length > 1_000_000) {
    throw new Error('完整归档文件清单无效');
  }
  validateArchiveEntryNames(['manifest.json', ...manifest.files.map((item) => item?.path)]);

  const expectedPaths = new Set(['manifest.json']);
  for (const item of manifest.files) {
    if (!item || typeof item.path !== 'string' || !Number.isSafeInteger(item.size) || item.size < 0 || !/^[0-9a-f]{64}$/i.test(item.sha256 || '')) {
      throw new Error('完整归档文件清单损坏');
    }
    if (expectedPaths.has(item.path)) throw new Error(`完整归档包含重复文件：${item.path}`);
    expectedPaths.add(item.path);
    const filePath = path.join(root, ...item.path.split('/'));
    const fileInfo = await lstat(filePath).catch(() => null);
    if (!fileInfo?.isFile() || fileInfo.isSymbolicLink()) throw new Error(`完整归档缺少文件：${item.path}`);
    if (fileInfo.size !== item.size || await sha256File(filePath) !== item.sha256) {
      throw new Error(`完整归档校验失败：${item.path}`);
    }
  }

  for (const filePath of await walkFiles(root)) {
    const relative = portableRelative(root, filePath);
    if (!expectedPaths.has(relative)) throw new Error(`完整归档存在未登记文件：${relative}`);
  }
  return manifest;
}

export async function createFullArchive({ dataDirectory, notes, workspace, deviceId, destinationDirectory }) {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'kanbox-archive-'));
  const archiveRoot = path.join(tempDirectory, 'archive');
  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `kanbox-full-${timestamp}.kanbox`;
  const targetDirectory = destinationDirectory || path.join(dataDirectory, 'backups');
  const archivePath = path.join(targetDirectory, fileName);
  const partialPath = `${archivePath}.partial-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(archiveRoot, { recursive: true });
    await Promise.all([
      writeFile(path.join(archiveRoot, 'notes.json'), `${JSON.stringify(notes, null, 2)}\n`, 'utf8'),
      writeFile(path.join(archiveRoot, 'workspace.json'), `${JSON.stringify(workspace, null, 2)}\n`, 'utf8'),
    ]);
    const sourceMedia = path.join(dataDirectory, 'media');
    if (existsSync(sourceMedia)) await cp(sourceMedia, path.join(archiveRoot, 'media'), { recursive: true, force: true });
    const manifest = await buildManifest(archiveRoot, { notes, deviceId, createdAt });
    await writeFile(path.join(archiveRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await mkdir(targetDirectory, { recursive: true });
    await execFileAsync('/usr/bin/ditto', ['-c', '-k', '--norsrc', archiveRoot, partialPath], { timeout: 24 * 60 * 60_000 });
    await rename(partialPath, archivePath);
    const archiveStats = await stat(archivePath);
    return { ok: true, path: archivePath, name: fileName, size: archiveStats.size, noteCount: notes.length };
  } finally {
    await rm(partialPath, { force: true }).catch(() => {});
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function extractAndVerifyArchive(archivePath) {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'kanbox-restore-'));
  try {
    const [{ stdout }, { stdout: rawManifest }] = await Promise.all([
      execFileAsync('/usr/bin/unzip', ['-Z1', archivePath], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 10 * 60_000,
      }),
      execFileAsync('/usr/bin/unzip', ['-p', archivePath, 'manifest.json'], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 10 * 60_000,
      }),
    ]);
    const entries = stdout.split(/\r?\n/).filter(Boolean);
    validateArchiveEntryNames(entries);
    const preliminaryManifest = JSON.parse(rawManifest);
    if (preliminaryManifest?.schema !== ARCHIVE_SCHEMA || !Array.isArray(preliminaryManifest.files)) {
      throw new Error('完整归档清单无效');
    }
    const declaredFiles = new Set(['manifest.json', ...preliminaryManifest.files.map((item) => item?.path)]);
    const actualFiles = entries.filter((entry) => !entry.endsWith('/'));
    if (actualFiles.length !== declaredFiles.size || actualFiles.some((entry) => !declaredFiles.has(entry))) {
      throw new Error('完整归档包含未登记文件');
    }
    const totalUncompressedBytes = preliminaryManifest.files.reduce((total, item) => total + (Number(item?.size) || 0), 0);
    if (!Number.isSafeInteger(totalUncompressedBytes) || totalUncompressedBytes > 100 * 1024 * 1024 * 1024) {
      throw new Error('完整归档解压后超过 100GB 上限');
    }
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', archivePath, tempDirectory], { timeout: 24 * 60 * 60_000 });
    const manifest = await verifyExtractedArchive(tempDirectory);
    return { tempDirectory, manifest };
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function copyFileAtomic(sourcePath, targetPath, options = {}) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.restore-${process.pid}-${randomUUID()}`;
  try {
    await copyFile(sourcePath, tempPath);
    if (options.beforeRename) await options.beforeRename(tempPath, targetPath);
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function restoreMedia(sourceMediaDirectory, targetMediaDirectory, decisions) {
  if (!existsSync(sourceMediaDirectory)) return 0;
  let copied = 0;
  for (const sourcePath of await walkFiles(sourceMediaDirectory)) {
    const relative = portableRelative(sourceMediaDirectory, sourcePath);
    const [noteId] = relative.split('/');
    const decision = decisions.get(noteId) || 'incoming';
    const targetPath = path.join(targetMediaDirectory, ...relative.split('/'));
    if (decision === 'local' && existsSync(targetPath)) continue;
    await copyFileAtomic(sourcePath, targetPath);
    copied += 1;
  }
  return copied;
}

export async function restoreFullArchive({ archivePath, dataDirectory, localNotes, localWorkspace, writeNotes, writeWorkspace }) {
  const { tempDirectory, manifest } = await extractAndVerifyArchive(archivePath);
  try {
    const incomingNotes = JSON.parse(await readFile(path.join(tempDirectory, 'notes.json'), 'utf8'));
    const incomingWorkspace = JSON.parse(await readFile(path.join(tempDirectory, 'workspace.json'), 'utf8'));
    if (!Array.isArray(incomingNotes)) throw new Error('完整归档中的 notes.json 格式不正确');
    const merged = mergeNoteCollections(localNotes, incomingNotes);
    const workspace = mergeWorkspaceRecords(localWorkspace, incomingWorkspace);

    // 媒体逐文件写入临时名后原子替换。中断只会留下完整的旧文件或完整的新文件，
    // 不会出现截断视频；重复恢复可安全续跑。
    const mediaFiles = await restoreMedia(
      path.join(tempDirectory, 'media'),
      path.join(dataDirectory, 'media'),
      merged.decisions,
    );
    await writeNotes(merged.notes);
    await writeWorkspace(workspace);
    return {
      notes: merged.notes,
      workspace,
      ...merged.stats,
      mediaFiles,
      sourceDeviceId: manifest.sourceDeviceId || '',
      total: merged.notes.length,
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
