import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { inferCategoryFromNote } from './lib/category-inference.mjs';
import { recoverCachedNoteCovers } from './lib/cache-cover-recovery.mjs';
import { summarizeNote } from './lib/text-summary.mjs';
import {
  computePendingAiKinds,
  expandWithAi,
  hasTranscript,
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
  return Array.from(merged.values());
}

async function writeNotes(notes) {
  await ensureDataDirectory();
  // 串行化所有写操作，并用唯一临时文件名，避免并发写产生交错/损坏的 notes.json（B1 修复）
  const run = async () => {
    const tempPath = path.join(dataDirectory, `notes.${process.pid}.${++writeNotesSeq}.next.json`);
    try {
      await writeFile(tempPath, `${JSON.stringify(notes, null, 2)}\n`, 'utf8');
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
      tags: [...new Set(note.tags.map(t => t === oldName ? newName : t).filter(Boolean))],
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
  // 用 reduce 而非 Math.max(...spread)，避免大数组导致调用栈溢出（B16 修复）
  return new Date(timestamps.reduce((a, b) => Math.max(a, b), -Infinity)).toISOString();
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

async function exportNotesMarkdown() {
  const notes = await readNotes();
  let md = `# Kanbox 笔记导出\n\n导出时间: ${new Date().toISOString()}\n笔记总数: ${notes.length}\n\n---\n\n`;

  for (const note of notes) {
    md += `## ${note.title || '未命名笔记'}\n\n`;
    md += `- 作者: ${note.author?.name || '未知'}\n`;
    md += `- 分类: ${note.category || '未分类'}\n`;
    md += `- 保存时间: ${note.savedAt || ''}\n`;
    md += `- 来源: ${note.sourceUrl || ''}\n`;
    if (note.tags?.length) md += `- 标签: ${note.tags.join(', ')}\n`;
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
    if (note.sourceUrl) html += `<p><a href="${escapeHtml(note.sourceUrl)}" target="_blank">查看原帖</a></p>`;
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

async function restoreFromBackup(body) {
  if (!body || !Array.isArray(body.notes)) {
    throw new Error('备份文件格式不正确');
  }

  const existingNotes = await readNotes();
  const existingIds = new Set(existingNotes.map(n => n.id));
  let importedCount = 0;
  let skippedCount = 0;

  for (const note of body.notes) {
    if (
      !note
      || typeof note.id !== 'string'
      || !/^[0-9a-f]{24}$/i.test(note.id)
      || existingIds.has(note.id)
      || !isUsableStoredNote(note)
    ) {
      // 校验字段形状，避免畸形笔记污染 notes.json（B18 修复）
      skippedCount++;
      continue;
    }
    existingNotes.push(note);
    importedCount++;
  }

  await writeNotes(existingNotes);
  broadcastUpdate({ type: 'notes-changed', timestamp: new Date().toISOString() });
  return {
    notes: existingNotes,
    imported: importedCount,
    skipped: skippedCount,
    total: existingNotes.length,
  };
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
    } catch (error) {
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

  const existingNotes = await readNotes();
  const merged = mergeImportedNote(existingNotes, note);
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
    const cleaned = updates.title.replace(/\s+/g, ' ').trim().slice(0, 300);
    updated.title = cleaned || '未命名笔记';
  }
  if (Array.isArray(updates.tags)) {
    updated.tags = [...new Set(updates.tags.map(t => String(t || '').trim()).filter(Boolean).slice(0, 20))];
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
  const notes = await readNotes();
  const noteIndex = notes.findIndex((note) => note.id === noteId);
  if (noteIndex < 0) return null;

  const aiSettings = await loadAiSettings(dataDirectory);
  const updatedNote = await reanalyzeStoredNoteVideo(notes[noteIndex], buildTranscriptOptions(aiSettings));
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
        parsedBody = await readRequestBody(request);
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

async function startServer() {
  await ensureDataDirectory();
  const existingNotes = await readNotes();
  const recovered = await recoverCachedNoteCovers(existingNotes, {
    cacheDirectories: coverCacheDirectories,
    mediaDirectory,
    publicBaseUrl,
  });
  if (recovered.recoveredCount > 0) await writeNotes(recovered.notes);

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[kanbox] 端口 ${PORT} 已被占用：可能是上一次 Kanbox 异常退出后残留的 local-api 进程仍在运行。`);
      console.error('[kanbox] 若该进程不健康，请手动结束占用端口的进程（lsof -iTCP:' + PORT + ' -sTCP:LISTEN）后重启 Kanbox。');
    } else {
      console.error('[kanbox] local-api 启动失败:', error.message);
    }
    process.exit(1);
  });

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
