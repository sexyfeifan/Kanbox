import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { FALLBACK_CATEGORY, inferCategoryFromNote, reCategorizeNotes } from './lib/category-inference.mjs';
import { recoverCachedNoteCovers } from './lib/cache-cover-recovery.mjs';
import { summarizeNote } from './lib/text-summary.mjs';
import {
  computePendingAiKinds,
  expandWithAi,
  isAiConfigured,
  isTranscriptEnhanceConfigured,
  loadAiSettings,
  publicAiSettings,
  saveAiSettings,
  summarizeWithAi,
  testAi,
  testTranscription,
  transcribeWithAi,
  VideoNeedsTranscriptError,
} from './lib/ai-service.mjs';
import { localizeNoteMedia } from './lib/media-import.mjs';
import { localizeNoteVideo, reanalyzeStoredNoteVideo } from './lib/video-import.mjs';
import { resolveAnonymousNote } from './lib/anonymous-note-resolver.mjs';
import {
  extractNoteIdFromUrl,
  extractSharedNoteUrl,
  isShortLink,
  mergeImportedNote,
  normalizeImportedNote,
  noteFromSharedText,
  parseDraggedCardInput,
  parseDraggedNoteInput,
  prepareBatchImportInputs,
  removeStoredNote,
} from './lib/note-import.mjs';
import {
  icloudKanboxPath,
  isIcloudAvailable,
  localDefaultDataDirectory,
  migrateDataDirectory,
  migrateDataIfNeeded,
  readStorageHistory,
  resolveDataDirectory,
  storageInfo,
  writeStoragePointer,
} from './lib/storage-location.mjs';
import { aiPresets, validateProviderPresets } from './lib/ai-provider-presets.mjs';
import { createFullArchive, extractAndVerifyArchive, restoreFullArchive } from './lib/full-archive.mjs';
import { discoverLibraries, findCandidate } from './lib/library-discovery.mjs';
import {
  applyDailyReviewAction,
  buildDailyReview,
  dailyReviewKey,
  normalizeDailyReviewState,
} from './lib/daily-review.mjs';
import {
  initializeRecord,
  mergeNoteCollections,
  mergeSyncMetadata,
  mergeWorkspaceRecords,
  recordFingerprint,
  resolveNoteConflict,
  stampRecord,
} from './lib/sync-merge.mjs';
import { autoBackupSlot, autoBackupsToRemove, buildMetadataBackup } from './lib/metadata-backup.mjs';
import { findMissingStoredMedia, mergeRepairedMedia } from './lib/integrity-repair.mjs';

const DEFAULT_PORT = 4318;
const MCP_SERVER_NAME = 'kanbox-notes';
const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.LOCAL_API_PORT || `${DEFAULT_PORT}`, 10);
// 数据目录按「自定义 → iCloud kanbox（第一搜索来源）→ 本机默认」优先级解析（v0.7.1）。
// LOCAL_APP_DATA_DIR（main.rs 传的本机默认目录）仅作兜底 hint。
// KANBOX_DATA_DIRECTORY 仅用于隔离的端到端测试和受控维护任务；正式桌面端仍按存储指针解析。
const dataDirectory = process.env.KANBOX_DATA_DIRECTORY
  ? path.resolve(process.env.KANBOX_DATA_DIRECTORY)
  : resolveDataDirectory(process.env.LOCAL_APP_DATA_DIR);
const legacyDataDirectory = process.env.KANBOX_LEGACY_DATA_DIRECTORY
  ? path.resolve(process.env.KANBOX_LEGACY_DATA_DIRECTORY)
  : path.join(os.homedir(), '.kanbox');
const notesFilePath = path.join(dataDirectory, 'notes.json');
const workspaceFilePath = path.join(dataDirectory, 'workspace.json');
const dailyReviewFilePath = path.join(dataDirectory, 'daily-review.json');
// 设备身份必须保存在本机稳定目录，不能跟随 iCloud 数据目录同步，否则两台 Mac
// 会误用同一 deviceId。删除墓碑则保存在共享数据目录，用于阻止旧设备复活已删除笔记。
const syncStateFilePath = process.env.KANBOX_DEVICE_STATE_PATH
  ? path.resolve(process.env.KANBOX_DEVICE_STATE_PATH)
  : path.join(localDefaultDataDirectory(), 'sync-device.json');
const syncMetaFilePath = path.join(dataDirectory, 'sync-meta.json');
const legacyNotesFilePath = path.join(legacyDataDirectory, 'notes.json');
const mediaDirectory = path.join(dataDirectory, 'media');
const publicBaseUrl = `http://127.0.0.1:${PORT}`;
const coverCacheDirectories = process.platform === 'darwin'
  ? [
      path.join(os.homedir(), 'Library', 'Caches', 'com.kanbox.app', 'WebKit', 'NetworkCache'),
      path.join(os.homedir(), 'Library', 'Caches', 'kanbox', 'WebKit', 'NetworkCache'),
    ]
  : [];
let mutationQueue = Promise.resolve();
// 写操作串行锁 + 唯一临时文件名，防止并发写 notes.json 产生交错/损坏（B1 修复）
let writeNotesChain = Promise.resolve();
let writeNotesSeq = 0;
const sseClients = new Set();
// /setup 响应缓存，避免重复串行探测 agent（B10 修复）
let setupResponseCache = null;
let setupResponseCacheAt = 0;
const SETUP_RESPONSE_CACHE_TTL_MS = 30_000;

function broadcastUpdate(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

function firstExistingPath(candidates) {
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function resolveExtensionDirectory() {
  const candidates = [
    path.resolve(scriptDirectory, '../browser-extension'),
    path.resolve(scriptDirectory, 'browser-extension'),
    path.resolve(process.cwd(), 'browser-extension'),
  ];
  return firstExistingPath(candidates.filter((candidate) => existsSync(path.join(candidate, 'manifest.json'))));
}

function resolveMcpServerPath() {
  return firstExistingPath([
    path.resolve(scriptDirectory, 'kanbox-mcp.mjs'),
    path.resolve(scriptDirectory, '../scripts/kanbox-mcp.mjs'),
  ]);
}

function launchDetached(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', (error) => {
    // 避免 open/其它外部命令不存在时产生 unhandled error（B17 修复）
    console.error(`[kanbox] 启动外部命令失败: ${command}`, error?.message || error);
  });
  child.unref();
}

async function resolveAgentExecutable(client) {
  const executableName = client === 'codex' ? 'codex' : 'claude';
  const candidates = client === 'codex'
    ? [
        path.join(os.homedir(), '.codex', 'bin', 'codex'),
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        path.join(os.homedir(), '.local', 'bin', 'codex'),
        path.join(os.homedir(), '.npm-global', 'bin', 'codex'),
        path.join(os.homedir(), 'bin', 'codex'),
      ]
    : [
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        path.join(os.homedir(), '.local', 'bin', 'claude'),
        path.join(os.homedir(), '.claude', 'local', 'claude'),
        path.join(os.homedir(), 'bin', 'claude'),
      ];

  const knownPath = firstExistingPath(candidates);
  if (knownPath) return knownPath;

  // Try multiple shell environments for PATH resolution
  for (const shell of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    try {
      const { stdout } = await execFileAsync(shell, ['-lc', `command -v ${executableName}`], {
        timeout: 2500,
        maxBuffer: 64 * 1024,
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
      });
      const resolved = stdout.trim();
      if (resolved && existsSync(resolved)) return resolved;
    } catch {
      continue;
    }
  }

  return null;
}

async function buildSetupResponse() {
  // 缓存探测结果，避免每次打开设置页都串行探测 agent 造成最多 15s 卡顿（B10 修复）
  const now = Date.now();
  if (setupResponseCache && now - setupResponseCacheAt < SETUP_RESPONSE_CACHE_TTL_MS) {
    return setupResponseCache;
  }
  const extensionDirectory = resolveExtensionDirectory();
  const mcpServerPath = resolveMcpServerPath();
  const [codexPath, claudePath] = await Promise.all([
    resolveAgentExecutable('codex'),
    resolveAgentExecutable('claude'),
  ]);
  let extensionVersion = null;
  if (extensionDirectory) {
    try {
      extensionVersion = JSON.parse(await readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8')).version || null;
    } catch {
      extensionVersion = null;
    }
  }

  setupResponseCache = {
    extension: {
      available: Boolean(extensionDirectory),
      path: extensionDirectory,
      version: extensionVersion,
    },
    agent: {
      available: Boolean(mcpServerPath),
      serverPath: mcpServerPath,
      nodePath: process.execPath,
      dataDirectory,
      clients: {
        codex: { available: Boolean(codexPath) },
        claude: { available: Boolean(claudePath) },
      },
    },
  };
  setupResponseCacheAt = now;
  return setupResponseCache;
}

async function connectAgentClient(client) {
  if (client !== 'codex' && client !== 'claude') {
    throw new Error('不支持的 Agent 客户端');
  }
  const executable = await resolveAgentExecutable(client);
  if (!executable) {
    throw new Error(client === 'codex' ? '没有找到 Codex CLI' : '没有找到 Claude Code');
  }
  const mcpServerPath = resolveMcpServerPath();
  if (!mcpServerPath) throw new Error('本地 Agent 服务文件不存在');

  const removeArgs = client === 'codex'
    ? ['mcp', 'remove', MCP_SERVER_NAME]
    : ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME];
  try {
    await execFileAsync(executable, removeArgs, { timeout: 15000, maxBuffer: 512 * 1024 });
  } catch {
    // A missing previous configuration is expected on first setup.
  }

  const addArgs = client === 'codex'
    ? ['mcp', 'add', MCP_SERVER_NAME, '--env', `LOCAL_APP_DATA_DIR=${dataDirectory}`, '--', process.execPath, mcpServerPath]
    : ['mcp', 'add', '--scope', 'user', MCP_SERVER_NAME, '-e', `LOCAL_APP_DATA_DIR=${dataDirectory}`, '--', process.execPath, mcpServerPath];
  await execFileAsync(executable, addArgs, { timeout: 30000, maxBuffer: 1024 * 1024 });

  return {
    ok: true,
    client,
    serverName: MCP_SERVER_NAME,
    message: client === 'codex'
      ? 'Codex 已连接，重新打开一个任务后可使用'
      : 'Claude Code 已连接，重新打开一个会话后可使用',
  };
}

