/**
 * 数据目录解析与 iCloud 同步（v0.7.1）。
 *
 * 收藏内容（notes.json / media/ / settings.json / backups/）的存放位置按以下优先级解析：
 *   1. 用户自定义（storage-location.json 指针文件里的 location='custom'）；
 *   2. iCloud 下的 kanbox 文件夹（用户建议的「第一搜索来源」）；
 *   3. 本机默认目录（~/Library/Application Support/com.kanbox.app）。
 *
 * 指针文件固定放在本机稳定目录（本机默认目录）下，这样无论数据实际存在哪里，
 * 启动时都能先读到指针，避免「数据目录依赖 settings.json、settings.json 又藏在数据目录里」的死循环。
 *
 * 新电脑启用：iCloud 同步会把 kanbox 文件夹带下来，resolveDataDirectory 自动探测到它，
 * 完成数据复原，无需任何手动操作。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** iCloud Drive 根目录（macOS）。 */
export function icloudDriveRoot() {
  return path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
}

/** iCloud 下的 kanbox 数据文件夹路径。 */
export function icloudKanboxPath() {
  return path.join(icloudDriveRoot(), 'kanbox');
}

/** 本机默认数据目录（也是指针文件与日志的稳定存放位置）。 */
export function localDefaultDataDirectory() {
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'com.kanbox.app')
    : path.join(os.homedir(), '.kanbox');
}

/** 指针文件路径（固定放在本机默认目录下）。 */
export function storagePointerPath() {
  return path.join(localDefaultDataDirectory(), 'storage-location.json');
}

export function isIcloudAvailable() {
  return existsSync(icloudDriveRoot());
}

/**
 * 探测目录是否可写（真实写一个探针文件再删除）。iCloud 目录即使存在，也可能因 TCC
 * 权限限制无法写入——此时不能盲目切过去，否则用户会看到空库。不可写则回退本机。
 */
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

/**
 * 读取存储位置指针。返回 null 表示「未设置，走自动探测」。
 * 形状：{ location: 'icloud' | 'local' | 'custom', path?: string }
 */
export function readStoragePointer() {
  try {
    const raw = JSON.parse(readFileSync(storagePointerPath(), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    if (raw.location === 'custom') {
      const p = raw.path;
      return typeof p === 'string' && p.trim() ? { location: 'custom', path: path.resolve(p.trim()) } : null;
    }
    if (raw.location === 'local') return { location: 'local', path: localDefaultDataDirectory() };
    if (raw.location === 'icloud') return { location: 'icloud', path: icloudKanboxPath() };
    return null;
  } catch {
    return null;
  }
}

/** 写入存储位置指针。custom 时需额外提供自定义路径。 */
export function writeStoragePointer(location, customPath) {
  mkdirSync(localDefaultDataDirectory(), { recursive: true });
  const record = { location, updatedAt: new Date().toISOString() };
  if (location === 'custom') record.path = path.resolve(String(customPath || ''));
  writeFileSync(storagePointerPath(), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export function clearStoragePointer() {
  try {
    rmSync(storagePointerPath(), { force: true });
  } catch {
    // 忽略：指针本就不存在
  }
}

/** 判断一个目录属于哪类位置。 */
export function classifyLocation(dir) {
  const resolved = path.resolve(String(dir || ''));
  if (resolved === path.resolve(icloudKanboxPath())) return 'icloud';
  if (resolved === path.resolve(localDefaultDataDirectory())) return 'local';
  return 'custom';
}

/**
 * 解析实际使用的数据目录（同步、只做路径判定，不做数据迁移）。
 * @param {string} [hint] 调用方给的兜底路径（如 main.rs 传的 LOCAL_APP_DATA_DIR）。
 */
export function resolveDataDirectory(hint) {
  const pointer = readStoragePointer();
  if (pointer) {
    if (pointer.location === 'custom' && pointer.path) return pointer.path;
    if (pointer.location === 'local') return localDefaultDataDirectory();
    if (pointer.location === 'icloud') {
      if (isIcloudAvailable()) {
        const p = icloudKanboxPath();
        try {
          mkdirSync(p, { recursive: true });
        } catch {
          return localDefaultDataDirectory();
        }
        return isWritableDir(p) ? p : localDefaultDataDirectory();
      }
      return localDefaultDataDirectory();
    }
  }

  // 自动探测：iCloud kanbox（第一搜索来源）→ 本机默认
  const icloudKanbox = icloudKanboxPath();
  if (existsSync(icloudKanbox)) {
    return isWritableDir(icloudKanbox) ? icloudKanbox : (hint && String(hint).trim()) || localDefaultDataDirectory();
  }
  if (isIcloudAvailable()) {
    try {
      mkdirSync(icloudKanbox, { recursive: true });
    } catch {
      return localDefaultDataDirectory();
    }
    return isWritableDir(icloudKanbox) ? icloudKanbox : localDefaultDataDirectory();
  }
  const hintPath = hint && String(hint).trim() ? String(hint).trim() : '';
  return hintPath || localDefaultDataDirectory();
}

/**
 * 把「本机默认目录」的数据迁移到目标目录（仅当目标还没有 notes.json 且源目录有数据时）。
 * 用于：升级后首次自动切到 iCloud、或用户手动切换自定义位置。
 * 采用「复制」而非「移动」，源目录保留作为兜底，绝不让用户数据看起来丢失。
 */
export async function migrateDataIfNeeded(targetDir) {
  const target = path.resolve(String(targetDir || ''));
  const local = path.resolve(localDefaultDataDirectory());
  if (target === local) return { migrated: false };
  const targetHasNotes = existsSync(path.join(target, 'notes.json'));
  const localHasNotes = existsSync(path.join(local, 'notes.json'));
  if (!targetHasNotes && localHasNotes) {
    await copyDataDirectory(local, target);
    return { migrated: true, from: local, to: target };
  }
  return { migrated: false };
}

async function copyDataDirectory(fromDir, toDir) {
  await mkdir(toDir, { recursive: true });
  for (const name of ['notes.json', 'settings.json']) {
    const src = path.join(fromDir, name);
    if (existsSync(src)) {
      await cp(src, path.join(toDir, name), { force: true }).catch(() => {});
    }
  }
  for (const name of ['media', 'backups']) {
    const src = path.join(fromDir, name);
    if (existsSync(src)) {
      await cp(src, path.join(toDir, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** 供 /storage 端点返回的当前存储位置信息。 */
export function storageInfo(dataDirectory) {
  return {
    dataDirectory,
    location: classifyLocation(dataDirectory),
    icloudAvailable: isIcloudAvailable(),
    icloudPath: isIcloudAvailable() ? icloudKanboxPath() : null,
    localPath: localDefaultDataDirectory(),
  };
}
