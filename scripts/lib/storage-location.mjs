/** Kanbox 数据目录解析与安全迁移。 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { mergeNoteCollections, mergeWorkspaceRecords, recordFingerprint } from './sync-merge.mjs';

const DATA_FILES = ['notes.json', 'settings.json', 'workspace.json', 'sync-meta.json'];
const DATA_DIRECTORIES = ['media', 'backups'];
const MIGRATION_CONTROL_NAME = /\.kanbox-(?:migration|before-migration)/;

export function icloudDriveRoot() {
  return path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
}

export function icloudKanboxPath() {
  return path.join(icloudDriveRoot(), 'kanbox');
}

export function localDefaultDataDirectory() {
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'com.kanbox.app')
    : path.join(os.homedir(), '.kanbox');
}

export function storagePointerPath() {
  return path.join(localDefaultDataDirectory(), 'storage-location.json');
}

export function isIcloudAvailable() {
  return existsSync(icloudDriveRoot());
}

function isWritableDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.kanbox-write-probe-${process.pid}`);
    writeFileSync(probe, 'ok', 'utf8');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function readStoragePointer() {
  try {
    const raw = JSON.parse(readFileSync(storagePointerPath(), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    if (raw.location === 'custom') {
      return typeof raw.path === 'string' && raw.path.trim()
        ? { location: 'custom', path: path.resolve(raw.path.trim()) }
        : null;
    }
    if (raw.location === 'local') return { location: 'local', path: localDefaultDataDirectory() };
    if (raw.location === 'icloud') return { location: 'icloud', path: icloudKanboxPath() };
    return null;
  } catch {
    return null;
  }
}

export function writeStoragePointer(location, customPath) {
  mkdirSync(localDefaultDataDirectory(), { recursive: true });
  const record = { location, updatedAt: new Date().toISOString() };
  if (location === 'custom') record.path = path.resolve(String(customPath || ''));
  const pointerPath = storagePointerPath();
  const temporaryPath = `${pointerPath}.${process.pid}.${randomUUID()}.next`;
  writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, pointerPath);
}

export function clearStoragePointer() {
  try { rmSync(storagePointerPath(), { force: true }); } catch {}
}

export function classifyLocation(dir) {
  const resolved = path.resolve(String(dir || ''));
  if (resolved === path.resolve(icloudKanboxPath())) return 'icloud';
  if (resolved === path.resolve(localDefaultDataDirectory())) return 'local';
  return 'custom';
}

export function resolveDataDirectory(hint) {
  const pointer = readStoragePointer();
  if (pointer) {
    const candidate = pointer.location === 'custom' ? pointer.path
      : pointer.location === 'icloud' ? icloudKanboxPath()
        : localDefaultDataDirectory();
    if (pointer.location !== 'icloud' || isIcloudAvailable()) {
      try { mkdirSync(candidate, { recursive: true }); } catch { return localDefaultDataDirectory(); }
      if (isWritableDir(candidate)) return candidate;
    }
    return localDefaultDataDirectory();
  }
  const icloud = icloudKanboxPath();
  if (existsSync(path.join(icloud, 'notes.json'))) {
    return isWritableDir(icloud) ? icloud : (hint && String(hint).trim()) || localDefaultDataDirectory();
  }
  return (hint && String(hint).trim()) || localDefaultDataDirectory();
}

async function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function validNoteId(note) {
  return /^[0-9a-f]{24}$/i.test(String(note?.id || ''));
}

function mergeNotesPreservingUnknown(targetNotes, sourceNotes) {
  if (targetNotes.length === 0) {
    return {
      notes: sourceNotes,
      decisions: new Map(sourceNotes.map((note) => [String(note?.id || ''), 'incoming'])),
      stats: { added: sourceNotes.length, updated: 0, kept: 0, unchanged: 0, conflicts: 0, invalid: 0 },
    };
  }
  const merged = mergeNoteCollections(targetNotes.filter(validNoteId), sourceNotes.filter(validNoteId));
  const unknown = [];
  const seen = new Set();
  for (const note of [...targetNotes, ...sourceNotes].filter((item) => !validNoteId(item))) {
    const key = `${String(note?.id || '')}:${recordFingerprint(note)}`;
    if (!seen.has(key)) { seen.add(key); unknown.push(note); }
  }
  return { ...merged, notes: [...merged.notes, ...unknown] };
}

function mergeSyncMeta(targetMeta, sourceMeta) {
  const tombstones = { ...(targetMeta?.tombstones || {}) };
  for (const [id, incoming] of Object.entries(sourceMeta?.tombstones || {})) {
    const current = tombstones[id];
    const currentRevision = Number(current?.revision) || 0;
    const incomingRevision = Number(incoming?.revision) || 0;
    const currentTime = new Date(current?.updatedAt || 0).getTime() || 0;
    const incomingTime = new Date(incoming?.updatedAt || 0).getTime() || 0;
    if (!current || incomingRevision > currentRevision || (incomingRevision === currentRevision && incomingTime >= currentTime)) {
      tombstones[id] = incoming;
    }
  }
  return { ...(targetMeta || {}), ...(sourceMeta || {}), tombstones };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function countFiles(root) {
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    count += entry.isDirectory() ? await countFiles(path.join(root, entry.name)) : entry.isFile() ? 1 : 0;
  }
  return count;
}

async function copyKnownData(from, to) {
  if (!existsSync(from)) return;
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) {
    if (name === 'storage-location.json' || MIGRATION_CONTROL_NAME.test(name)) continue;
    const source = path.join(from, name);
    const info = await lstat(source);
    // 资料库不跟随符号链接，避免迁移越出用户选择的目录。
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) continue;
    await cp(source, path.join(to, name), { recursive: info.isDirectory(), force: true });
  }
}

async function copySupplementalData(from, to) {
  if (!existsSync(from)) return;
  const known = new Set([...DATA_FILES, ...DATA_DIRECTORIES, 'storage-location.json']);
  for (const name of await readdir(from)) {
    if (known.has(name) || MIGRATION_CONTROL_NAME.test(name)) continue;
    const source = path.join(from, name);
    const info = await lstat(source);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) continue;
    await cp(source, path.join(to, name), { recursive: info.isDirectory(), force: true });
  }
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 当前活动资料库 -> 目标目录的事务迁移。目标已有资料时合并；源目录永不删除。
 * 在目标旁构建暂存目录并校验，提交时把旧目标原子改名为可恢复快照。
 */
