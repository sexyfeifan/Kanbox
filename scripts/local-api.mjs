import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { inferCategoryFromNote } from './lib/category-inference.mjs';
import { recoverCachedNoteCovers } from './lib/cache-cover-recovery.mjs';
import { summarizeNote } from './lib/text-summary.mjs';
import { localizeNoteMedia } from './lib/media-import.mjs';
import { localizeNoteVideo, reanalyzeStoredNoteVideo } from './lib/video-import.mjs';
import { resolveAnonymousNote } from './lib/anonymous-note-resolver.mjs';
import {
  extractNoteIdFromUrl,
  extractSharedNoteUrl,
  mergeImportedNote,
  normalizeImportedNote,
  noteFromSharedText,
  parseDraggedCardInput,
  parseDraggedNoteInput,
  removeStoredNote,
} from './lib/note-import.mjs';

const DEFAULT_PORT = 4318;
const MCP_SERVER_NAME = 'kanbox-notes';
const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.LOCAL_API_PORT || `${DEFAULT_PORT}`, 10);
const defaultDataDirectory = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'com.kanbox.app')
  : path.join(os.homedir(), '.kanbox');
const dataDirectory = process.env.LOCAL_APP_DATA_DIR || defaultDataDirectory;
const legacyDataDirectory = path.join(os.homedir(), '.kanbox');
const notesFilePath = path.join(dataDirectory, 'notes.json');
const legacyNotesFilePath = path.join(legacyDataDirectory, 'notes.json');
const notesTempFilePath = path.join(dataDirectory, 'notes.next.json');
const mediaDirectory = path.join(dataDirectory, 'media');
const publicBaseUrl = `http://127.0.0.1:${PORT}`;
const coverCacheDirectories = process.platform === 'darwin'
  ? [
      path.join(os.homedir(), 'Library', 'Caches', 'com.kanbox.app', 'WebKit', 'NetworkCache'),
      path.join(os.homedir(), 'Library', 'Caches', 'kanbox', 'WebKit', 'NetworkCache'),
    ]
  : [];
let mutationQueue = Promise.resolve();
const sseClients = new Set();

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
  child.unref();
}

async function resolveAgentExecutable(client) {
  const executableName = client === 'codex' ? 'codex' : 'claude';
  const candidates = client === 'codex'
    ? [
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        path.join(os.homedir(), '.local', 'bin', 'codex'),
        path.join(os.homedir(), '.npm-global', 'bin', 'codex'),
      ]
    : [
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        path.join(os.homedir(), '.local', 'bin', 'claude'),
        path.join(os.homedir(), '.claude', 'local', 'claude'),
      ];
  const knownPath = firstExistingPath(candidates);
  if (knownPath) return knownPath;

  try {
    const { stdout } = await execFileAsync('/bin/zsh', ['-lc', `command -v ${executableName}`], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    const resolved = stdout.trim();
    return resolved && existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

async function buildSetupResponse() {
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

  return {
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

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin.startsWith('chrome-extension://')) return true;

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

async function readNotesFile(filePath) {
  if (!existsSync(filePath)) return [];
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    return Array.isArray(raw) ? raw.filter(isUsableStoredNote) : [];
  } catch {
    return [];
  }
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
  return Array.from(merged.values());
}

async function writeNotes(notes) {
  await ensureDataDirectory();
  await writeFile(notesTempFilePath, `${JSON.stringify(notes, null, 2)}\n`, 'utf8');
  await rename(notesTempFilePath, notesFilePath);
}

async function writeLegacyNotes(notes) {
  const legacyTempFilePath = path.join(legacyDataDirectory, 'notes.next.json');
  await mkdir(legacyDataDirectory, { recursive: true });
  await writeFile(legacyTempFilePath, `${JSON.stringify(notes, null, 2)}\n`, 'utf8');
  await rename(legacyTempFilePath, legacyNotesFilePath);
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
  const notes = await readNotes();
  let renamedCount = 0;
  const updated = notes.map(note => {
    if (!Array.isArray(note.tags) || !note.tags.includes(oldName)) return note;
    renamedCount++;
    return {
      ...note,
      tags: note.tags.map(t => t === oldName ? newName : t),
    };
  });
  await writeNotes(updated);
  return { notes: updated, renamedCount };
}

async function deleteTag(tagName) {
  const notes = await readNotes();
  let deletedCount = 0;
  const updated = notes.map(note => {
    if (!Array.isArray(note.tags) || !note.tags.includes(tagName)) return note;
    deletedCount++;
    return {
      ...note,
      tags: note.tags.filter(t => t !== tagName),
    };
  });
  await writeNotes(updated);
  return { notes: updated, deletedCount };
}

async function readRequestBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    totalBytes += buffer.length;
    if (totalBytes > 2 * 1024 * 1024) {
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
  return new Date(Math.max(...timestamps)).toISOString();
}

async function getDirectorySize(dirPath) {
  if (!existsSync(dirPath)) return 0;
  let totalSize = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += await getDirectorySize(entryPath);
      } else if (entry.isFile()) {
        try {
          const fileStat = await stat(entryPath);
          totalSize += fileStat.size;
        } catch {
          // Skip files that can't be stat'd
        }
      }
    }
  } catch {
    // Return 0 if directory can't be read
  }
  return totalSize;
}