const mediaContentTypes = new Map([
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

// Kanbox 浏览器扩展的固定 ID（由 manifest.json 的 key 字段派生，Chrome 下稳定）。
// 只放行这一个扩展，而不是信任整个 chrome-extension:// scheme——否则任何已安装的
// Chrome 扩展都能以自身 origin 读走全部笔记和明文 API Key（P1#2）。
const KANBOX_EXTENSION_ID = 'hkbccnanebneecicifkmlhijckfceipf';

// 备份文件 schema 版本：手动与自动备份此前不一致（0.0.3 vs 0.2.0），统一为一个常量，
// 随应用版本号一起 bump（P2#11）。
const BACKUP_VERSION = '0.8.17';

function isAllowedOrigin(origin) {
  if (!origin) return true;
  // P1#2 安全加固：只放行 Kanbox 扩展的固定 ID。manifest.json 已加 `key` 字段，
  // 因此开发（unpacked）和正式发布（.crx）的扩展 ID 都是同一个稳定值
  // KANBOX_EXTENSION_ID，不存在「开发/生产 ID 不同」的问题——不用信任整个
  // chrome-extension:// scheme，否则任何已安装扩展都能读走笔记和明文密钥。
  if (origin === `chrome-extension://${KANBOX_EXTENSION_ID}`) return true;

  try {
    const url = new URL(origin);
    return url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || url.hostname === 'tauri.localhost'
      || url.protocol === 'tauri:';
  } catch {
    return false;
  }
}

function applyCorsHeaders(request, response) {
  const origin = request.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(request, response, statusCode, payload) {
  applyCorsHeaders(request, response);
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function isUsableStoredNote(note) {
  return Boolean(
    note
    && typeof note.id === 'string'
    && note.id.trim()
    && (note.title || note.rawContent || note.coverUrl)
  );
}

async function ensureDataDirectory() {
  await Promise.all([
    mkdir(dataDirectory, { recursive: true }),
    mkdir(mediaDirectory, { recursive: true }),
  ]);
}

let syncStatePromise = null;

async function loadSyncState() {
  await ensureDataDirectory();
  await mkdir(path.dirname(syncStateFilePath), { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(syncStateFilePath, 'utf8'));
    if (parsed && typeof parsed.deviceId === 'string' && /^[0-9a-f-]{36}$/i.test(parsed.deviceId)) {
      return parsed;
    }
  } catch {
    // 首次运行或损坏时创建新的本机设备身份。设备身份不随归档恢复，避免两台设备
    // 共用同一个写入者 ID，导致冲突无法识别。
  }
  const state = { deviceId: randomUUID(), createdAt: new Date().toISOString() };
  const tempPath = `${syncStateFilePath}.${process.pid}.next`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tempPath, syncStateFilePath);
  return state;
}

function getSyncState() {
  if (!syncStatePromise) syncStatePromise = loadSyncState().catch((error) => {
    syncStatePromise = null;
    throw error;
  });
  return syncStatePromise;
}

async function readSyncMeta() {
  try {
    const parsed = JSON.parse(await readFile(syncMetaFilePath, 'utf8'));
    const tombstones = {};
    for (const [id, value] of Object.entries(parsed?.tombstones || {}).slice(-100_000)) {
      if (/^[0-9a-f]{24}$/i.test(id) && value && typeof value === 'object') {
        tombstones[id.toLowerCase()] = {
          revision: Number.isSafeInteger(Number(value.revision)) ? Number(value.revision) : 1,
          updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
          updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy.slice(0, 100) : '',
        };
      }
    }
    return { tombstones };
  } catch {
    return { tombstones: {} };
  }
}

async function writeSyncMeta(meta) {
  await ensureDataDirectory();
  const tempPath = `${syncMetaFilePath}.${process.pid}.${++writeNotesSeq}.next`;
  await writeFile(tempPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  await rename(tempPath, syncMetaFilePath);
}

function tombstoneCoversNote(tombstone, note) {
  if (!tombstone) return false;
  const tombstoneRevision = Number(tombstone.revision) || 1;
  const noteRevision = Number(note?.revision) || 1;
  if (tombstoneRevision !== noteRevision) return tombstoneRevision > noteRevision;
  return new Date(tombstone.updatedAt || 0).getTime() >= new Date(note?.updatedAt || note?.savedAt || 0).getTime();
}

async function applySyncTombstones(notes) {
  const meta = await readSyncMeta();
  return notes.filter((note) => !tombstoneCoversNote(meta.tombstones[note?.id], note));
}

async function recordNoteTombstone(note) {
  const [{ deviceId }, meta] = await Promise.all([getSyncState(), readSyncMeta()]);
  meta.tombstones[note.id] = {
    revision: (Number(note.revision) || 1) + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: deviceId,
  };
  await writeSyncMeta(meta);
}

async function recordNoteTombstones(notes) {
  const [{ deviceId }, meta] = await Promise.all([getSyncState(), readSyncMeta()]);
  const updatedAt = new Date().toISOString();
  for (const note of notes) {
    meta.tombstones[note.id] = {
      revision: (Number(note.revision) || 1) + 1,
      updatedAt,
      updatedBy: deviceId,
    };
  }
  await writeSyncMeta(meta);
}

async function clearNoteTombstone(noteId) {
  const meta = await readSyncMeta();
  if (!meta.tombstones[noteId]) return;
  delete meta.tombstones[noteId];
  await writeSyncMeta(meta);
}

async function readNotesFile(filePath) {
  if (!existsSync(filePath)) return [];
  let raw;
  try {
    raw = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    // 解析失败：先把损坏文件备份下来再返回空，绝不让损坏数据被下一次写操作静默覆盖丢失（B2 修复）
    const corruptPath = `${filePath}.corrupt-${Date.now()}`;
    try {
      await copyFile(filePath, corruptPath);
    } catch {
      // 备份失败也不阻断，但绝不能静默丢弃
    }
    console.error(`[kanbox] ${filePath} 解析失败，已备份到 ${corruptPath}。原始错误:`, error?.message || error);
    return [];
  }
  if (!Array.isArray(raw)) {
    const corruptPath = `${filePath}.corrupt-${Date.now()}`;
    try {
      await copyFile(filePath, corruptPath);
    } catch {
      // ignore
    }
    console.error(`[kanbox] ${filePath} 不是数组，已备份到 ${corruptPath}。`);
    return [];
  }
  // 返回原始数组，不做 isUsableStoredNote 过滤——过滤会在写回前静默丢弃笔记，造成数据丢失
  return raw;
}

async function readNotes() {
  await ensureDataDirectory();
  const [currentNotes, legacyNotes] = await Promise.all([
    readNotesFile(notesFilePath),
    path.resolve(dataDirectory) === path.resolve(legacyDataDirectory)
      ? Promise.resolve([])
      : readNotesFile(legacyNotesFilePath),
  ]);
  const merged = new Map(currentNotes.map((note) => [note.id, note]));
  for (const note of legacyNotes) {
    if (!merged.has(note.id)) merged.set(note.id, note);
  }
  return applySyncTombstones(Array.from(merged.values()));
}

async function writeNotes(notes) {
  await ensureDataDirectory();
  const { deviceId } = await getSyncState();
  // 写入前再次读取共享文件，把另一台设备在本次操作期间同步到本机的更高修订合并进来。
  // 删除项由 sync-meta.json 墓碑过滤，因此不会因这一步被旧文件复活。
  const diskNotes = await readNotesFile(notesFilePath);
  const diskById = new Map(diskNotes.map((note) => [note?.id, note]));
  const normalizedNotes = notes.map((note) => {
    const initialized = initializeRecord(note, { deviceId });
    const diskNote = diskById.get(initialized.id);
    if (!diskNote || recordFingerprint(diskNote) === recordFingerprint(initialized)) return initialized;
    const sameRevision = (Number(diskNote.revision) || 1) === (Number(initialized.revision) || 1);
    const sameTimestamp = String(diskNote.updatedAt || diskNote.savedAt || '') === String(initialized.updatedAt || initialized.savedAt || '');
    // 兼容尚未逐一加 stampRecord 的内部处理（OCR 修复、AI 流水线等）：只要它基于
    // 当前版本产生了内容变化，就在写入边界统一提升修订号，防止合并器把结果丢掉。
    return sameRevision && sameTimestamp ? stampRecord(initialized, { deviceId }) : initialized;
  });
  const convergedNotes = await applySyncTombstones(mergeNoteCollections(diskNotes, normalizedNotes).notes);
  // 串行化所有写操作，并用唯一临时文件名，避免并发写产生交错/损坏的 notes.json（B1 修复）
  const run = async () => {
    const tempPath = path.join(dataDirectory, `notes.${process.pid}.${++writeNotesSeq}.next.json`);
    try {
      await writeFile(tempPath, `${JSON.stringify(convergedNotes, null, 2)}\n`, 'utf8');
      await rename(tempPath, notesFilePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  };
  const result = writeNotesChain.then(run);
  writeNotesChain = result.catch(() => undefined);
  return result;
}

async function writeLegacyNotes(notes) {
  // 与 writeNotes 一致使用唯一临时文件名，避免共享临时名在并发下交错/损坏（P2#6）。
  const legacyTempFilePath = path.join(legacyDataDirectory, `notes.${process.pid}.${++writeNotesSeq}.next.json`);
  await mkdir(legacyDataDirectory, { recursive: true });
  await writeFile(legacyTempFilePath, `${JSON.stringify(notes, null, 2)}\n`, 'utf8');
  await rename(legacyTempFilePath, legacyNotesFilePath);
}

function normalizeWorkspace(value) {
  const source = value && typeof value === 'object' ? value : {};
  const groups = Array.isArray(source.groups)
    ? source.groups
      .filter((group) => group && typeof group.id === 'string' && group.id.trim())
      .slice(0, 200)
      .map((group) => ({
        id: group.id.trim().slice(0, 300),
        name: String(group.name || '新分组').trim().slice(0, 200) || '新分组',
        kind: group.kind === 'custom' ? 'custom' : group.kind === 'inbox' ? 'inbox' : 'auto',
        sourceCategory: typeof group.sourceCategory === 'string' ? group.sourceCategory.trim().slice(0, 200) : '',
      }))
    : [];
  const noteGroupMap = {};
  if (source.noteGroupMap && typeof source.noteGroupMap === 'object') {
    for (const [noteId, groupId] of Object.entries(source.noteGroupMap).slice(0, 100_000)) {
      if (/^[0-9a-f]{24}$/i.test(noteId) && typeof groupId === 'string' && groupId.trim()) {
        noteGroupMap[noteId.toLowerCase()] = groupId.trim().slice(0, 300);
      }
    }
  }
  const knownNoteIds = Array.isArray(source.knownNoteIds)
    ? [...new Set(source.knownNoteIds.filter((id) => typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id)).map((id) => id.toLowerCase()))].slice(0, 100_000)
    : [];
  const revision = Number.isSafeInteger(Number(source.revision)) && Number(source.revision) > 0
    ? Number(source.revision)
    : 1;
  const updatedAt = typeof source.updatedAt === 'string' ? source.updatedAt : '';
  const updatedBy = typeof source.updatedBy === 'string' ? source.updatedBy.slice(0, 100) : '';
  return { groups, noteGroupMap, knownNoteIds, revision, updatedAt, updatedBy };
}

async function readWorkspace() {
  if (!existsSync(workspaceFilePath)) return normalizeWorkspace({});
  try {
    return normalizeWorkspace(JSON.parse(await readFile(workspaceFilePath, 'utf8')));
  } catch (error) {
    const corruptPath = `${workspaceFilePath}.corrupt-${Date.now()}`;
    await copyFile(workspaceFilePath, corruptPath).catch(() => {});
    console.error('[kanbox] workspace.json 解析失败，已保留损坏副本:', error?.message || error);
    return normalizeWorkspace({});
  }
}

async function writeWorkspace(value) {
  await ensureDataDirectory();
  const { deviceId } = await getSyncState();
  const current = existsSync(workspaceFilePath) ? await readWorkspace() : normalizeWorkspace({});
  const normalized = normalizeWorkspace(value);
  const currentRevision = Number(current.revision) || 1;
  const incomingRevision = Number(normalized.revision) || 1;
  const merged = incomingRevision >= currentRevision
    ? normalized
    : mergeWorkspaceRecords(current, normalized);
  const workspace = normalizeWorkspace(stampRecord({
    ...merged,
    revision: Math.max(currentRevision, incomingRevision),
  }, { deviceId }));
  const tempPath = path.join(dataDirectory, `workspace.${process.pid}.${++writeNotesSeq}.next.json`);
  try {
    await writeFile(tempPath, `${JSON.stringify(workspace, null, 2)}\n`, 'utf8');
    await rename(tempPath, workspaceFilePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  return workspace;
}

async function readDailyReviewState() {
  if (!existsSync(dailyReviewFilePath)) return normalizeDailyReviewState({});
  try {
    return normalizeDailyReviewState(JSON.parse(await readFile(dailyReviewFilePath, 'utf8')));
  } catch (error) {
    const corruptPath = `${dailyReviewFilePath}.corrupt-${Date.now()}`;
    await copyFile(dailyReviewFilePath, corruptPath).catch(() => {});
    console.error('[kanbox] daily-review.json 解析失败，已保留损坏副本:', error?.message || error);
    return normalizeDailyReviewState({});
  }
}

async function writeDailyReviewState(value) {
  await ensureDataDirectory();
  const state = normalizeDailyReviewState(value);
  const tempPath = path.join(dataDirectory, `daily-review.${process.pid}.${++writeNotesSeq}.next.json`);
  try {
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tempPath, dailyReviewFilePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  return state;
}

async function getDailyReview() {
  const [notes, state] = await Promise.all([readNotes(), readDailyReviewState()]);
  const built = buildDailyReview(notes, state);
  if (JSON.stringify(built.state) !== JSON.stringify(state)) await writeDailyReviewState(built.state);
  return built.review;
}

async function updateDailyReviewSettings(count) {
  const [notes, state] = await Promise.all([readNotes(), readDailyReviewState()]);
  state.settings.count = Math.max(1, Math.min(20, Number(count) || 5));
  delete state.days[dailyReviewKey()];
  const built = buildDailyReview(notes, state);
  await writeDailyReviewState(built.state);
  return built.review;
}

async function updateDailyReviewAction(action) {
  const [notes, state] = await Promise.all([readNotes(), readDailyReviewState()]);
  const built = applyDailyReviewAction(notes, state, action);
  if (action?.type === 'reviewed') await batchUpdateNoteStatus([action.noteId], { readState: 'read' });
  if (action?.type === 'later') await batchUpdateNoteStatus([action.noteId], { readState: 'later' });
  await writeDailyReviewState(built.state);
  return built.review;
}

async function getAllTags() {
  const notes = await readNotes();
  const tagMap = new Map();
  for (const note of notes) {
    if (!Array.isArray(note.tags)) continue;
    for (const tag of note.tags) {
      tagMap.set(tag, (tagMap.get(tag) || 0) + 1);
    }
  }
  return Array.from(tagMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

async function renameTag(oldName, newName) {
  const cleanedNewName = typeof newName === 'string' ? newName.trim() : '';
  // 空标签名会经 .filter(Boolean) 变成「静默删除该标签」，必须显式拒绝（P1#5）。
  if (!cleanedNewName) throw new Error('标签名不能为空');
  const notes = await readNotes();
  const { deviceId } = await getSyncState();
  let renamedCount = 0;
  const updated = notes.map(note => {
    if (!Array.isArray(note.tags) || !note.tags.includes(oldName)) return note;
    renamedCount++;
    return stampRecord({
      ...note,
      tags: [...new Set(note.tags.map(t => t === oldName ? cleanedNewName : t).filter(Boolean))],
    }, { deviceId });
  });
  await writeNotes(updated);
  broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });
  return { notes: updated, renamedCount };
}

async function deleteTag(tagName) {
  const notes = await readNotes();
  const { deviceId } = await getSyncState();
  let deletedCount = 0;
  const updated = notes.map(note => {
    if (!Array.isArray(note.tags) || !note.tags.includes(tagName)) return note;
    deletedCount++;
    return stampRecord({
      ...note,
      tags: note.tags.filter(t => t !== tagName),
    }, { deviceId });
  });
  await writeNotes(updated);
  broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });
  return { notes: updated, deletedCount };
}

async function readRequestBody(request, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new Error('导入内容过大');
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('导入数据格式不正确');
  }
}

function getLastImportedAt(notes) {
  const timestamps = notes
    .map((note) => new Date(note.savedAt || 0).getTime())
    .filter(Number.isFinite);
  if (timestamps.length === 0) return null;
  // 用 reduce 而非 Math.max(...spread)，避免大数组导致调用栈溢出（B16 修复）
  return new Date(timestamps.reduce((a, b) => Math.max(a, b), -Infinity)).toISOString();
}

function missingStoredMedia(note) {
  return findMissingStoredMedia(note, { mediaDirectory, exists: existsSync });
}

async function checkDataIntegrity() {
  const notes = await readNotes();
  const brokenNotes = notes.flatMap((note) => {
    const missingFiles = missingStoredMedia(note);
    return missingFiles.length > 0
      ? [{ id: note.id, title: note.title || '未命名笔记', missingFiles }]
      : [];
  });

  return {
    totalNotes: notes.length,
    healthyNotes: notes.length - brokenNotes.length,
    brokenNotes,
  };
}

async function prepareNoteIntegrityRepair(note) {
  let repaired = await localizeNoteMedia(note, {
    mediaDirectory,
    publicBaseUrl,
  });

  // 完整性检查会把缺失 video.mp4 的视频笔记列为异常，因此修复动作也必须真正
  // 恢复视频。已有文稿时只补视频文件并保留文稿；没有文稿时交给后台流水线补跑。
  const storedVideoPath = path.join(mediaDirectory, note.id, 'video.mp4');
  if (note.type === 'video' && !existsSync(storedVideoPath)) {
    const aiSettings = await loadAiSettings(dataDirectory);
    const preserveTranscript = Boolean(note.transcriptText || note.transcriptSegments?.length);
    repaired = await localizeNoteVideo(repaired, {
      ...buildTranscriptOptions(aiSettings, { defer: !preserveTranscript }),
      preserveTranscript,
    });
  }

  const remainingFiles = missingStoredMedia(repaired);
  if (remainingFiles.length > 0) {
    throw new Error(`修复后仍缺少 ${remainingFiles.length} 个文件`);
  }
  return repaired;
}

async function repairNoteIntegrity(noteId) {
  const snapshot = await readNotes();
  const note = snapshot.find((item) => item.id === noteId);
  if (!note) return null;
  const repaired = await prepareNoteIntegrityRepair(note);

  return queueMutation(async () => {
    const notes = await readNotes();
    const noteIndex = notes.findIndex((item) => item.id === noteId);
    if (noteIndex < 0) return null;

    const updatedNotes = [...notes];
    updatedNotes[noteIndex] = mergeRepairedMedia(notes[noteIndex], repaired);
    await writeNotes(updatedNotes);
    broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });

    return { notes: updatedNotes, note: repaired };
  });
}

async function repairAllNoteIntegrity() {
  const notes = await readNotes();
  const broken = notes.filter((note) => missingStoredMedia(note).length > 0);
  const prepared = await mapConcurrent(broken, 3, async (note) => {
    try {
      return { ok: true, id: note.id, title: note.title || '未命名笔记', note: await prepareNoteIntegrityRepair(note) };
    } catch (error) {
      return { ok: false, id: note.id, title: note.title || '未命名笔记', error: error instanceof Error ? error.message : '修复失败' };
    }
  });
  const replacements = new Map(prepared.filter((item) => item.ok).map((item) => [item.id, item.note]));

  const updatedNotes = await queueMutation(async () => {
    const current = await readNotes();
    if (replacements.size === 0) return current;
    const merged = current.map((note) => replacements.has(note.id)
      ? mergeRepairedMedia(note, replacements.get(note.id))
      : note);
    await writeNotes(merged);
    broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });
    return merged;
  });
  const integrity = await checkDataIntegrity();
  return {
    notes: updatedNotes,
    requested: broken.length,
    repaired: prepared.filter((item) => item.ok).length,
    failed: prepared.filter((item) => !item.ok).length,
    results: prepared.map((item) => ({ ok: item.ok, id: item.id, title: item.title, ...(item.error ? { error: item.error } : {}) })),
    integrity,
  };
}

async function buildNotesExport() {
  const [notes, workspace] = await Promise.all([readNotes(), readWorkspace()]);
  const exportDate = new Date().toISOString();
  return {
    exportDate,
    version: '1.0',
    noteCount: notes.length,
    notes,
    workspace,
  };
}

// 把可能含换行的字段压成单行，避免破坏 Markdown 的 `## 标题` / 列表结构（P2#12）。
function singleLine(value) {
  return String(value ?? '').replace(/\s*\n+\s*/g, ' ').trim();
}

async function exportNotesMarkdown() {
  const notes = await readNotes();
  let md = `# Kanbox 笔记导出\n\n导出时间: ${new Date().toISOString()}\n笔记总数: ${notes.length}\n\n---\n\n`;

  for (const note of notes) {
    md += `## ${singleLine(note.title || '未命名笔记')}\n\n`;
    md += `- 作者: ${singleLine(note.author?.name || '未知')}\n`;
    md += `- 分类: ${singleLine(note.category || '未分类')}\n`;
    md += `- 保存时间: ${note.savedAt || ''}\n`;
    md += `- 来源: ${singleLine(note.sourceUrl || '')}\n`;
    if (note.tags?.length) md += `- 标签: ${note.tags.map(singleLine).join(', ')}\n`;
    md += `\n`;
    if (note.rawContent || note.content) md += `${note.rawContent || note.content}\n\n`;
    if (note.ocrText) md += `### 图片文字\n${note.ocrText}\n\n`;
    if (note.transcriptText) md += `### 视频文稿\n${note.transcriptText}\n\n`;
    md += `---\n\n`;
  }
  return md;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function exportNotesHtml() {
  const notes = await readNotes();
  let html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Kanbox 笔记导出</title>
<style>body{font-family:-apple-system,sans-serif;max-width:800px;margin:0 auto;padding:40px;color:#333}
h1{color:#829987}h2{border-bottom:1px solid #eee;padding-bottom:8px}meta{color:#666;font-size:13px}
.note{margin-bottom:40px}tags span{background:#f0f0f0;padding:2px 8px;border-radius:4px;font-size:12px;margin-right:4px}</style>
</head><body><h1>Kanbox 笔记导出</h1><p>导出时间: ${new Date().toISOString()} | 笔记总数: ${notes.length}</p>`;

  for (const note of notes) {
    html += `<div class="note"><h2>${escapeHtml(note.title || '未命名笔记')}</h2>`;
    html += `<div class="meta">作者: ${escapeHtml(note.author?.name || '未知')} | 分类: ${escapeHtml(note.category || '未分类')} | ${escapeHtml(note.savedAt || '')}</div>`;
    if (note.sourceUrl && /^https?:\/\//i.test(note.sourceUrl)) html += `<p><a href="${escapeHtml(note.sourceUrl)}" target="_blank">查看原帖</a></p>`;
    if (note.tags?.length) html += `<tags>${note.tags.map(t => `<span>#${escapeHtml(t)}</span>`).join('')}</tags>`;
    if (note.rawContent || note.content) html += `<p>${escapeHtml(note.rawContent || note.content).replace(/\n/g, '<br>')}</p>`;
    if (note.ocrText) html += `<h3>图片文字</h3><p>${escapeHtml(note.ocrText).replace(/\n/g, '<br>')}</p>`;
    if (note.transcriptText) html += `<h3>视频文稿</h3><p>${escapeHtml(note.transcriptText).replace(/\n/g, '<br>')}</p>`;
    html += `</div>`;
  }
  html += `</body></html>`;
  return html;
}

async function createBackup() {
  const [notes, workspace, dailyReview, syncMeta] = await Promise.all([readNotes(), readWorkspace(), readDailyReviewState(), readSyncMeta()]);
  const { deviceId } = await getSyncState();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = path.join(dataDirectory, 'backups');
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `backup-${timestamp}.json`);
  await writeFile(backupPath, JSON.stringify({
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    sourceDeviceId: deviceId,
    notes,
    workspace,
    dailyReview,
    syncMeta,
  }, null, 2), 'utf8');
  const stats = await stat(backupPath);
  return { ok: true, path: backupPath, size: stats.size };
}

async function createArchiveBackup() {
  const [notes, workspace, dailyReview, syncMeta, syncState] = await Promise.all([readNotes(), readWorkspace(), readDailyReviewState(), readSyncMeta(), getSyncState()]);
  const result = await createFullArchive({
    dataDirectory,
    notes,
    workspace,
    dailyReview,
    syncMeta,
    deviceId: syncState.deviceId,
  });
  if (process.platform === 'darwin' && !process.env.KANBOX_DATA_DIRECTORY) {
    launchDetached('/usr/bin/open', ['-R', result.path]);
  }
  return {
    ...result,
    downloadUrl: `/data/archive/download/${encodeURIComponent(result.name)}`,
  };
}

async function discoverLibraryCandidates() {
  return discoverLibraries({ currentDirectory: dataDirectory, knownDirectories: readStorageHistory() });
}

async function resolveLibraryCandidate(id) {
  const candidates = await discoverLibraryCandidates();
  const candidate = findCandidate(candidates, String(id || ''));
  if (!candidate) throw new Error('资料库候选不存在或已移动，请重新扫描');
  if (candidate.isCurrent) throw new Error('当前资料库不需要恢复');
  if (candidate.status === 'damaged') throw new Error(candidate.issue || '候选资料库已损坏');
  return candidate;
}

async function readCandidatePayload(candidate) {
  if (candidate.kind === 'directory') {
    return {
      notes: JSON.parse(await readFile(path.join(candidate.path, 'notes.json'), 'utf8')),
      workspace: existsSync(path.join(candidate.path, 'workspace.json'))
        ? JSON.parse(await readFile(path.join(candidate.path, 'workspace.json'), 'utf8'))
        : {},
      cleanup: async () => {},
    };
  }
  const extracted = await extractAndVerifyArchive(candidate.path);
  try {
    return {
      notes: JSON.parse(await readFile(path.join(extracted.tempDirectory, 'notes.json'), 'utf8')),
      workspace: JSON.parse(await readFile(path.join(extracted.tempDirectory, 'workspace.json'), 'utf8')),
      cleanup: () => rm(extracted.tempDirectory, { recursive: true, force: true }),
      manifest: extracted.manifest,
    };
  } catch (error) {
    await rm(extracted.tempDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function previewLibraryRecovery(candidateId) {
  const candidate = await resolveLibraryCandidate(candidateId);
  const payload = await readCandidatePayload(candidate);
  try {
    if (!Array.isArray(payload.notes)) throw new Error('候选资料库 notes.json 格式不正确');
    const [currentNotes, currentWorkspace] = await Promise.all([readNotes(), readWorkspace()]);
    const merged = mergeNoteCollections(currentNotes, payload.notes);
    const workspace = mergeWorkspaceRecords(currentWorkspace, payload.workspace);
    return {
      candidate,
      currentNoteCount: currentNotes.length,
      candidateNoteCount: payload.notes.length,
      resultNoteCount: merged.notes.length,
      added: merged.stats.added,
      updated: merged.stats.updated,
      kept: merged.stats.kept + merged.stats.unchanged,
      conflicts: merged.stats.conflicts,
      skipped: merged.stats.invalid,
      groupCount: Array.isArray(workspace.groups) ? workspace.groups.length : 0,
      archiveVerified: candidate.kind === 'archive',
    };
  } finally {
    await payload.cleanup();
  }
}

async function restoreLibraryCandidate(candidateId) {
  const candidate = await resolveLibraryCandidate(candidateId);
  const [currentNotes, currentWorkspace, currentDailyReview, currentSyncMeta, syncState] = await Promise.all([readNotes(), readWorkspace(), readDailyReviewState(), readSyncMeta(), getSyncState()]);
  const safetyArchive = currentNotes.length > 0
    ? await createFullArchive({
        dataDirectory,
        notes: currentNotes,
        workspace: currentWorkspace,
        dailyReview: currentDailyReview,
        syncMeta: currentSyncMeta,
        deviceId: syncState.deviceId,
        destinationDirectory: path.join(dataDirectory, 'backups'),
      })
    : null;
  const result = candidate.kind === 'directory'
    ? await migrateDataDirectory(candidate.path, dataDirectory, { preserveTargetSettings: true })
    : await restoreFullArchive({
        archivePath: candidate.path,
        dataDirectory,
        localNotes: currentNotes,
        localWorkspace: currentWorkspace,
        writeNotes,
        writeWorkspace,
        writeDailyReview: writeDailyReviewState,
        writeSyncMetadata: async (incoming) => writeSyncMeta(mergeSyncMetadata(await readSyncMeta(), incoming)),
      });
  const notes = await readNotes();
  broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });
  return { ok: true, candidate, safetyArchive, result, notes, total: notes.length };
}

async function receiveArchiveUpload(request) {
  const contentLength = Number(request.headers['content-length'] || 0);
  const maxBytes = 100 * 1024 * 1024 * 1024;
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error('完整归档超过 100GB 上限');
  const incomingDirectory = path.join(dataDirectory, 'backups', '.incoming');
  await mkdir(incomingDirectory, { recursive: true });
  const archivePath = path.join(incomingDirectory, `restore-${process.pid}-${randomUUID()}.kanbox`);
  const handle = await open(archivePath, 'wx');
  let totalBytes = 0;
  try {
    for await (const chunk of request) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) throw new Error('完整归档超过 100GB 上限');
      await handle.write(buffer);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(archivePath, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  if (totalBytes === 0) {
    await rm(archivePath, { force: true }).catch(() => {});
    throw new Error('完整归档为空');
  }
  return archivePath;
}

async function restoreArchiveUpload(request) {
  const archivePath = await receiveArchiveUpload(request);
  try {
    return await queueMutation(async () => {
      const [localNotes, localWorkspace] = await Promise.all([readNotes(), readWorkspace()]);
      return restoreFullArchive({
        archivePath,
        dataDirectory,
        localNotes,
        localWorkspace,
        writeNotes,
        writeWorkspace,
        writeDailyReview: writeDailyReviewState,
        writeSyncMetadata: async (incoming) => writeSyncMeta(mergeSyncMetadata(await readSyncMeta(), incoming)),
      });
    });
  } finally {
    await rm(archivePath, { force: true }).catch(() => {});
  }
}

async function sendArchiveDownload(request, response, fileName) {
  if (!/^kanbox-full-[0-9T-]+\.kanbox$/i.test(fileName)) return false;
  const archivePath = path.join(dataDirectory, 'backups', fileName);
  try {
    const fileStats = await stat(archivePath);
    applyCorsHeaders(request, response);
    response.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': fileStats.size,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    });
    const stream = createReadStream(archivePath);
    stream.on('error', () => response.destroy());
    request.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch {
    sendJson(request, response, 404, { ok: false, error: '完整归档不存在' });
  }
  return true;
}

async function restoreFromBackup(body) {
  if (!body || !Array.isArray(body.notes)) {
    throw new Error('备份文件格式不正确');
  }

  const [existingNotes, existingWorkspace] = await Promise.all([readNotes(), readWorkspace()]);
  const validIncoming = body.notes.filter((note) => note
    && typeof note.id === 'string'
    && /^[0-9a-f]{24}$/i.test(note.id)
    && isUsableStoredNote(note));
  const merged = mergeNoteCollections(existingNotes, validIncoming);
  await writeNotes(merged.notes);
  if (body.workspace && typeof body.workspace === 'object') {
    await writeWorkspace(mergeWorkspaceRecords(existingWorkspace, body.workspace));
  }
  if (body.dailyReview && typeof body.dailyReview === 'object') await writeDailyReviewState(body.dailyReview);
  if (body.syncMeta && typeof body.syncMeta === 'object') {
    await writeSyncMeta(mergeSyncMetadata(await readSyncMeta(), body.syncMeta));
  }
  const finalNotes = await readNotes();
  broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });
  return {
    notes: finalNotes,
    imported: merged.stats.added,
    updated: merged.stats.updated,
    kept: merged.stats.kept + merged.stats.unchanged,
    conflicts: merged.stats.conflicts,
    skipped: body.notes.length - validIncoming.length,
    total: finalNotes.length,
  };
}

async function runAutoBackup() {
  try {
    const [notes, workspace, dailyReview, syncMeta, syncState] = await Promise.all([
      readNotes(), readWorkspace(), readDailyReviewState(), readSyncMeta(), getSyncState(),
    ]);
    if (notes.length === 0) return;

    const backupDir = path.join(dataDirectory, 'backups');
    await mkdir(backupDir, { recursive: true });

    const now = new Date();
    const backupPath = path.join(backupDir, `auto-backup-${autoBackupSlot(now)}.json`);

    // Don't overwrite if already exists today
    if (existsSync(backupPath)) return;

    const payload = buildMetadataBackup({
      version: BACKUP_VERSION, now, deviceId: syncState.deviceId,
      notes, workspace, dailyReview, syncMeta,
    });
    const tempPath = `${backupPath}.${process.pid}.next`;
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    JSON.parse(await readFile(tempPath, 'utf8'));
    await rename(tempPath, backupPath);

    console.log(`Auto-backup created: ${backupPath}`);

    // 保留最近 14 个六小时快照（约 3.5 天）；兼容并计入旧版每日快照。
    for (const old of autoBackupsToRemove(await readdir(backupDir), 14)) {
      await rm(path.join(backupDir, old), { force: true });
    }
  } catch (error) {
    console.error('Auto-backup failed:', error.message);
  }
}

async function getDataInfo() {
  const notes = await readNotes();
  let mediaSize = 0;
  try {
    const mediaFiles = await readdir(mediaDirectory).catch(() => []);
    for (const dir of mediaFiles) {
      const dirPath = path.join(mediaDirectory, dir);
      const files = await readdir(dirPath).catch(() => []);
      for (const file of files) {
        const fileStat = await stat(path.join(dirPath, file)).catch(() => null);
        if (fileStat) mediaSize += fileStat.size;
      }
    }
  } catch {}

  let backupCount = 0;
  try {
    const backupDir = path.join(dataDirectory, 'backups');
    const backups = await readdir(backupDir).catch(() => []);
    backupCount = backups.filter(f => f.endsWith('.json') || f.endsWith('.kanbox')).length;
  } catch {}

  return {
    dataDirectory,
    notesCount: notes.length,
    mediaSize,
    backupCount,
  };
}

const METADATA_BACKUP_NAME = /^(?:auto-backup-\d{4}-\d{2}-\d{2}(?:-\d{2})?|backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.json$/;

async function readStoredMetadataBackup(name) {
  const safeName = String(name || '');
  if (!METADATA_BACKUP_NAME.test(safeName) || path.basename(safeName) !== safeName) throw new Error('备份名称无效');
  const backupPath = path.join(dataDirectory, 'backups', safeName);
  const fileStats = await stat(backupPath);
  if (!fileStats.isFile() || fileStats.size > 500 * 1024 * 1024) throw new Error('备份文件无效或过大');
  const payload = JSON.parse(await readFile(backupPath, 'utf8'));
  if (!Array.isArray(payload?.notes)) throw new Error('备份内容损坏');
  return { payload, fileStats };
}

async function listStoredMetadataBackups() {
  const backupDir = path.join(dataDirectory, 'backups');
  const items = [];
  for (const name of (await readdir(backupDir).catch(() => [])).filter((file) => METADATA_BACKUP_NAME.test(file)).slice(-200)) {
    try {
      const { payload, fileStats } = await readStoredMetadataBackup(name);
      items.push({ name, type: payload.type === 'auto' ? 'auto' : 'manual', exportedAt: payload.exportedAt || fileStats.mtime.toISOString(), noteCount: payload.notes.length, size: fileStats.size, status: 'healthy' });
    } catch (error) {
      const fileStats = await stat(path.join(backupDir, name)).catch(() => null);
      items.push({ name, type: name.startsWith('auto-') ? 'auto' : 'manual', exportedAt: fileStats?.mtime?.toISOString() || '', noteCount: 0, size: fileStats?.size || 0, status: 'damaged', issue: error instanceof Error ? error.message : '备份损坏' });
    }
  }
  return items.sort((a, b) => String(b.exportedAt).localeCompare(String(a.exportedAt)) || b.name.localeCompare(a.name));
}

async function previewStoredMetadataBackup(name) {
  const { payload } = await readStoredMetadataBackup(name);
  const current = await readNotes();
  const merged = mergeNoteCollections(current, payload.notes);
  return { name, current: current.length, result: merged.notes.length, added: merged.stats.added, updated: merged.stats.updated, kept: merged.stats.kept + merged.stats.unchanged, conflicts: merged.stats.conflicts, skipped: merged.stats.invalid };
}

async function buildNotesResponse() {
  const notes = await readNotes();
  return {
    notes,
    lastImportedAt: getLastImportedAt(notes),
  };
}

async function prepareNoteImport(body = {}) {
  const draggedPayload = body.note || parseDraggedNoteInput(body.input);
  const draggedCard = draggedPayload ? null : parseDraggedCardInput(body.input);
  let normalized;

  if (draggedPayload) {
    normalized = normalizeImportedNote(draggedPayload);
    // 扩展发来的数据可能缺少正文/配图（如右键收藏、页面加载不完整）。
    // 借鉴原始项目：此时用匿名解析补全，而不是保存空壳。
    if (!normalized.content && normalized.imageUrls.length === 0 && normalized.sourceUrl) {
      try {
        const noteId = extractNoteIdFromUrl(normalized.sourceUrl);
        if (noteId) {
          const resolved = await resolveAnonymousNote(normalized.sourceUrl, {
            expectedNoteId: noteId,
          });
          normalized = normalizeImportedNote({
            ...resolved,
            title: resolved.title || normalized.title,
            id: normalized.id,
          });
        }
      } catch {
        // 匿名解析失败，保留原始数据（至少有标题和链接）
      }
    }
  } else if (draggedCard) {
    const resolved = await resolveAnonymousNote(draggedCard.sourceUrl, {
      expectedNoteId: draggedCard.id,
    });
    normalized = normalizeImportedNote({
      ...resolved,
      title: resolved.title || draggedCard.title,
    });
  } else {
    try {
      normalized = noteFromSharedText(body.input);
    } catch {
      const sourceUrl = extractSharedNoteUrl(body.input);
      // 短链（xhslink.com）无法直接从 pathname 提取 noteId，交给匿名解析器展开重定向
      if (isShortLink(sourceUrl)) {
        normalized = normalizeImportedNote(await resolveAnonymousNote(sourceUrl));
      } else {
        const noteId = extractNoteIdFromUrl(sourceUrl);
        if (!noteId) {
          // 不是可识别的笔记链接（可能是搜索页 URL 或非笔记页面）。
          // 借鉴原始项目的明确指引，告诉用户正确的导入方式，而不是含糊的「需要匿名解析正文」。
          throw new Error('没有识别到小红书笔记链接。请打开笔记详情页拖动右下角的「拖到 Kanbox」按钮，或从小红书搜索结果页直接拖动笔记卡片');
        }
        normalized = normalizeImportedNote(await resolveAnonymousNote(sourceUrl, {
          expectedNoteId: noteId,
        }));
      }
    }
  }
  if (normalized.type === 'video' && !normalized.sourceVideoUrl) {
    throw new Error('没有读取到视频地址，请在笔记详情页播放几秒后重新导入');
  }
  const withImages = await localizeNoteMedia(normalized, {
    mediaDirectory,
    publicBaseUrl,
  });
  const aiSettings = await loadAiSettings(dataDirectory);
  // 增强转写延迟到收录后的后台流水线：导入阶段只下载视频、不转写，让收录快速返回。
  const imported = await localizeNoteVideo(withImages, buildTranscriptOptions(aiSettings, { defer: true }));
  const note = {
    ...imported,
    category: inferCategoryFromNote(imported),
    savedAt: new Date().toISOString(),
  };
  const { deviceId } = await getSyncState();
  return { note: initializeRecord(note, { deviceId }), aiSettings };
}

async function commitNoteImport(note, aiSettings) {
  await clearNoteTombstone(note.id);
  const existingNotes = await readNotes();
  const merged = mergeImportedNote(existingNotes, note);
  const mergedIndex = merged.notes.findIndex((entry) => entry.id === note.id);
  if (!merged.created && mergedIndex >= 0) {
    const { deviceId } = await getSyncState();
    merged.notes[mergedIndex] = stampRecord(merged.notes[mergedIndex], { deviceId });
  }
  await writeNotes(merged.notes);
  broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });

  // 收录成功后 5 秒，后台流水线自动执行：音转字（若被延迟/遗漏）→ AI 摘要 → 知识拓展
  if (aiSettings.autoPipeline !== false) {
    const mergedNote = merged.notes.find((entry) => entry.id === note.id) || note;
    const autoKinds = computePendingAiKinds(mergedNote, aiSettings);
    if (autoKinds.length > 0) {
      enqueuePipeline(note.id, autoKinds, { delayMs: AUTO_PIPELINE_DELAY_MS });
    }
  }

  return {
    notes: merged.notes,
    note: merged.notes[mergedIndex] || note,
    created: merged.created,
    lastImportedAt: (merged.notes[mergedIndex] || note).savedAt,
  };
}

async function deleteNote(noteId) {
  const existingNotes = await readNotes();
  const removed = removeStoredNote(existingNotes, noteId);
  if (!removed.deletedNote) return null;
  await recordNoteTombstone(removed.deletedNote);

  if (path.resolve(dataDirectory) !== path.resolve(legacyDataDirectory) && existsSync(legacyNotesFilePath)) {
    const legacyNotes = await readNotesFile(legacyNotesFilePath);
    const legacyRemoved = removeStoredNote(legacyNotes, noteId);
    if (legacyRemoved.deletedNote) await writeLegacyNotes(legacyRemoved.notes);
  }

  await writeNotes(removed.notes);
  await rm(path.join(mediaDirectory, noteId), { recursive: true, force: true });
  broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });

  return {
    notes: removed.notes,
    deletedId: noteId,
    lastImportedAt: getLastImportedAt(removed.notes),
  };
}

async function updateNote(noteId, updates = {}) {
  const existingNotes = await readNotes();
  const noteIndex = existingNotes.findIndex((note) => note.id === noteId);
  if (noteIndex < 0) return null;

  const note = existingNotes[noteIndex];
  const { deviceId } = await getSyncState();
  const updated = { ...note };

  if (typeof updates.title === 'string') {
    const cleaned = updates.title.replace(/\s+/g, ' ').trim().slice(0, 300);
    updated.title = cleaned || '未命名笔记';
  }
  if (Array.isArray(updates.tags)) {
    updated.tags = [...new Set(updates.tags.map(t => String(t || '').trim()).filter(Boolean).slice(0, 20))];
  }
  if (typeof updates.favorite === 'boolean') updated.favorite = updates.favorite;
  if (['unread', 'read', 'later'].includes(updates.readState)) {
    updated.readState = updates.readState;
    if (updates.readState === 'read') updated.lastReadAt = new Date().toISOString();
  }

  // 分类：显式传入（拖拽到某个分类分组）时以传入值为准，否则按内容重新推断。
  // 之前这里无条件 inferCategoryFromNote，会吞掉前端拖拽改分类的意图——拖到新分类刷新后又弹回原分类。
  if (typeof updates.category === 'string') {
    const cleanedCategory = updates.category.trim();
    updated.category = cleanedCategory || FALLBACK_CATEGORY;
  } else {
    updated.category = inferCategoryFromNote(updated);
  }

  const updatedNotes = [...existingNotes];
  updatedNotes[noteIndex] = updates.resolveSyncConflict === true
    ? resolveNoteConflict(updated, { deviceId })
    : stampRecord(updated, { deviceId });
  await writeNotes(updatedNotes);
  broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });

  return {
    notes: updatedNotes,
    note: updatedNotes[noteIndex],
    lastImportedAt: getLastImportedAt(updatedNotes),
  };
}

function queueNoteUpdate(noteId, updates) {
  return queueMutation(() => updateNote(noteId, updates));
}

async function batchUpdateNoteStatus(ids, updates) {
  const requested = new Set((Array.isArray(ids) ? ids : []).filter((id) => /^[0-9a-f]{24}$/i.test(String(id))).map((id) => String(id).toLowerCase()).slice(0, 100_000));
  if (requested.size === 0) throw new Error('请选择需要更新的笔记');
  const allowed = {};
  if (typeof updates?.favorite === 'boolean') allowed.favorite = updates.favorite;
  if (['unread', 'read', 'later'].includes(updates?.readState)) allowed.readState = updates.readState;
  if (Object.keys(allowed).length === 0) throw new Error('没有可更新的状态');
  const notes = await readNotes();
  const { deviceId } = await getSyncState();
  const now = new Date().toISOString();
  let updatedCount = 0;
  const next = notes.map((note) => {
    if (!requested.has(note.id)) return note;
    updatedCount += 1;
    return stampRecord({
      ...note,
      ...allowed,
      ...(allowed.readState === 'read' ? { lastReadAt: now } : {}),
    }, { deviceId });
  });
  await writeNotes(next);
  broadcastUpdate({ type: 'notes-changed', timestamp: now });
  return { notes: next, updatedCount };
}

function requestedNoteIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('请选择需要整理的笔记');
  if (ids.length > 100_000) throw new Error('一次最多整理 100000 条笔记');
  const normalized = ids.map((id) => String(id || '').toLowerCase());
  if (normalized.some((id) => !/^[0-9a-f]{24}$/i.test(id))) throw new Error('批量操作包含无效笔记 ID');
  return new Set(normalized);
}

function normalizeBatchTags(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((tag) => String(tag || '').replace(/\s+/g, ' ').trim().slice(0, 50))
    .filter(Boolean))].slice(0, 20);
}

async function batchOrganizeNotes(ids, updates = {}) {
  const requested = requestedNoteIds(ids);
  const addTags = normalizeBatchTags(updates.addTags);
  const removeTags = new Set(normalizeBatchTags(updates.removeTags));
  const category = typeof updates.category === 'string' ? updates.category.replace(/\s+/g, ' ').trim().slice(0, 50) : '';
  if (addTags.length === 0 && removeTags.size === 0 && !category) throw new Error('请选择标签或分类整理操作');
  const notes = await readNotes();
  const found = new Set(notes.filter((note) => requested.has(note.id)).map((note) => note.id));
  if (found.size !== requested.size) throw new Error(`有 ${requested.size - found.size} 条笔记不存在，未执行批量整理`);
  const { deviceId } = await getSyncState();
  let updatedCount = 0;
  const next = notes.map((note) => {
    if (!requested.has(note.id)) return note;
    const tags = [...new Set([
      ...(Array.isArray(note.tags) ? note.tags : []).filter((tag) => !removeTags.has(tag)),
      ...addTags.filter((tag) => !removeTags.has(tag)),
    ])].slice(0, 20);
    updatedCount += 1;
    return stampRecord({ ...note, tags, ...(category ? { category } : {}) }, { deviceId });
  });
  await writeNotes(next);
  broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });
  return { notes: next, updatedCount };
}

async function batchDeleteNotes(ids) {
  const requested = requestedNoteIds(ids);
  const notes = await readNotes();
  const deletedNotes = notes.filter((note) => requested.has(note.id));
  if (deletedNotes.length !== requested.size) throw new Error(`有 ${requested.size - deletedNotes.length} 条笔记不存在，未执行批量删除`);
  const next = notes.filter((note) => !requested.has(note.id));
  await recordNoteTombstones(deletedNotes);
  if (path.resolve(dataDirectory) !== path.resolve(legacyDataDirectory) && existsSync(legacyNotesFilePath)) {
    const legacyNotes = await readNotesFile(legacyNotesFilePath);
    await writeLegacyNotes(legacyNotes.filter((note) => !requested.has(note.id)));
  }
  await writeNotes(next);
  await Promise.allSettled(deletedNotes.map((note) => rm(path.join(mediaDirectory, note.id), { recursive: true, force: true })));
  broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });
  return { notes: next, deletedCount: deletedNotes.length, deletedIds: deletedNotes.map((note) => note.id) };
}

function queueMutation(callback) {
  const result = mutationQueue.then(callback);
  mutationQueue = result.catch(() => undefined);
  return result;
}

function queueNoteImport(body) {
  // 页面解析、媒体下载和 OCR 都在写队列外运行；只有最终重读、合并和原子写回
  // 进入 mutationQueue，避免一个大视频导入阻塞编辑、删除与其它轻量操作。
  return prepareNoteImport(body)
    .then(({ note, aiSettings }) => queueMutation(() => commitNoteImport(note, aiSettings)));
}

async function mapConcurrent(values, concurrency, callback) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await callback(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function commitBatchNoteImport(preparedResults) {
  let notes = await readNotes();
  const { deviceId } = await getSyncState();
  const results = [];
  for (const prepared of preparedResults) {
    if (!prepared.ok) {
      results.push(prepared);
      continue;
    }
    const merged = mergeImportedNote(notes, prepared.note);
    await clearNoteTombstone(prepared.note.id);
    const noteIndex = merged.notes.findIndex((entry) => entry.id === prepared.note.id);
    if (!merged.created && noteIndex >= 0) {
      merged.notes[noteIndex] = stampRecord(merged.notes[noteIndex], { deviceId });
    }
    notes = merged.notes;
    const mergedNote = notes[noteIndex] || prepared.note;
    results.push({ ok: true, id: mergedNote.id, title: mergedNote.title, created: merged.created });
    if (prepared.aiSettings.autoPipeline !== false) {
      const autoKinds = computePendingAiKinds(mergedNote, prepared.aiSettings);
      if (autoKinds.length > 0) enqueuePipeline(mergedNote.id, autoKinds, { delayMs: AUTO_PIPELINE_DELAY_MS });
    }
  }
  await writeNotes(notes);
  broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });
  return {
    notes,
    results,
    succeeded: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    created: results.filter((result) => result.ok && result.created).length,
    updated: results.filter((result) => result.ok && !result.created).length,
    lastImportedAt: getLastImportedAt(notes),
  };
}

function queueBatchNoteImport(body = {}) {
  const rawItems = Array.isArray(body.items)
    ? body.items
    : Array.isArray(body.inputs)
      ? body.inputs.map((input) => ({ input }))
      : [];
  const rawInputs = rawItems
    .map((item) => typeof item === 'string' ? { input: item } : item)
    .filter((item) => item && typeof item === 'object');
  if (rawInputs.length === 0) throw new Error('请至少提供一条待导入笔记');
  const preflight = Array.isArray(body.inputs)
    ? prepareBatchImportInputs(rawInputs.map((item) => item.input))
    : { items: rawInputs.map((item, originalIndex) => ({ input: item.input, originalIndex })), duplicates: [], totalRequested: rawInputs.length };
  const items = preflight.items.map(({ input, originalIndex }) => ({ ...rawInputs[originalIndex], ...(typeof input === 'string' ? { input } : {}), originalIndex }));

  return mapConcurrent(items, 3, async (item, index) => {
    try {
      return { ok: true, ...await prepareNoteImport(item), index: item.originalIndex ?? index, input: typeof item.input === 'string' ? item.input.slice(0, 500) : '' };
    } catch (error) {
      return {
        ok: false,
        index: item.originalIndex ?? index,
        input: typeof item.input === 'string' ? item.input.slice(0, 500) : '',
        error: error instanceof Error ? error.message : '导入失败',
      };
    }
  }).then((prepared) => queueMutation(() => commitBatchNoteImport(prepared)))
    .then((result) => ({
      ...result,
      results: [
        ...result.results,
        ...preflight.duplicates.map((duplicate) => ({ ok: false, skipped: true, ...duplicate, error: duplicate.reason })),
      ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)),
      skipped: preflight.duplicates.length,
      totalRequested: preflight.totalRequested,
    }));
}

function queueNoteDelete(noteId) {
  return queueMutation(() => deleteNote(noteId));
}

/** 根据 AI 设置构造视频转写选项（本地 / 在线大模型增强）。
 *  defer=true 时（素材收录场景）：增强转写不立即执行，标记「待转写」交给后台流水线。 */
function buildTranscriptOptions(aiSettings, { defer = false } = {}) {
  const enhanceTranscript = isTranscriptEnhanceConfigured(aiSettings);
  const options = {
    mediaDirectory,
    publicBaseUrl,
    skipTranscript: aiSettings.autoTranscript === false && !enhanceTranscript,
    enhanceTranscript,
  };
  if (enhanceTranscript) {
    if (defer) {
      options.deferTranscript = true;
    } else {
      options.transcribeAudio = (audioPath) => transcribeWithAi(aiSettings, audioPath);
    }
  }
  return options;
}

async function reanalyzeNoteVideo(noteId) {
  // P1#1 修复：AI 转写可能耗时 5-15 分钟，必须在 mutationQueue 外执行，避免阻塞全部写操作。
  // 只有最后的「重读→合并→写回」才入队。
  const notes = await readNotes();
  const noteIndex = notes.findIndex((note) => note.id === noteId);
  if (noteIndex < 0) return null;

  const aiSettings = await loadAiSettings(dataDirectory);
  // 重活：下载视频 + AI 转写（可能数分钟），在队列外执行
  const updatedNote = await reanalyzeStoredNoteVideo(notes[noteIndex], buildTranscriptOptions(aiSettings));

  // 轻活：串行化写回，避免与其它编辑产生 lost update
  return queueMutation(async () => {
    const latestNotes = await readNotes();
    const latestIdx = latestNotes.findIndex((note) => note.id === noteId);
    if (latestIdx < 0) return null;
    // 只合并转写相关字段，不覆盖用户在转写期间的编辑
    const patch = {};
    for (const field of ['videoUrl', 'videoDuration', 'transcriptText', 'transcriptSegments', 'transcriptEngine', 'videoStatus', 'videoError']) {
      if (updatedNote[field] !== undefined) patch[field] = updatedNote[field];
    }
    const merged = { ...latestNotes[latestIdx], ...patch };
    delete merged.transcriptSkipped;
    delete merged.transcriptStatus;
    const updatedNotes = [...latestNotes];
    updatedNotes[latestIdx] = merged;
    await writeNotes(updatedNotes);
    broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });
    return {
      notes: updatedNotes,
      note: merged,
      lastImportedAt: getLastImportedAt(updatedNotes),
    };
  });
}

function queueVideoReanalysis(noteId) {
  return reanalyzeNoteVideo(noteId);
}

// ===== 后台 AI 流水线：素材收录后 5 秒自动执行「转写 → 摘要 → 知识拓展」，并支持手动全局补跑 =====
const AUTO_PIPELINE_DELAY_MS = 5000;
const PIPELINE_KINDS = ['transcript', 'summary', 'expansion'];

const pipeline = {
  running: false,
  queue: [],          // 待处理项：{ noteId, kinds }
  doneCount: 0,
  totalCount: 0,
  currentNoteId: null,
  currentKind: null,
  errors: [],
  lastRunErrors: [],  // 上一轮补跑结束时的错误（供前端在按钮恢复后展示「上次有 N 条失败」）
};

// 延迟入队的 setTimeout 句柄，便于清理/避免泄漏（B14）
const pendingPipelineTimers = new Set();

function getPipelineStatus() {
  return {
    running: pipeline.running,
    status: pipeline.running ? 'running' : 'idle',
    queued: pipeline.queue.length,
    doneCount: pipeline.doneCount,
    totalCount: pipeline.totalCount,
    currentNoteId: pipeline.currentNoteId,
    currentKind: pipeline.currentKind,
    errors: pipeline.errors.slice(-20),
    lastRunErrors: pipeline.lastRunErrors.slice(-20),
  };
}

function broadcastPipelineProgress() {
  broadcastUpdate({ type: 'pipeline-progress', timestamp: new Date().toISOString(), ...getPipelineStatus() });
}

/** 执行单条笔记的某一类 AI 任务，写回 notes.json 并返回 { ok } 或 { error }。 */
async function runPipelineStep(noteId, kind) {
  let notes;
  let aiSettings;
  try {
    notes = await readNotes();
    aiSettings = await loadAiSettings(dataDirectory);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const idx = notes.findIndex((note) => note.id === noteId);
  if (idx < 0) return { error: '笔记不存在' };
  const note = notes[idx];
  try {
    // 只计算「新字段」，写回时合并到最新笔记上，绝不展开整份旧快照（B3 修复）
    let patch = {};
    const fieldsToDelete = [];
    if (kind === 'transcript') {
      const updated = await reanalyzeStoredNoteVideo(note, buildTranscriptOptions(aiSettings));
      for (const field of ['videoUrl', 'videoDuration', 'transcriptText', 'transcriptSegments', 'transcriptEngine', 'videoStatus', 'videoError']) {
        if (updated[field] !== undefined) patch[field] = updated[field];
      }
      fieldsToDelete.push('transcriptSkipped', 'transcriptStatus');
    } else if (kind === 'summary') {
      if (isAiConfigured(aiSettings)) {
        patch = { aiSummary: await summarizeWithAi(aiSettings, note), aiSummaryEngine: 'ai' };
      } else {
        patch = { aiSummary: summarizeNote(note), aiSummaryEngine: 'local' };
      }
    } else if (kind === 'expansion') {
      if (!isAiConfigured(aiSettings)) return { error: 'AI 未配置，无法生成知识拓展' };
      patch = { aiExpansion: await expandWithAi(aiSettings, note) };
    } else {
      return { error: `未知任务类型：${kind}` };
    }

    // 走 mutationQueue 串行化「重读→合并→写回」，避免与其它编辑产生 lost update（B3/B4 修复）
    await queueMutation(async () => {
      const latestNotes = await readNotes();
      const latestIdx = latestNotes.findIndex((item) => item.id === noteId);
      if (latestIdx >= 0) {
        const merged = { ...latestNotes[latestIdx], ...patch };
        for (const field of fieldsToDelete) delete merged[field];
        latestNotes[latestIdx] = merged;
        await writeNotes(latestNotes);
        broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });
      }
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 视频笔记尚无文稿：把「需要先转写」透传给调用方，而不是退化成浅拓展。
    return { error: message, needsTranscript: error instanceof VideoNeedsTranscriptError };
  }
}

async function processPipelineItem(item) {
  for (const kind of item.kinds) {
    pipeline.currentKind = kind;
    const result = await runPipelineStep(item.noteId, kind);
    if (result?.error) {
      pipeline.errors.push({ noteId: item.noteId, kind, error: result.error });
      if (pipeline.errors.length > 100) pipeline.errors.shift();
    }
    pipeline.doneCount += 1;
    broadcastPipelineProgress();
    // 转写成功后补排 summary/expansion：视频笔记的摘要/拓展依赖文稿，
    // 文稿就绪前 computePendingAiKinds 不会把它们标为待处理（见 ai-service.mjs）。
    if (kind === 'transcript' && !result?.error) {
      await enqueueFollowUpAiKinds(item.noteId);
    }
  }
}

/** 转写完成后，重新评估该笔记并补排摘要/知识拓展（走同一串行队列）。 */
async function enqueueFollowUpAiKinds(noteId) {
  try {
    const aiSettings = await loadAiSettings(dataDirectory);
    const notes = await readNotes();
    const note = notes.find((entry) => entry.id === noteId);
    if (!note) return;
    const followUp = computePendingAiKinds(note, aiSettings).filter((kind) => kind === 'summary' || kind === 'expansion');
    if (followUp.length > 0) enqueuePipeline(noteId, followUp);
  } catch (error) {
    console.error('[kanbox] 补排后续 AI 任务失败:', error?.message || error);
  }
}

async function drainPipelineQueue() {
  if (pipeline.running) return;
  pipeline.running = true;
  broadcastPipelineProgress();
  try {
    while (pipeline.queue.length > 0) {
      const item = pipeline.queue.shift();
      pipeline.currentNoteId = item.noteId;
      await processPipelineItem(item);
      pipeline.currentNoteId = null;
      pipeline.currentKind = null;
    }
  } catch (error) {
    // 单条失败由 processPipelineItem 内部捕获，这里兜住队列级异常，避免 unhandled rejection 崩溃（B6 修复）
    console.error('[kanbox] 后台流水线异常:', error?.message || error);
  } finally {
    pipeline.lastRunErrors = pipeline.errors.length > 0 ? [...pipeline.errors] : [];
    pipeline.running = false;
    pipeline.currentNoteId = null;
    pipeline.currentKind = null;
    pipeline.doneCount = 0;
    pipeline.totalCount = 0;
    pipeline.errors = [];
    broadcastPipelineProgress();
  }
}

/** 把一条笔记的 AI 任务加入流水线队列（串行执行）。delayMs>0 时延迟入队。 */
function enqueuePipeline(noteId, kinds, { delayMs = 0 } = {}) {
  if (!Array.isArray(kinds) || kinds.length === 0) return;
  const enqueue = () => {
    const existing = pipeline.queue.find((item) => item.noteId === noteId);
    if (existing) {
      // 同一条笔记已排队时合并 kinds，而不是直接丢弃（B13 修复）
      const before = existing.kinds.length;
      existing.kinds = [...new Set([...existing.kinds, ...kinds])];
      pipeline.totalCount += existing.kinds.length - before;
      broadcastPipelineProgress();
      return;
    }
    pipeline.queue.push({ noteId, kinds: [...new Set(kinds)] });
    pipeline.totalCount += kinds.length;
    broadcastPipelineProgress();
    void drainPipelineQueue().catch((error) => console.error('[kanbox] 流水线 drain 失败:', error?.message || error));
  };
  if (delayMs > 0) {
    const timer = setTimeout(() => {
      pendingPipelineTimers.delete(timer);
      enqueue();
    }, delayMs);
    pendingPipelineTimers.add(timer);
  } else {
    enqueue();
  }
}

/** 扫描全部笔记，找出待处理项，加入流水线队列。返回本次排队的项。 */
async function enqueuePendingNotes(kinds) {
  const aiSettings = await loadAiSettings(dataDirectory);
  const notes = await readNotes();
  const queued = [];
  for (const note of notes) {
    const pending = computePendingAiKinds(note, aiSettings).filter((kind) => kinds.includes(kind));
    if (pending.length > 0) {
      queued.push({ noteId: note.id, kinds: pending });
      enqueuePipeline(note.id, pending);
    }
  }
  return queued;
}

async function sendMediaFile(request, response, pathname) {
  const match = pathname.match(/^\/media\/([0-9a-f]{24})\/(\d{2}\.(?:avif|gif|heic|heif|jpg|png|webp))$/i);
  if (!match) return false;

  const filePath = path.join(mediaDirectory, match[1].toLowerCase(), match[2].toLowerCase());
  try {
    const fileStats = await stat(filePath);
    applyCorsHeaders(request, response);
    response.writeHead(200, {
      'Content-Type': mediaContentTypes.get(path.extname(filePath)) || 'application/octet-stream',
      'Content-Length': fileStats.size,
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    // 流式返回图片，避免把大图整体读入内存（B11 修复）
    const stream = createReadStream(filePath);
    stream.on('error', () => response.destroy());
    request.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch {
    sendJson(request, response, 404, { ok: false, error: 'Image not found' });
  }
  return true;
}

async function sendVideoFile(request, response, pathname) {
  const match = pathname.match(/^\/media\/([0-9a-f]{24})\/video\.mp4$/i);
  if (!match) return false;
  const filePath = path.join(mediaDirectory, match[1].toLowerCase(), 'video.mp4');
  try {
    const fileStats = await stat(filePath);
    const range = request.headers.range;
    applyCorsHeaders(request, response);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    response.setHeader('Content-Type', 'video/mp4');

    if (range) {
      const rangeMatch = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!rangeMatch) {
        response.writeHead(416, { 'Content-Range': `bytes */${fileStats.size}` });
        response.end();
        return true;
      }
      let start;
      let requestedEnd;
      if (!rangeMatch[1] && rangeMatch[2]) {
        // bytes=-N: last N bytes
        requestedEnd = fileStats.size - 1;
        start = Math.max(0, fileStats.size - Number.parseInt(rangeMatch[2], 10));
      } else {
        start = rangeMatch[1] ? Number.parseInt(rangeMatch[1], 10) : 0;
        requestedEnd = rangeMatch[2] ? Number.parseInt(rangeMatch[2], 10) : fileStats.size - 1;
      }
      const end = Math.min(requestedEnd, fileStats.size - 1);
      if (start < 0 || start > end || start >= fileStats.size) {
        response.writeHead(416, { 'Content-Range': `bytes */${fileStats.size}` });
        response.end();
        return true;
      }
      response.writeHead(206, {
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${fileStats.size}`,
      });
      const stream = createReadStream(filePath, { start, end });
      stream.on('error', () => response.destroy());
      request.on('close', () => stream.destroy());
      stream.pipe(response);
      return true;
    }

    response.writeHead(200, { 'Content-Length': fileStats.size });
    const stream = createReadStream(filePath);
    stream.on('error', () => response.destroy());
    request.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch {
    sendJson(request, response, 404, { ok: false, error: 'Video not found' });
  }
  return true;
}

const server = createServer(async (request, response) => {
  if (!request.url || !request.method) {
    sendJson(request, response, 400, { ok: false, error: 'Invalid request' });
    return;
  }

  if (!isAllowedOrigin(request.headers.origin)) {
    sendJson(request, response, 403, { ok: false, error: 'Origin not allowed' });
    return;
  }

  // DNS rebinding 防御：只接受 loopback 主机的 Host 头（B19 修复）
  const hostHeader = request.headers.host || '';
  const hostname = hostHeader.split(':')[0].toLowerCase();
  if (hostname && hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
    sendJson(request, response, 403, { ok: false, error: 'Host not allowed' });
    return;
  }

  if (request.method === 'OPTIONS') {
    applyCorsHeaders(request, response);
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);

  try {
    if (request.method === 'GET' && url.pathname === '/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': request.headers.origin || 'http://127.0.0.1',
      });
      response.write('data: {"type":"connected"}\n\n');
      sseClients.add(response);
      // 定期心跳，防止空闲连接被代理/网关掐断（B15 修复）
      const heartbeat = setInterval(() => {
        try {
          response.write(': ping\n\n');
        } catch {
          // 客户端已断开，close 事件会清理
        }
      }, 30000);
      request.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(response);
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(request, response, 200, {
        ok: true,
        port: PORT,
        dataDirectory,
        localOcr: process.platform === 'darwin',
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/setup') {
      sendJson(request, response, 200, await buildSetupResponse());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/setup/browser-extension/open') {
      const extensionDirectory = resolveExtensionDirectory();
      if (!extensionDirectory) throw new Error('浏览器插件文件不存在');
      if (process.platform !== 'darwin') throw new Error('当前仅支持在 macOS 上自动打开插件配置');
      launchDetached('open', [extensionDirectory]);
      launchDetached('open', ['-a', 'Google Chrome', 'chrome://extensions/']);
      sendJson(request, response, 200, {
        ok: true,
        path: extensionDirectory,
        message: '已打开 Chrome 扩展页和插件文件夹',
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/setup/open-external') {
      const body = await readRequestBody(request);
      const target = body && typeof body.url === 'string' ? body.url.trim() : '';
      // Only http(s) URLs are allowed (blocks javascript:/file:/data: etc. from the
      // webview). Domains are intentionally open: sourceUrl is data the user already
      // imported into their own notes.json, and opening happens in the system browser
      // via `open`, not inside the webview.
      if (!/^https?:\/\/[^\s]+$/i.test(target)) {
        throw new Error('仅支持打开 http(s) 链接');
      }
      if (process.platform !== 'darwin') throw new Error('当前仅支持在 macOS 上打开外部链接');
      launchDetached('open', [target]);
      sendJson(request, response, 200, { ok: true, url: target });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/setup/open-app') {
      if (process.platform !== 'darwin') throw new Error('当前仅支持在 macOS 上打开 Kanbox');
      // 打开（或聚焦）桌面 App。`open -a` 会按 bundle id 查找，比硬编码 /Applications 路径更稳。
      launchDetached('open', ['-a', 'Kanbox']);
      sendJson(request, response, 200, { ok: true, message: '正在打开 Kanbox…' });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/setup/agent/connect') {
      const body = await readRequestBody(request);
      sendJson(request, response, 200, await connectAgentClient(body.client));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/setup/restart') {
      if (process.platform !== 'darwin') throw new Error('当前仅支持在 macOS 上自动重启');
      // 退出并重启 App（osascript 独立于 sidecar，sidecar 被杀不会中断它）。
      launchDetached('/usr/bin/osascript', [
        '-e', 'tell application "Kanbox" to quit',
        '-e', 'delay 1',
        '-e', 'do shell script "open -a Kanbox"',
      ]);
      sendJson(request, response, 200, { ok: true, message: '正在重启 Kanbox…' });
      return;
    }

    if (request.method === 'GET' && await sendMediaFile(request, response, url.pathname)) {
      return;
    }

    if (request.method === 'GET' && await sendVideoFile(request, response, url.pathname)) {
      return;
    }

    if (request.method === 'GET' && url.pathname === '/notes') {
      sendJson(request, response, 200, await buildNotesResponse());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/workspace') {
      sendJson(request, response, 200, { ok: true, workspace: await readWorkspace() });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/workspace') {
      const body = await readRequestBody(request);
      const workspace = await queueMutation(() => writeWorkspace(body.workspace));
      sendJson(request, response, 200, { ok: true, workspace });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/daily-review') {
      sendJson(request, response, 200, { ok: true, review: await getDailyReview() });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/daily-review/settings') {
      const body = await readRequestBody(request);
      const review = await queueMutation(() => updateDailyReviewSettings(body?.count));
      sendJson(request, response, 200, { ok: true, review });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/daily-review/action') {
      const body = await readRequestBody(request);
      const review = await queueMutation(() => updateDailyReviewAction(body));
      sendJson(request, response, 200, { ok: true, review });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/notes/import') {
      sendJson(request, response, 200, await queueNoteImport(await readRequestBody(request)));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/notes/import/batch') {
      sendJson(request, response, 200, await queueBatchNoteImport(await readRequestBody(request, 5 * 1024 * 1024)));
      return;
    }

    // 「重新归档」：对待整理（category 缺失/空/「待分类」）的笔记重新跑分类推断，
    // 把能确定分类的笔记写回 category，让前端 desk-workspace 自动归位到对应分类组。
    if (request.method === 'POST' && url.pathname === '/notes/re-categorize') {
      sendJson(request, response, 200, await queueMutation(async () => {
        const notes = await readNotes();
        const { notes: updated, reclassified, remaining, reclassifiedIds, changed } = reCategorizeNotes(notes);
        if (changed) {
          await writeNotes(updated);
        }
        broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });
        return {
          notes: updated,
          reclassified,
          remaining,
          reclassifiedIds,
          lastImportedAt: getLastImportedAt(updated),
        };
      }));
      return;
    }

    const transcribeNoteMatch = url.pathname.match(/^\/notes\/([0-9a-f]{24})\/transcribe$/i);
    if (request.method === 'POST' && transcribeNoteMatch) {
      const result = await queueVideoReanalysis(transcribeNoteMatch[1].toLowerCase());
      if (!result) {
        sendJson(request, response, 404, { ok: false, error: '笔记不存在' });
        return;
      }
      sendJson(request, response, 200, result);
      return;
    }

    const summaryNoteMatch = url.pathname.match(/^\/notes\/([0-9a-f]{24})\/summary$/i);
    if ((request.method === 'GET' || request.method === 'POST') && summaryNoteMatch) {
      const noteId = summaryNoteMatch[1].toLowerCase();
      const notes = await readNotes();
      const noteIndex = notes.findIndex((n) => n.id === noteId);
      if (noteIndex < 0) {
        sendJson(request, response, 404, { ok: false, error: '笔记不存在' });
        return;
      }
      const note = notes[noteIndex];
      const aiSettings = await loadAiSettings(dataDirectory);
      let summary;
      let engine;
      if (isAiConfigured(aiSettings)) {
        summary = await summarizeWithAi(aiSettings, note);
        engine = 'ai';
      } else {
        summary = summarizeNote(note);
        engine = 'local';
      }
      // 走队列串行化「重读→合并→写回」，只写入新字段，避免覆盖 AI 生成期间用户的操作（B4 修复）
      const persisted = await queueMutation(async () => {
        const latestNotes = await readNotes();
        const latestIdx = latestNotes.findIndex((n) => n.id === noteId);
        if (latestIdx < 0) return null;
        const merged = { ...latestNotes[latestIdx], aiSummary: summary, aiSummaryEngine: engine };
        latestNotes[latestIdx] = merged;
        await writeNotes(latestNotes);
        broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });
        return merged;
      });
      const returned = persisted || { ...note, aiSummary: summary, aiSummaryEngine: engine };
      sendJson(request, response, 200, { ok: true, summary, engine, note: returned });
      return;
    }

    const expandNoteMatch = url.pathname.match(/^\/notes\/([0-9a-f]{24})\/expand$/i);
    if (request.method === 'POST' && expandNoteMatch) {
      const noteId = expandNoteMatch[1].toLowerCase();
      const notes = await readNotes();
      const noteIndex = notes.findIndex((n) => n.id === noteId);
      if (noteIndex < 0) {
        sendJson(request, response, 404, { ok: false, error: '笔记不存在' });
        return;
      }
      const note = notes[noteIndex];
      const aiSettings = await loadAiSettings(dataDirectory);
      let expansion;
      try {
        expansion = await expandWithAi(aiSettings, note);
      } catch (error) {
        // 视频笔记尚无文稿：不产出「仅标题」的浅拓展，自动补排转写并提示前端等待。
        if (error instanceof VideoNeedsTranscriptError) {
          enqueuePipeline(noteId, ['transcript']);
          sendJson(request, response, 200, { ok: false, needsTranscript: true, error: error.message });
          return;
        }
        throw error;
      }
      // 走队列串行化「重读→合并→写回」，只写入新字段，避免覆盖 AI 生成期间用户的操作（B4 修复）
      const persisted = await queueMutation(async () => {
        const latestNotes = await readNotes();
        const latestIdx = latestNotes.findIndex((n) => n.id === noteId);
        if (latestIdx < 0) return null;
        const merged = { ...latestNotes[latestIdx], aiExpansion: expansion };
        latestNotes[latestIdx] = merged;
        await writeNotes(latestNotes);
        broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });
        return merged;
      });
      const returned = persisted || { ...note, aiExpansion: expansion };
      sendJson(request, response, 200, { ok: true, expansion, note: returned });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/ai/settings') {
      const aiSettings = await loadAiSettings(dataDirectory);
      sendJson(request, response, 200, { ok: true, settings: publicAiSettings(aiSettings) });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/ai/presets') {
      sendJson(request, response, 200, { ok: true, presets: aiPresets(), valid: validateProviderPresets() });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/ai/settings') {
      const body = await readRequestBody(request);
      const aiSettings = await loadAiSettings(dataDirectory);
      // 前端提交时 apiKey/transcribeApiKey 为空字符串表示「保持原密钥不变」（脱敏显示）。
      const updates = { ...body };
      if (updates && typeof updates.apiKey === 'string' && updates.apiKey.trim() === '') {
        delete updates.apiKey;
      }
      if (updates && typeof updates.transcribeApiKey === 'string' && updates.transcribeApiKey.trim() === '') {
        delete updates.transcribeApiKey;
      }
      const saved = await saveAiSettings(dataDirectory, { ...aiSettings, ...updates });
      sendJson(request, response, 200, { ok: true, settings: publicAiSettings(saved) });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/ai/test') {
      const body = await readRequestBody(request);
      const aiSettings = await loadAiSettings(dataDirectory);
      const candidate = { ...aiSettings, ...body };
      if (typeof candidate.apiKey === 'string' && candidate.apiKey.trim() === '') {
        candidate.apiKey = aiSettings.apiKey;
      }
      const reply = await testAi(candidate);
      sendJson(request, response, 200, { ok: true, reply });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/ai/test-transcribe') {
      const body = await readRequestBody(request);
      const aiSettings = await loadAiSettings(dataDirectory);
      const candidate = { ...aiSettings, ...body };
      if (typeof candidate.transcribeApiKey === 'string' && candidate.transcribeApiKey.trim() === '') {
        candidate.transcribeApiKey = aiSettings.transcribeApiKey;
      }
      const reply = await testTranscription(candidate);
      sendJson(request, response, 200, { ok: true, reply });
      return;
    }

    // 手动全局补跑：把还没执行 / 遗漏未执行到位的转写·摘要·知识拓展加入后台流水线
    if (request.method === 'POST' && url.pathname === '/ai/batch-process') {
      const body = await readRequestBody(request);
      const requested = Array.isArray(body?.kinds) && body.kinds.length > 0
        ? body.kinds.filter((kind) => PIPELINE_KINDS.includes(kind))
        : PIPELINE_KINDS;
      const queued = await enqueuePendingNotes(requested);
      sendJson(request, response, 200, { ok: true, queued: queued.length, items: queued, status: getPipelineStatus() });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/ai/pipeline') {
      sendJson(request, response, 200, { ok: true, ...getPipelineStatus() });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/notes/batch-status') {
      const body = await readRequestBody(request, 5 * 1024 * 1024);
      const result = await queueMutation(() => batchUpdateNoteStatus(body?.ids, body?.updates));
      sendJson(request, response, 200, { ok: true, ...result });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/notes/batch-organize') {
      const body = await readRequestBody(request, 5 * 1024 * 1024);
      const result = await queueMutation(() => batchOrganizeNotes(body?.ids, body?.updates));
      sendJson(request, response, 200, { ok: true, ...result });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/notes/batch-delete') {
      const deleteOrigin = request.headers.origin;
      if (deleteOrigin && deleteOrigin.startsWith('chrome-extension://')) {
        sendJson(request, response, 403, { ok: false, error: '浏览器扩展不允许删除笔记' });
        return;
      }
      const body = await readRequestBody(request, 5 * 1024 * 1024);
      const result = await queueMutation(() => batchDeleteNotes(body?.ids));
      sendJson(request, response, 200, { ok: true, ...result });
      return;
    }

    const updateNoteMatch = url.pathname.match(/^\/notes\/([0-9a-f]{24})$/i);
    if (request.method === 'PATCH' && updateNoteMatch) {
      const result = await queueNoteUpdate(updateNoteMatch[1].toLowerCase(), await readRequestBody(request));
      if (!result) {
        sendJson(request, response, 404, { ok: false, error: '笔记不存在' });
        return;
      }
      sendJson(request, response, 200, result);
      return;
    }

    const deleteNoteMatch = url.pathname.match(/^\/notes\/([0-9a-f]{24})$/i);
    if (request.method === 'DELETE' && deleteNoteMatch) {
      // Block chrome-extension from deleting notes (security)
      const deleteOrigin = request.headers.origin;
      if (deleteOrigin && deleteOrigin.startsWith('chrome-extension://')) {
        sendJson(request, response, 403, { ok: false, error: '浏览器扩展不允许删除笔记' });
        return;
      }
      const result = await queueNoteDelete(deleteNoteMatch[1].toLowerCase());
      if (!result) {
        sendJson(request, response, 404, { ok: false, error: '笔记不存在或已被删除' });
        return;
      }
      sendJson(request, response, 200, result);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/notes/export') {
      const exportData = await buildNotesExport();
      const dateSlug = exportData.exportDate.slice(0, 10);
      const payload = JSON.stringify(exportData, null, 2);
      applyCorsHeaders(request, response);
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="kanbox-export-${dateSlug}.json"`,
        'Content-Length': Buffer.byteLength(payload),
      });
      response.end(payload);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/notes/export/markdown') {
      const md = await exportNotesMarkdown();
      applyCorsHeaders(request, response);
      response.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="kanbox-export-${new Date().toISOString().slice(0,10)}.md"`,
      });
      response.end(md);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/notes/export/html') {
      const html = await exportNotesHtml();
      applyCorsHeaders(request, response);
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="kanbox-export-${new Date().toISOString().slice(0,10)}.html"`,
      });
      response.end(html);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/data/info') {
      sendJson(request, response, 200, await getDataInfo());
      return;
    }

    const archiveDownloadMatch = url.pathname.match(/^\/data\/archive\/download\/([^/]+)$/);
    if (request.method === 'GET' && archiveDownloadMatch) {
      const sent = await sendArchiveDownload(request, response, decodeURIComponent(archiveDownloadMatch[1]));
      if (!sent) sendJson(request, response, 404, { ok: false, error: '完整归档不存在' });
      return;
    }

    // 存储位置（iCloud / 本机 / 自定义）读取与切换（v0.7.1）
    if (request.method === 'GET' && url.pathname === '/storage') {
      sendJson(request, response, 200, { ok: true, ...storageInfo(dataDirectory) });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/libraries/discover') {
      const candidates = await discoverLibraryCandidates();
      sendJson(request, response, 200, {
        ok: true,
        currentDirectory: dataDirectory,
        candidates,
        recoverableCount: candidates.filter((candidate) => !candidate.isCurrent && candidate.status !== 'damaged').length,
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/libraries/preview') {
      const body = await readRequestBody(request);
      sendJson(request, response, 200, { ok: true, preview: await previewLibraryRecovery(body?.candidateId) });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/libraries/restore') {
      const body = await readRequestBody(request);
      sendJson(request, response, 200, await queueMutation(() => restoreLibraryCandidate(body?.candidateId)));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/storage/location') {
      const body = await readRequestBody(request);
      const location = body && typeof body.location === 'string' ? body.location : '';
      let target;
      if (location === 'icloud') {
        if (!isIcloudAvailable()) throw new Error('未检测到 iCloud Drive，无法切换到 iCloud 存储');
        target = icloudKanboxPath();
      } else if (location === 'local') {
        target = localDefaultDataDirectory();
      } else if (location === 'custom') {
        const custom = body && typeof body.path === 'string' ? body.path.trim() : '';
        if (!custom) throw new Error('请提供自定义存储目录路径');
        target = path.resolve(custom);
      } else {
        throw new Error('不支持的存储位置类型');
      }
      // 始终从当前活动资料库迁移；目标已有资料时安全合并，源目录和旧目标快照均保留。
      const migration = await migrateDataDirectory(dataDirectory, target);
      if (location === 'custom') {
        writeStoragePointer('custom', target);
      } else {
        writeStoragePointer(location);
      }
      sendJson(request, response, 200, {
        ok: true,
        needsRestart: true,
        migrated: migration.migrated,
        migration,
        ...storageInfo(target),
        message: migration.migrated
          ? `已安全迁移 ${migration.noteCount} 条笔记和 ${migration.mediaFiles} 个媒体文件${migration.conflicts ? `，其中 ${migration.conflicts} 条存在同步冲突` : ''}${migration.backup ? `；旧目标快照：${migration.backup}` : ''}；重启 Kanbox 后生效`
          : '存储位置未发生变化',
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/data/integrity') {
      sendJson(request, response, 200, await checkDataIntegrity());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/data/integrity/repair') {
      const body = await readRequestBody(request);
      if (!body.noteId || typeof body.noteId !== 'string') {
        throw new Error('缺少 noteId 参数');
      }
      const result = await repairNoteIntegrity(body.noteId);
      if (!result) {
        sendJson(request, response, 404, { ok: false, error: '笔记不存在' });
        return;
      }
      sendJson(request, response, 200, result);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/data/integrity/repair-all') {
      sendJson(request, response, 200, await repairAllNoteIntegrity());
      return;
    }

    // Tags
    if (request.method === 'GET' && url.pathname === '/tags') {
      sendJson(request, response, 200, { tags: await getAllTags() });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/tags/rename') {
      const body = await readRequestBody(request);
      sendJson(request, response, 200, await queueMutation(() => renameTag(body.oldName, body.newName)));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/tags/delete') {
      const body = await readRequestBody(request);
      sendJson(request, response, 200, await queueMutation(() => deleteTag(body.name)));
      return;
    }

    // Backup
    if (request.method === 'POST' && url.pathname === '/data/backup') {
      sendJson(request, response, 200, await createBackup());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/data/backups') {
      sendJson(request, response, 200, { ok: true, backups: await listStoredMetadataBackups() });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/data/backups/preview') {
      const body = await readRequestBody(request);
      sendJson(request, response, 200, { ok: true, preview: await previewStoredMetadataBackup(body?.name) });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/data/backups/restore') {
      const body = await readRequestBody(request);
      const { payload } = await readStoredMetadataBackup(body?.name);
      sendJson(request, response, 200, await queueMutation(() => restoreFromBackup(payload)));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/data/archive') {
      sendJson(request, response, 200, await createArchiveBackup());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/data/archive/restore') {
      const result = await restoreArchiveUpload(request);
      broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });
      sendJson(request, response, 200, { ...result, notes: await readNotes() });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/data/restore') {
      const contentType = request.headers['content-type'] || '';
      let parsedBody;
      if (contentType.includes('multipart/form-data')) {
        const chunks = [];
        let totalBytes = 0;
        for await (const chunk of request) {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          totalBytes += buf.length;
          if (totalBytes > 10 * 1024 * 1024) throw new Error('备份文件过大');
          chunks.push(buf);
        }
        const bodyBuf = Buffer.concat(chunks);
        const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        if (!boundaryMatch) throw new Error('Missing multipart boundary');
        // 去掉可能带引号的 boundary（B7 修复）
        const boundary = (boundaryMatch[1] || boundaryMatch[2] || '').trim();
        if (!boundary) throw new Error('Missing multipart boundary');
        const bodyStr = bodyBuf.toString('utf8');
        const parts = bodyStr.split('--' + boundary);
        for (const part of parts) {
          // filename= 不区分大小写（B12 修复）
          if (/filename=/i.test(part)) {
            const jsonStart = part.indexOf('\r\n\r\n');
            if (jsonStart >= 0) {
              const jsonStr = part.slice(jsonStart + 4).replace(/\r\n--\s*$/, '').trim();
              parsedBody = JSON.parse(jsonStr);
            }
          }
        }
      } else {
        // JSON 恢复路径与 multipart 路径统一 10MB 上限，避免 >2MB 的全量备份被误判「过大」（P2#7）。
        parsedBody = await readRequestBody(request, 10 * 1024 * 1024);
      }
      const result = await queueMutation(() => restoreFromBackup(parsedBody));
      sendJson(request, response, 200, result);
      return;
    }

    sendJson(request, response, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    // 根据错误类型返回对应状态码，而非统一 400（B9 修复）：支持 error.statusCode
    const statusCode = error && Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
      ? error.statusCode
      : 400;
    sendJson(request, response, statusCode, {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * 查找占用本端口的残留 kanbox sidecar 进程（异常退出后未回收的旧 local-api）。
 * 返回 PID，找不到返回 null。只针对 kanbox-node + local-api.mjs 组合，避免误杀其它进程。
 */
async function findStaleSidecarPid() {
  try {
    const { stdout } = await execFileAsync('lsof', ['-iTCP:' + PORT, '-sTCP:LISTEN', '-t'], { timeout: 3000 });
    const pids = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    for (const pid of pids) {
      if (String(pid) === String(process.pid)) continue;
      const { stdout: cmd } = await execFileAsync('ps', ['-p', pid, '-o', 'command='], { timeout: 3000 });
      if (cmd.includes('kanbox-node') && cmd.includes('local-api.mjs')) {
        return Number(pid);
      }
    }
  } catch {
    // lsof/ps 不可用则放弃自愈
  }
  return null;
}

async function startServer() {
  await ensureDataDirectory();
  // 首次切到 iCloud / 自定义目录时，把本机数据复制过去（保留本机兜底），实现无缝切换与跨电脑复原。
  const migration = process.env.KANBOX_DATA_DIRECTORY
    ? { migrated: false }
    : await migrateDataIfNeeded(dataDirectory);
  if (migration.migrated) {
    console.log(`[kanbox] 已把本机数据迁移到 ${migration.to}`);
  }
  const existingNotes = await readNotes();
  const recovered = await recoverCachedNoteCovers(existingNotes, {
    cacheDirectories: coverCacheDirectories,
    mediaDirectory,
    publicBaseUrl,
  });
  if (recovered.recoveredCount > 0) await writeNotes(recovered.notes);

  const onListening = () => {
    console.log(`local-api listening on http://127.0.0.1:${PORT}`);
    console.log(`local data directory: ${dataDirectory}`);
    if (recovered.recoveredCount > 0) {
      console.log(`recovered ${recovered.recoveredCount} cached note covers`);
    }
    runAutoBackup();
    // 每六小时形成一个稳定槽位的快照；同一槽位重复启动不会覆盖首次快照。
    setInterval(runAutoBackup, 6 * 60 * 60 * 1000);
  };

  let retried = false;
  server.on('error', async (error) => {
    if (error.code === 'EADDRINUSE' && !retried) {
      const stalePid = await findStaleSidecarPid();
      if (stalePid) {
        retried = true;
        console.error(`[kanbox] 检测到残留 local-api 进程（PID ${stalePid}），结束并重试绑定…`);
        try {
          process.kill(stalePid, 'SIGTERM');
        } catch {
          // 已退出则忽略
        }
        setTimeout(() => server.listen(PORT, '127.0.0.1', onListening), 900);
        return;
      }
    }
    if (error.code === 'EADDRINUSE') {
      console.error(`[kanbox] 端口 ${PORT} 已被占用：可能是上一次 Kanbox 异常退出后残留的 local-api 进程仍在运行。`);
      console.error('[kanbox] 若该进程不健康，请手动结束占用端口的进程（lsof -iTCP:' + PORT + ' -sTCP:LISTEN）后重启 Kanbox。');
    } else {
      console.error('[kanbox] local-api 启动失败:', error.message);
    }
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', onListening);
}

startServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