export async function migrateDataDirectory(sourceDir, targetDir, options = {}) {
  const source = path.resolve(String(sourceDir || ''));
  const target = path.resolve(String(targetDir || ''));
  if (source === target) return { migrated: false, from: source, to: target, reason: 'same-directory' };
  if (isPathInside(source, target) || isPathInside(target, source)) {
    throw new Error('存储迁移失败：源目录与目标目录不能互相嵌套');
  }
  if (!existsSync(source)) throw new Error('存储迁移失败：当前资料库目录不存在');

  await mkdir(path.dirname(target), { recursive: true });
  const migrationId = `${Date.now()}-${randomUUID()}`;
  const stage = `${target}.kanbox-migration-stage-${migrationId}`;
  const marker = `${target}.kanbox-migration-in-progress.json`;
  const targetExisted = existsSync(target);
  const backup = targetExisted ? `${target}.kanbox-before-migration-${migrationId}` : null;
  await writeJson(marker, { version: 1, migrationId, from: source, to: target, stage, backup, startedAt: new Date().toISOString() });

  try {
    await copyKnownData(target, stage);
    const [targetNotes, sourceNotes, targetWorkspace, sourceWorkspace, targetMeta, sourceMeta] = await Promise.all([
      readJson(path.join(stage, 'notes.json'), []), readJson(path.join(source, 'notes.json'), []),
      readJson(path.join(stage, 'workspace.json'), {}), readJson(path.join(source, 'workspace.json'), {}),
      readJson(path.join(stage, 'sync-meta.json'), {}), readJson(path.join(source, 'sync-meta.json'), {}),
    ]);
    if (!Array.isArray(targetNotes) || !Array.isArray(sourceNotes)) throw new Error('数据迁移失败：notes.json 格式不正确');
    const merged = mergeNotesPreservingUnknown(targetNotes, sourceNotes);
    await mkdir(stage, { recursive: true });
    await Promise.all([
      writeJson(path.join(stage, 'notes.json'), merged.notes),
      writeJson(path.join(stage, 'workspace.json'), mergeWorkspaceRecords(targetWorkspace, sourceWorkspace)),
      writeJson(path.join(stage, 'sync-meta.json'), mergeSyncMeta(targetMeta, sourceMeta)),
    ]);
    // 当前活动资料库设置优先；媒体和历史备份做并集合并。
    if (existsSync(path.join(source, 'settings.json'))) await cp(path.join(source, 'settings.json'), path.join(stage, 'settings.json'), { force: true });
    for (const name of DATA_DIRECTORIES) {
      if (existsSync(path.join(source, name))) await cp(path.join(source, name), path.join(stage, name), { recursive: true, force: true });
    }
    await copySupplementalData(source, stage);
    if (options.beforeCommit) await options.beforeCommit({ source, target, stage, marker, backup });

    const verifiedNotes = await readJson(path.join(stage, 'notes.json'), null);
    if (!Array.isArray(verifiedNotes) || verifiedNotes.length !== merged.notes.length) throw new Error('数据迁移校验失败：笔记数量不一致');
    const sourceMediaFiles = await countFiles(path.join(source, 'media'));
    const stagedMediaFiles = await countFiles(path.join(stage, 'media'));
    if (stagedMediaFiles < sourceMediaFiles) throw new Error('数据迁移校验失败：媒体文件不完整');

    if (targetExisted) await rename(target, backup);
    try {
      await rename(stage, target);
    } catch (error) {
      if (targetExisted && backup && existsSync(backup) && !existsSync(target)) await rename(backup, target);
      throw error;
    }
    // 数据已原子提交后，控制标记清理失败不能把成功迁移误报成失败；下次迁移会覆盖它。
    await rm(marker, { force: true }).catch(() => {});
    return {
      migrated: true, from: source, to: target, backup, noteCount: merged.notes.length,
      sourceNoteCount: sourceNotes.length, targetNoteCount: targetNotes.length,
      mediaFiles: stagedMediaFiles, conflicts: merged.stats.conflicts, ...merged.stats,
    };
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** 兼容首次启动迁移：仅在目标无资料时从本机默认目录复制。 */
export async function migrateDataIfNeeded(targetDir, sourceDir = localDefaultDataDirectory()) {
  const target = path.resolve(String(targetDir || ''));
  const source = path.resolve(String(sourceDir || ''));
  if (source === target || !existsSync(path.join(source, 'notes.json'))) return { migrated: false };
  if (existsSync(path.join(target, 'notes.json')) && !existsSync(`${target}.kanbox-migration-in-progress.json`)) return { migrated: false };
  return migrateDataDirectory(source, target);
}

export async function copyDataDirectory(fromDir, toDir) {
  return migrateDataDirectory(fromDir, toDir);
}

export function storageInfo(dataDirectory) {
  return {
    dataDirectory,
    location: classifyLocation(dataDirectory),
    icloudAvailable: isIcloudAvailable(),
    icloudPath: isIcloudAvailable() ? icloudKanboxPath() : null,
    localPath: localDefaultDataDirectory(),
  };
}