async function checkDataIntegrity() {
  const notes = await readNotes();
  const brokenNotes = [];

  for (const note of notes) {
    const missingFiles = [];
    const noteMediaDir = path.join(mediaDirectory, note.id);

    if (Array.isArray(note.imageUrls)) {
      for (const imageUrl of note.imageUrls) {
        const match = imageUrl.match(/\/media\/[0-9a-f]{24}\/(.+)$/i);
        if (match) {
          const filePath = path.join(noteMediaDir, match[1]);
          if (!existsSync(filePath)) missingFiles.push(match[1]);
        }
      }
    }

    if (note.type === 'video') {
      const videoPath = path.join(noteMediaDir, 'video.mp4');
      if (!existsSync(videoPath)) missingFiles.push('video.mp4');
    }

    if (missingFiles.length > 0) {
      brokenNotes.push({ id: note.id, title: note.title || '未命名笔记', missingFiles });
    }
  }

  return {
    totalNotes: notes.length,
    healthyNotes: notes.length - brokenNotes.length,
    brokenNotes,
  };
}

async function repairNoteIntegrity(noteId) {
  const notes = await readNotes();
  const noteIndex = notes.findIndex((note) => note.id === noteId);
  if (noteIndex < 0) return null;

  const note = notes[noteIndex];
  const repaired = await localizeNoteMedia(note, {
    mediaDirectory,
    publicBaseUrl,
  });

  const updatedNotes = [...notes];
  updatedNotes[noteIndex] = repaired;
  await writeNotes(updatedNotes);

  return {
    notes: updatedNotes,
    note: repaired,
  };
}

async function buildNotesExport() {
  const notes = await readNotes();
  const exportDate = new Date().toISOString();
  return {
    exportDate,
    version: '1.0',
    noteCount: notes.length,
    notes,
  };
}

async function buildDataInfo() {
  const notes = await readNotes();
  const mediaSize = await getDirectorySize(mediaDirectory);
  return {
    dataDirectory,
    notesCount: notes.length,
    mediaSize,
  };
}

async function createBackup() {
  const notes = await readNotes();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = path.join(dataDirectory, 'backups');
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `backup-${timestamp}.json`);
  await writeFile(backupPath, JSON.stringify({
    version: '0.0.3',
    exportedAt: new Date().toISOString(),
    notes
  }, null, 2), 'utf8');
  const stats = await stat(backupPath);
  return { ok: true, path: backupPath, size: stats.size };
}

let autoBackupTimer = null;

