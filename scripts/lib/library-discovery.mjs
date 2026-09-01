import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_CANDIDATES = 100;
const MAX_ARCHIVES_PER_LIBRARY = 50;

function candidateId(kind, candidatePath) {
  return createHash('sha256').update(`${kind}\0${path.resolve(candidatePath)}`).digest('hex').slice(0, 24);
}

function timestamp(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

async function directorySize(root) {
  if (!existsSync(root)) return 0;
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directorySize(entryPath);
    else if (entry.isFile()) total += (await stat(entryPath)).size;
  }
  return total;
}

async function countFiles(root) {
  if (!existsSync(root)) return 0;
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    total += entry.isDirectory() ? await countFiles(path.join(root, entry.name)) : entry.isFile() ? 1 : 0;
  }
  return total;
}

async function analyzeDirectory(directory, currentDirectory) {
  const notesPath = path.join(directory, 'notes.json');
  if (!existsSync(notesPath)) return null;
  const notesInfo = await lstat(notesPath).catch(() => null);
  if (!notesInfo?.isFile() || notesInfo.isSymbolicLink()) return null;
  let notes;
  try {
    notes = JSON.parse(await readFile(notesPath, 'utf8'));
  } catch (error) {
    return {
      id: candidateId('directory', directory), kind: 'directory', path: directory,
      name: path.basename(directory), status: 'damaged', noteCount: 0, mediaFiles: 0,
      size: notesInfo.size,
      lastUpdatedAt: '', issue: `notes.json 无法解析：${error instanceof Error ? error.message : '未知错误'}`,
      isCurrent: path.resolve(directory) === path.resolve(currentDirectory),
    };
  }
  if (!Array.isArray(notes)) {
    return {
      id: candidateId('directory', directory), kind: 'directory', path: directory,
      name: path.basename(directory), status: 'damaged', noteCount: 0, mediaFiles: 0,
      size: notesInfo.size, lastUpdatedAt: '', issue: 'notes.json 不是数组',
      isCurrent: path.resolve(directory) === path.resolve(currentDirectory),
    };
  }
  const validNotes = notes.filter((note) => note && typeof note.id === 'string');
  const invalidNotes = notes.length - validNotes.length;
  const latest = validNotes.reduce((value, note) => Math.max(value, timestamp(note.updatedAt || note.savedAt)), 0);
  const [mediaFiles, size] = await Promise.all([
    countFiles(path.join(directory, 'media')),
    directorySize(directory),
  ]);
  return {
    id: candidateId('directory', directory), kind: 'directory', path: directory,
    name: path.basename(directory), status: invalidNotes ? 'warning' : 'healthy',
    noteCount: notes.length, invalidNotes, mediaFiles, size,
    lastUpdatedAt: latest ? new Date(latest).toISOString() : notesInfo.mtime.toISOString(),
    issue: invalidNotes ? `${invalidNotes} 条记录缺少 ID` : '',
    isCurrent: path.resolve(directory) === path.resolve(currentDirectory),
  };
}

async function archiveCandidates(directory) {
  const backups = path.join(directory, 'backups');
  if (!existsSync(backups)) return [];
  const entries = await readdir(backups, { withFileTypes: true });
  const archives = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.kanbox')).slice(-MAX_ARCHIVES_PER_LIBRARY)) {
    const archivePath = path.join(backups, entry.name);
    const info = await stat(archivePath);
    archives.push({
      id: candidateId('archive', archivePath), kind: 'archive', path: archivePath,
      name: entry.name, status: 'unverified', noteCount: null, mediaFiles: null,
      size: info.size, lastUpdatedAt: info.mtime.toISOString(), issue: '', isCurrent: false,
    });
  }
  return archives;
}

async function migrationSnapshots(parent, baseName) {
  if (!existsSync(parent)) return [];
  const entries = await readdir(parent, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${baseName}.kanbox-before-migration-`))
    .map((entry) => path.join(parent, entry.name));
}

export async function discoverLibraries({ currentDirectory, knownDirectories = [], homeDirectory = os.homedir() }) {
  const current = path.resolve(currentDirectory);
  const localDefault = process.platform === 'darwin'
    ? path.join(homeDirectory, 'Library', 'Application Support', 'com.kanbox.app')
    : path.join(homeDirectory, '.kanbox');
  const icloud = path.join(homeDirectory, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'kanbox');
  const baseDirectories = [
    current,
    localDefault,
    icloud,
    path.join(homeDirectory, '.kanbox'),
    path.join(homeDirectory, 'Library', 'Application Support', 'kanbox'),
    path.join(homeDirectory, 'Library', 'Application Support', 'com.kanbox'),
    ...knownDirectories,
  ].map((item) => path.resolve(item));
  for (const directory of [...baseDirectories]) {
    baseDirectories.push(...await migrationSnapshots(path.dirname(directory), path.basename(directory)));
  }
  const uniqueDirectories = [...new Set(baseDirectories)].slice(0, MAX_CANDIDATES);
  const candidates = [];
  for (const directory of uniqueDirectories) {
    const info = await lstat(directory).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    const analyzed = await analyzeDirectory(directory, current);
    if (analyzed) candidates.push(analyzed);
    candidates.push(...await archiveCandidates(directory));
  }
  candidates.sort((left, right) => {
    if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
    return timestamp(right.lastUpdatedAt) - timestamp(left.lastUpdatedAt);
  });
  return candidates.slice(0, MAX_CANDIDATES);
}

export function findCandidate(candidates, id) {
  return candidates.find((candidate) => candidate.id === id) || null;
}