async function runAutoBackup() {
  try {
    const notes = await readNotes();
    if (notes.length === 0) return;

    const backupDir = path.join(dataDirectory, 'backups');
    await mkdir(backupDir, { recursive: true });

    // Create backup with date in filename
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const backupPath = path.join(backupDir, `auto-backup-${dateStr}.json`);

    // Don't overwrite if already exists today
    if (existsSync(backupPath)) return;

    await writeFile(backupPath, JSON.stringify({
      version: '0.2.0',
      type: 'auto',
      exportedAt: now.toISOString(),
      notes,
    }, null, 2), 'utf8');

    console.log(`Auto-backup created: ${backupPath}`);

    // Clean up old auto-backups (keep last 7)
    const files = (await readdir(backupDir))
      .filter(f => f.startsWith('auto-backup-') && f.endsWith('.json'))
      .sort()
      .reverse();
    for (const old of files.slice(7)) {
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
    backupCount = backups.filter(f => f.endsWith('.json')).length;
  } catch {}

  return {
    dataDirectory,
    notesCount: notes.length,
    mediaSize,
    backupCount,
  };
}

async function buildNotesResponse() {
  const notes = await readNotes();
  return {
    notes,
    lastImportedAt: getLastImportedAt(notes),
  };
}

async function importNote(body = {}) {
  const draggedPayload = body.note || parseDraggedNoteInput(body.input);
  const draggedCard = draggedPayload ? null : parseDraggedCardInput(body.input);
  let normalized;

  if (draggedPayload) {
    normalized = normalizeImportedNote(draggedPayload);
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
    } catch (error) {
      const sourceUrl = extractSharedNoteUrl(body.input);
      const noteId = extractNoteIdFromUrl(sourceUrl);
      if (!noteId) throw error;
      normalized = normalizeImportedNote(await resolveAnonymousNote(sourceUrl, {
        expectedNoteId: noteId,
      }));
    }
  }
  if (normalized.type === 'video' && !normalized.sourceVideoUrl) {
    throw new Error('没有读取到视频地址，请在笔记详情页播放几秒后重新导入');
  }
  const withImages = await localizeNoteMedia(normalized, {
    mediaDirectory,
    publicBaseUrl,
  });
  const imported = await localizeNoteVideo(withImages, {
    mediaDirectory,
    publicBaseUrl,
  });
  const note = {
    ...imported,
    category: inferCategoryFromNote(imported),
    savedAt: new Date().toISOString(),
  };

  const existingNotes = await readNotes();
  const merged = mergeImportedNote(existingNotes, note);
  await writeNotes(merged.notes);
  broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });

  return {
    notes: merged.notes,
    note,
    created: merged.created,
    lastImportedAt: note.savedAt,
  };
}

async function deleteNote(noteId) {
  const existingNotes = await readNotes();
  const removed = removeStoredNote(existingNotes, noteId);
  if (!removed.deletedNote) return null;

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
  const updated = { ...note };

  if (typeof updates.title === 'string') {
    updated.title = updates.title;
  }
  if (Array.isArray(updates.tags)) {
    updated.tags = updates.tags;
  }

  updated.category = inferCategoryFromNote(updated);

  const updatedNotes = [...existingNotes];
  updatedNotes[noteIndex] = updated;
  await writeNotes(updatedNotes);
  broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });

  return {
    notes: updatedNotes,
    note: updated,
    lastImportedAt: getLastImportedAt(updatedNotes),
  };
}

function queueNoteUpdate(noteId, updates) {
  return queueMutation(() => updateNote(noteId, updates));
}

function queueMutation(callback) {
  const result = mutationQueue.then(callback);
  mutationQueue = result.catch(() => undefined);
  return result;
}

function queueNoteImport(body) {
  return queueMutation(() => importNote(body));
}

function queueNoteDelete(noteId) {
  return queueMutation(() => deleteNote(noteId));
}

async function reanalyzeNoteVideo(noteId) {
  const notes = await readNotes();
  const noteIndex = notes.findIndex((note) => note.id === noteId);
  if (noteIndex < 0) return null;

  const updatedNote = await reanalyzeStoredNoteVideo(notes[noteIndex], {
    mediaDirectory,
    publicBaseUrl,
  });
  const updatedNotes = [...notes];
  updatedNotes[noteIndex] = updatedNote;
  await writeNotes(updatedNotes);
  broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });
  return {
    notes: updatedNotes,
    note: updatedNote,
    lastImportedAt: getLastImportedAt(updatedNotes),
  };
}

function queueVideoReanalysis(noteId) {
  return queueMutation(() => reanalyzeNoteVideo(noteId));
}

async function sendMediaFile(request, response, pathname) {
  const match = pathname.match(/^\/media\/([0-9a-f]{24})\/(\d{2}\.(?:avif|gif|heic|heif|jpg|png|webp))$/i);
  if (!match) return false;

  const filePath = path.join(mediaDirectory, match[1].toLowerCase(), match[2].toLowerCase());
  try {
    const body = await readFile(filePath);
    applyCorsHeaders(request, response);
    response.writeHead(200, {
      'Content-Type': mediaContentTypes.get(path.extname(filePath)) || 'application/octet-stream',
      'Content-Length': body.byteLength,
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    response.end(body);
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
      const start = rangeMatch[1] ? Number.parseInt(rangeMatch[1], 10) : 0;
      const requestedEnd = rangeMatch[2] ? Number.parseInt(rangeMatch[2], 10) : fileStats.size - 1;
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
      createReadStream(filePath, { start, end }).pipe(response);
      return true;
    }

    response.writeHead(200, { 'Content-Length': fileStats.size });
    createReadStream(filePath).pipe(response);
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
        'Access-Control-Allow-Origin': '*',
      });
      response.write('data: {"type":"connected"}\n\n');
      sseClients.add(response);
      request.on('close', () => sseClients.delete(response));
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

    if (request.method === 'POST' && url.pathname === '/setup/agent/connect') {
      const body = await readRequestBody(request);
      sendJson(request, response, 200, await connectAgentClient(body.client));
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

    if (request.method === 'POST' && url.pathname === '/notes/import') {
      sendJson(request, response, 200, await queueNoteImport(await readRequestBody(request)));
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
    if (request.method === 'GET' && summaryNoteMatch) {
      const notes = await readNotes();
      const note = notes.find((n) => n.id === summaryNoteMatch[1].toLowerCase());
      if (!note) {
        sendJson(request, response, 404, { ok: false, error: '笔记不存在' });
        return;
      }
      const summary = summarizeNote(note);
      sendJson(request, response, 200, { ok: true, summary });
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

    if (request.method === 'GET' && url.pathname === '/data/info') {
      sendJson(request, response, 200, await getDataInfo());
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
      const result = await queueMutation(() => repairNoteIntegrity(body.noteId));
      if (!result) {
        sendJson(request, response, 404, { ok: false, error: '笔记不存在' });
        return;
      }
      sendJson(request, response, 200, result);
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

    sendJson(request, response, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    sendJson(request, response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

async function startServer() {
  await ensureDataDirectory();
  const existingNotes = await readNotes();
  const recovered = await recoverCachedNoteCovers(existingNotes, {
    cacheDirectories: coverCacheDirectories,
    mediaDirectory,
    publicBaseUrl,
  });
  if (recovered.recoveredCount > 0) await writeNotes(recovered.notes);

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`local-api listening on http://127.0.0.1:${PORT}`);
    console.log(`local data directory: ${dataDirectory}`);
    if (recovered.recoveredCount > 0) {
      console.log(`recovered ${recovered.recoveredCount} cached note covers`);
    }
    runAutoBackup();
    // Run auto-backup every 24 hours
    autoBackupTimer = setInterval(runAutoBackup, 24 * 60 * 60 * 1000);
  });
}

startServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
