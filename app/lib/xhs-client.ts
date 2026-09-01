import { Note } from '../types/xiaohongshu';
import { inferCategoryFromNote } from '../../scripts/lib/category-inference.mjs';

type RawNote = Omit<Partial<Note>, 'savedAt' | 'type' | 'imageAspect'> & {
  savedAt?: unknown;
  type?: unknown;
  imageAspect?: unknown;
};

type NotesSource = 'embedded' | 'sidecar';

type RemoteNotesPayload =
  | {
      notes?: RawNote[];
      lastImportedAt?: unknown;
    }
  | RawNote[];

export type LocalServiceHealth = {
  ok: boolean;
  source: NotesSource;
};

export type AgentClient = 'codex' | 'claude';

export type LocalSetupInfo = {
  extension: {
    available: boolean;
    path: string | null;
    version: string | null;
  };
  agent: {
    available: boolean;
    serverPath: string | null;
    nodePath: string;
    dataDirectory: string;
    clients: Record<AgentClient, { available: boolean }>;
  };
};

export type ImportNoteResult = {
  notes: Note[];
  note: Note;
  created: boolean;
};

export type BatchImportResult = {
  notes: Note[];
  succeeded: number;
  failed: number;
  created: number;
  updated: number;
  skipped: number;
  totalRequested: number;
  results: Array<{ ok: boolean; id?: string; title?: string; created?: boolean; input?: string; index?: number; skipped?: boolean; error?: string }>;
};

export type UpdateNoteResult = {
  notes: Note[];
  note: Note;
};

export type DeleteNoteResult = {
  notes: Note[];
  deletedId: string;
};

export type DeskWorkspaceSnapshot = {
  groups: Array<{
    id: string;
    name: string;
    kind: 'auto' | 'custom' | 'inbox';
    sourceCategory?: string;
  }>;
  noteGroupMap: Record<string, string>;
  knownNoteIds?: string[];
  revision?: number;
  updatedAt?: string;
  updatedBy?: string;
};

export type AiSettings = {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  model: string;
  autoTranscript: boolean;
  enhanceTranscript: boolean;
  autoPipeline: boolean;
  transcribeEndpoint: string;
  transcribeApiKey: string;
  transcribeModel: string;
  apiKeySet?: boolean;
  transcribeApiKeySet?: boolean;
};

type NotesResponse = {
  notes: Note[];
  lastImportedAt: string | null;
  source: NotesSource;
};

const DEFAULT_LOCAL_API_BASE_URL = 'http://127.0.0.1:4318';
const CONFIGURED_LOCAL_API_BASE_URL = (process.env.NEXT_PUBLIC_LOCAL_API_BASE_URL || '')
  .trim()
  .replace(/\/+$/, '');
const LOCAL_API_BASE_URL = CONFIGURED_LOCAL_API_BASE_URL || DEFAULT_LOCAL_API_BASE_URL;
const LOCAL_API_TIMEOUT_MS = 2500;

async function fetchLocalApi<T>(path: string, init?: RequestInit, timeoutMs: number = LOCAL_API_TIMEOUT_MS): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${LOCAL_API_BASE_URL}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorPayload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const message = typeof errorPayload?.error === 'string'
        ? errorPayload.error
        : `Local API request failed: ${response.status}`;
      throw new Error(message);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

function normalizeNote(note: Partial<Note>): Note {
  // 后端已确定 category（导入时推断、手动拖拽显式写入、重新归档时重推断）——
  // 前端应尊重后端值，而不是每次重新推断覆盖用户的手动分类（v0.7.2 遗漏修复）。
  const normalizedCategory =
    typeof note.category === 'string' && note.category.trim()
      ? note.category.trim()
      : inferCategoryFromNote(note);

  return {
    id: typeof note.id === 'string' && /^[0-9a-f]{24}$/i.test(note.id) ? note.id : '',
    sourceUrl: note.sourceUrl,
    title: note.title || '未命名笔记',
    content: note.content || '',
    rawContent: note.rawContent || note.content || '',
    ocrText: note.ocrText || '',
    coverUrl: typeof note.coverUrl === 'string' ? note.coverUrl : '',
    imageUrls: Array.isArray(note.imageUrls) ? note.imageUrls.filter(Boolean) : [],
    sourceImageUrls: Array.isArray(note.sourceImageUrls) ? note.sourceImageUrls.filter(Boolean) : [],
    imageOcr: Array.isArray(note.imageOcr) ? note.imageOcr : [],
    mediaStatus: note.mediaStatus,
    mediaError: note.mediaError,
    sourceVideoUrl: typeof note.sourceVideoUrl === 'string' ? note.sourceVideoUrl : '',
    videoUrl: typeof note.videoUrl === 'string' ? note.videoUrl : '',
    videoDuration: typeof note.videoDuration === 'number' ? note.videoDuration : 0,
    transcriptText: typeof note.transcriptText === 'string' ? note.transcriptText : '',
    transcriptSegments: Array.isArray(note.transcriptSegments) ? note.transcriptSegments : [],
    transcriptSkipped: note.transcriptSkipped === true,
    transcriptEngine: note.transcriptEngine === 'ai' ? 'ai' : note.transcriptEngine === 'local' ? 'local' : undefined,
    transcriptStatus: note.transcriptStatus === 'pending' || note.transcriptStatus === 'error' ? note.transcriptStatus : undefined,
    aiSummary: typeof note.aiSummary === 'string' ? note.aiSummary : '',
    aiSummaryEngine: note.aiSummaryEngine === 'ai' ? 'ai' : note.aiSummaryEngine === 'local' ? 'local' : undefined,
    aiExpansion: typeof note.aiExpansion === 'string' ? note.aiExpansion : '',
    videoStatus: note.videoStatus,
    videoError: note.videoError,
    author: {
      name: note.author?.name || '未知作者',
      avatar: note.author?.avatar,
      userId: note.author?.userId,
    },
    likes: typeof note.likes === 'number' ? note.likes : 0,
    collects: typeof note.collects === 'number' ? note.collects : 0,
    comments: typeof note.comments === 'number' ? note.comments : 0,
    category: normalizedCategory,
    savedAt: toDate(note.savedAt),
    updatedAt: typeof note.updatedAt === 'string' ? note.updatedAt : undefined,
    updatedBy: typeof note.updatedBy === 'string' ? note.updatedBy : undefined,
    revision: Number.isSafeInteger(Number(note.revision)) ? Number(note.revision) : undefined,
    syncConflict: note.syncConflict === true,
    syncConflictFields: Array.isArray(note.syncConflictFields)
      ? note.syncConflictFields.map((field) => String(field)).filter(Boolean).slice(0, 100)
      : [],
    favorite: note.favorite === true,
    readState: note.readState === 'read' || note.readState === 'later' ? note.readState : 'unread',
    lastReadAt: typeof note.lastReadAt === 'string' ? note.lastReadAt : undefined,
    tags: Array.isArray(note.tags) ? note.tags : [],
    type: note.type === 'video' ? 'video' : 'normal',
    imageAspect: note.imageAspect,
  };
}

function normalizeRemoteNotes(payload: RemoteNotesPayload): NotesResponse {
  if (Array.isArray(payload)) {
    return {
      notes: payload.map((note) => normalizeNote(note as Partial<Note>)).filter((note) => note.id !== ''),
      lastImportedAt: null,
      source: 'sidecar',
    };
  }

  return {
    notes: Array.isArray(payload.notes)
      ? payload.notes.map((note) => normalizeNote(note as Partial<Note>)).filter((note) => note.id !== '')
      : [],
    lastImportedAt: typeof payload.lastImportedAt === 'string' ? payload.lastImportedAt : null,
    source: 'sidecar',
  };
}

async function readNotes(): Promise<NotesResponse> {
  const payload = await fetchLocalApi<RemoteNotesPayload>('/notes');
  return normalizeRemoteNotes(payload);
}

export async function getLocalServiceHealth(): Promise<LocalServiceHealth> {
  try {
    const payload = await fetchLocalApi<{ ok?: boolean }>('/health');
    return {
      ok: payload.ok !== false,
      source: 'sidecar',
    };
  } catch {
    return {
      ok: false,
      source: 'sidecar',
    };
  }
}

export async function getLocalSetupInfo(): Promise<LocalSetupInfo> {
  return fetchLocalApi<LocalSetupInfo>('/setup', undefined, 8000);
}

export async function openBrowserExtensionSetup(): Promise<{ ok: boolean; path: string; message: string }> {
  return fetchLocalApi('/setup/browser-extension/open', { method: 'POST' }, 8000);
}

export async function openExternalUrl(url: string): Promise<{ ok: boolean }> {
  return fetchLocalApi('/setup/open-external', {
    method: 'POST',
    body: JSON.stringify({ url }),
  }, 8000);
}

export async function connectLocalAgent(client: AgentClient): Promise<{ ok: boolean; message: string }> {
  return fetchLocalApi('/setup/agent/connect', {
    method: 'POST',
    body: JSON.stringify({ client }),
  }, 45_000);
}

export async function getNotes(): Promise<Note[]> {
  const response = await readNotes();
  return response.notes;
}

export async function getDeskWorkspace(): Promise<DeskWorkspaceSnapshot> {
  const payload = await fetchLocalApi<{ workspace?: DeskWorkspaceSnapshot }>('/workspace');
  return payload.workspace || { groups: [], noteGroupMap: {}, knownNoteIds: [] };
}

export async function saveDeskWorkspace(workspace: DeskWorkspaceSnapshot): Promise<DeskWorkspaceSnapshot> {
  const payload = await fetchLocalApi<{ workspace?: DeskWorkspaceSnapshot }>('/workspace', {
    method: 'POST',
    body: JSON.stringify({ workspace }),
  });
  return payload.workspace || workspace;
}

export async function importSharedNote(input: string): Promise<ImportNoteResult> {
  const payload = await fetchLocalApi<{
    notes?: RawNote[];
    note?: RawNote;
    created?: boolean;
    lastImportedAt?: unknown;
  }>('/notes/import', {
    method: 'POST',
    body: JSON.stringify({ input }),
  }, 30 * 60_000);

  const response = normalizeRemoteNotes(payload);
  const notes = response.notes;
  const importedId = typeof payload.note?.id === 'string' ? payload.note.id : '';
  const note = notes.find((entry) => entry.id === importedId);
  if (!note) {
    throw new Error('笔记已保存，但返回结果不完整');
  }

  return {
    notes,
    note,
    created: payload.created !== false,
  };
}

export async function importSharedNotes(inputs: string[]): Promise<BatchImportResult> {
  const payload = await fetchLocalApi<{
    notes?: RawNote[];
    succeeded?: number;
    failed?: number;
    created?: number;
    updated?: number;
    skipped?: number;
    totalRequested?: number;
    results?: BatchImportResult['results'];
  }>('/notes/import/batch', {
    method: 'POST',
    body: JSON.stringify({ inputs }),
  }, 60 * 60_000);
  const response = normalizeRemoteNotes(payload);
  return {
    notes: response.notes,
    succeeded: payload.succeeded || 0,
    failed: payload.failed || 0,
    created: payload.created || 0,
    updated: payload.updated || 0,
    skipped: payload.skipped || 0,
    totalRequested: payload.totalRequested || inputs.length,
    results: Array.isArray(payload.results) ? payload.results : [],
  };
}

export async function updateNote(noteId: string, updates: {
  title?: string;
  tags?: string[];
  category?: string;
  favorite?: boolean;
  readState?: 'unread' | 'read' | 'later';
  resolveSyncConflict?: boolean;
}): Promise<UpdateNoteResult> {
  const payload = await fetchLocalApi<{
    notes?: RawNote[];
    note?: RawNote;
    lastImportedAt?: unknown;
  }>(`/notes/${encodeURIComponent(noteId)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });

  const response = normalizeRemoteNotes(payload);
  const notes = response.notes;
  const updatedId = typeof payload.note?.id === 'string' ? payload.note.id : '';
  const note = notes.find((entry) => entry.id === updatedId);
  if (!note) {
    throw new Error('笔记更新失败');
  }

  return { notes, note };
}

export async function batchOrganizeNotes(ids: string[], updates: { addTags?: string[]; removeTags?: string[]; category?: string }): Promise<{ notes: Note[]; updatedCount: number }> {
  const payload = await fetchLocalApi<{ notes?: RawNote[]; updatedCount?: number }>('/notes/batch-organize', {
    method: 'POST', body: JSON.stringify({ ids, updates }),
  });
  return { notes: normalizeRemoteNotes(payload).notes, updatedCount: payload.updatedCount || 0 };
}

export async function batchDeleteNotes(ids: string[]): Promise<{ notes: Note[]; deletedCount: number }> {
  const payload = await fetchLocalApi<{ notes?: RawNote[]; deletedCount?: number }>('/notes/batch-delete', {
    method: 'POST', body: JSON.stringify({ ids }),
  });
  return { notes: normalizeRemoteNotes(payload).notes, deletedCount: payload.deletedCount || 0 };
}

export async function reCategorizeNotes(): Promise<{ notes: Note[]; reclassified: number; remaining: number }> {
  const payload = await fetchLocalApi<{
    notes?: RawNote[];
    reclassified?: number;
    remaining?: number;
  }>('/notes/re-categorize', { method: 'POST' }, 30_000);
  const response = normalizeRemoteNotes(payload);
  return {
    notes: response.notes,
    reclassified: typeof payload.reclassified === 'number' ? payload.reclassified : 0,
    remaining: typeof payload.remaining === 'number' ? payload.remaining : 0,
  };
}

export async function deleteStoredNote(noteId: string): Promise<DeleteNoteResult> {
  const payload = await fetchLocalApi<{
    notes?: RawNote[];
    deletedId?: unknown;
    lastImportedAt?: unknown;
  }>(`/notes/${encodeURIComponent(noteId)}`, {
    method: 'DELETE',
  });

  const response = normalizeRemoteNotes(payload);
  return {
    notes: response.notes,
    deletedId: typeof payload.deletedId === 'string' ? payload.deletedId : noteId,
  };
}

export type TagInfo = { name: string; count: number };

export type DataInfo = {
  dataDirectory: string;
  notesCount: number;
  mediaSize: number;
  backupCount: number;
};

export type IntegrityResult = {
  totalNotes: number;
  healthyNotes: number;
  brokenNotes: Array<{ id: string; title: string; missingFiles: string[] }>;
};

export async function exportNotes(): Promise<void> {
  try {
    // First check if service is available
    const health = await getLocalServiceHealth();
    if (!health.ok) {
      throw new Error('本地服务未连接，请先启动 Kanbox');
    }

    // Use fetch + blob download (works in Tauri webview)
    const response = await fetch(`${LOCAL_API_BASE_URL}/notes/export`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(errorPayload?.error || `导出失败: ${response.status}`);
    }

    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `kanbox-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new Error('本地服务未连接，请先启动 Kanbox');
    }
    throw error;
  }
}

export async function exportNotesMarkdown(): Promise<void> {
  try {
    // First check if service is available
    const health = await getLocalServiceHealth();
    if (!health.ok) {
      throw new Error('本地服务未连接，请先启动 Kanbox');
    }

    // Use fetch + blob download (works in Tauri webview)
    const response = await fetch(`${LOCAL_API_BASE_URL}/notes/export/markdown`, {
      method: 'GET',
      headers: { 'Accept': 'text/markdown' },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(errorPayload?.error || `导出失败: ${response.status}`);
    }

    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `kanbox-export-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new Error('本地服务未连接，请先启动 Kanbox');
    }
    throw error;
  }
}

export async function exportNotesHtml(): Promise<void> {
  try {
    // First check if service is available
    const health = await getLocalServiceHealth();
    if (!health.ok) {
      throw new Error('本地服务未连接，请先启动 Kanbox');
    }

    // Use fetch + blob download (works in Tauri webview)
    const response = await fetch(`${LOCAL_API_BASE_URL}/notes/export/html`, {
      method: 'GET',
      headers: { 'Accept': 'text/html' },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(errorPayload?.error || `导出失败: ${response.status}`);
    }

    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `kanbox-export-${new Date().toISOString().slice(0, 10)}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new Error('本地服务未连接，请先启动 Kanbox');
    }
    throw error;
  }
}

export async function getDataInfo(): Promise<DataInfo> {
  return fetchLocalApi<DataInfo>('/data/info', undefined, 10000);
}

export async function createBackup(): Promise<{ ok: boolean; path: string; size: number }> {
  return fetchLocalApi('/data/backup', { method: 'POST' }, 15000);
}

export type RestoreResult = {
  notes: Note[];
  imported: number;
  skipped: number;
  total: number;
  updated?: number;
  kept?: number;
  conflicts?: number;
};

export async function restoreFromBackup(file: File): Promise<RestoreResult> {
  const text = await file.text();
  const data = JSON.parse(text);
  const payload = await fetchLocalApi<{ notes: RawNote[]; imported: number; skipped: number; total: number; updated?: number; kept?: number; conflicts?: number }>('/data/restore', {
    method: 'POST',
    body: JSON.stringify(data),
  }, 60000);
  const response = normalizeRemoteNotes(payload);
  return {
    notes: response.notes,
    imported: payload.imported || 0,
    skipped: payload.skipped || 0,
    total: response.notes.length,
    updated: payload.updated || 0,
    kept: payload.kept || 0,
    conflicts: payload.conflicts || 0,
  };
}

export async function createFullArchive(): Promise<{ ok: boolean; name: string; size: number; noteCount: number }> {
  const result = await fetchLocalApi<{ ok: boolean; name: string; size: number; noteCount: number; downloadUrl: string }>(
    '/data/archive',
    { method: 'POST' },
    24 * 60 * 60_000,
  );
  const anchor = document.createElement('a');
  anchor.href = `${LOCAL_API_BASE_URL}${result.downloadUrl}`;
  anchor.download = result.name;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  return result;
}

export type FullArchiveRestoreResult = RestoreResult & {
  added: number;
  mediaFiles: number;
  sourceDeviceId: string;
};

export async function restoreFullArchive(file: File): Promise<FullArchiveRestoreResult> {
  const response = await fetch(`${LOCAL_API_BASE_URL}/data/archive/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `完整归档恢复失败：${response.status}`);
  }
  const payload = await response.json() as {
    notes?: RawNote[];
    added?: number;
    updated?: number;
    kept?: number;
    unchanged?: number;
    conflicts?: number;
    invalid?: number;
    mediaFiles?: number;
    sourceDeviceId?: string;
  };
  const normalized = normalizeRemoteNotes(payload);
  return {
    notes: normalized.notes,
    imported: payload.added || 0,
    added: payload.added || 0,
    updated: payload.updated || 0,
    kept: (payload.kept || 0) + (payload.unchanged || 0),
    conflicts: payload.conflicts || 0,
    skipped: payload.invalid || 0,
    total: normalized.notes.length,
    mediaFiles: payload.mediaFiles || 0,
    sourceDeviceId: payload.sourceDeviceId || '',
  };
}

export async function checkDataIntegrity(): Promise<IntegrityResult> {
  return fetchLocalApi('/data/integrity', undefined, 15000);
}

export async function repairNote(noteId: string): Promise<{ notes: Note[]; note: Note }> {
  const payload = await fetchLocalApi<{ notes: RawNote[]; note: RawNote }>('/data/integrity/repair', {
    method: 'POST',
    body: JSON.stringify({ noteId }),
  }, 60000);
  const response = normalizeRemoteNotes(payload);
  const note = response.notes.find(n => n.id === noteId);
  if (!note) throw new Error('修复结果不完整：笔记未找到');
  return { notes: response.notes, note };
}

export async function getAllTags(): Promise<TagInfo[]> {
  const data = await fetchLocalApi<{ tags: TagInfo[] }>('/tags');
  return data.tags || [];
}

export async function renameTag(oldName: string, newName: string): Promise<{ notes: Note[]; renamedCount: number }> {
  const payload = await fetchLocalApi<{ notes: RawNote[]; renamedCount: number }>('/tags/rename', {
    method: 'POST',
    body: JSON.stringify({ oldName, newName }),
  });
  const response = normalizeRemoteNotes(payload);
  return { notes: response.notes, renamedCount: payload.renamedCount };
}

export async function deleteTag(name: string): Promise<{ notes: Note[]; deletedCount: number }> {
  const payload = await fetchLocalApi<{ notes: RawNote[]; deletedCount: number }>('/tags/delete', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  const response = normalizeRemoteNotes(payload);
  return { notes: response.notes, deletedCount: payload.deletedCount };
}

export async function getNoteSummary(noteId: string): Promise<{ summary: string; note?: Note }> {
  const data = await fetchLocalApi<{ ok: boolean; summary: string; engine?: 'ai' | 'local'; note?: RawNote }>(
    `/notes/${noteId}/summary`,
    { method: 'POST' },
    90_000,
  );
  const normalizedNote = data.note ? normalizeNote(data.note as unknown as Partial<Note>) : undefined;
  return { summary: data.summary || '', note: normalizedNote };
}

export async function getNoteExpansion(noteId: string): Promise<{ expansion: string; note?: Note; needsTranscript?: boolean }> {
  const data = await fetchLocalApi<{ ok: boolean; expansion: string; note?: RawNote; needsTranscript?: boolean }>(
    `/notes/${noteId}/expand`,
    { method: 'POST' },
    90_000,
  );
  return {
    expansion: data.expansion || '',
    note: data.note ? normalizeNote(data.note as unknown as Partial<Note>) : undefined,
    needsTranscript: data.needsTranscript === true,
  };
}

export async function transcribeNoteVideo(noteId: string): Promise<{ notes: Note[]; note: Note }> {
  const payload = await fetchLocalApi<{ notes?: RawNote[]; note?: RawNote }>(
    `/notes/${noteId}/transcribe`,
    { method: 'POST' },
    30 * 60_000,
  );
  const response = normalizeRemoteNotes(payload);
  const note = response.notes.find((entry) => entry.id === noteId);
  if (!note) throw new Error('转写结果不完整');
  return { notes: response.notes, note };
}

export async function getAiSettings(): Promise<AiSettings> {
  const data = await fetchLocalApi<{ ok: boolean; settings: AiSettings }>('/ai/settings', undefined, 8000);
  return data.settings;
}

export async function saveAiSettings(settings: Partial<AiSettings>): Promise<AiSettings> {
  const data = await fetchLocalApi<{ ok: boolean; settings: AiSettings }>('/ai/settings', {
    method: 'POST',
    body: JSON.stringify(settings),
  }, 8000);
  return data.settings;
}

export async function testAiConnection(settings: Partial<AiSettings>): Promise<string> {
  const data = await fetchLocalApi<{ ok: boolean; reply: string }>('/ai/test', {
    method: 'POST',
    body: JSON.stringify(settings),
  }, 35_000);
  return data.reply;
}

export async function testTranscribeConnection(settings: Partial<AiSettings>): Promise<string> {
  const data = await fetchLocalApi<{ ok: boolean; reply: string }>('/ai/test-transcribe', {
    method: 'POST',
    body: JSON.stringify(settings),
  }, 35_000);
  return data.reply;
}

export type PipelineKind = 'transcript' | 'summary' | 'expansion';

export type PipelineStatus = {
  running: boolean;
  status: 'idle' | 'running';
  queued: number;
  doneCount: number;
  totalCount: number;
  currentNoteId: string | null;
  currentKind: PipelineKind | null;
};

export type BatchProcessResult = {
  queued: number;
  status: PipelineStatus;
};

export async function batchProcessAi(kinds?: PipelineKind[]): Promise<BatchProcessResult> {
  return fetchLocalApi<BatchProcessResult>('/ai/batch-process', {
    method: 'POST',
    body: JSON.stringify({ kinds }),
  }, 30_000);
}

export async function getPipelineStatus(): Promise<PipelineStatus> {
  return fetchLocalApi<PipelineStatus>('/ai/pipeline', undefined, 8000);
}

/**
 * 订阅后台 AI 流水线的实时进度（SSE）。
 * onStatus 收到 pipeline-progress 事件，onNotesChanged 收到 notes-changed 事件（流水线更新了笔记）。
 * 返回取消订阅函数。
 */
export function subscribeToPipeline(
  onStatus: (status: PipelineStatus) => void,
  onNotesChanged: () => void,
): () => void {
  const eventSource = new EventSource(`${LOCAL_API_BASE_URL}/events`);
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse((event as MessageEvent).data);
      if (data?.type === 'pipeline-progress') {
        onStatus({
          running: Boolean(data.running),
          status: data.running ? 'running' : 'idle',
          queued: typeof data.queued === 'number' ? data.queued : 0,
          doneCount: typeof data.doneCount === 'number' ? data.doneCount : 0,
          totalCount: typeof data.totalCount === 'number' ? data.totalCount : 0,
          currentNoteId: typeof data.currentNoteId === 'string' ? data.currentNoteId : null,
          currentKind: data.currentKind ?? null,
        });
      } else if (data?.type === 'notes-changed') {
        onNotesChanged();
      }
    } catch {
      // 忽略无法解析的事件
    }
  };
  eventSource.onerror = () => {
    // EventSource 会自动重连
  };
  return () => eventSource.close();
}

export function formatNumber(num: number): string {
  if (num >= 10000) return (num / 10000).toFixed(1) + 'w';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return num.toString();
}

export function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days}天前`;
  if (days < 30) return `${Math.floor(days / 7)}周前`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function subscribeToUpdates(onUpdate: () => void): () => void {
  const eventSource = new EventSource(`${LOCAL_API_BASE_URL}/events`);
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse((event as MessageEvent).data);
      if (data?.type === 'notes-changed') onUpdate();
    } catch {
      // Ignore connection and malformed events; only notes-changed requires a reload.
    }
  };
  eventSource.onerror = () => {
    // Will auto-reconnect
  };
  return () => eventSource.close();
}

export type DailyReviewItem = {
  note: Note;
  status: 'pending' | 'reviewed' | 'later';
  reason: 'on-this-day' | 'rediscovery';
};

export type DailyReview = {
  date: string;
  count: number;
  items: DailyReviewItem[];
  reviewedCount: number;
  pendingCount: number;
  completed: boolean;
  completedAt: string;
  stats: { streak: number; completedDays: number };
};

export async function getDailyReview(): Promise<DailyReview> {
  const payload = await fetchLocalApi<{ ok: boolean; review: DailyReview }>('/daily-review', undefined, 8000);
  return payload.review;
}

export async function setDailyReviewCount(count: number): Promise<DailyReview> {
  const payload = await fetchLocalApi<{ ok: boolean; review: DailyReview }>('/daily-review/settings', {
    method: 'POST', body: JSON.stringify({ count }),
  }, 8000);
  return payload.review;
}

export async function updateDailyReview(
  type: 'reviewed' | 'later' | 'reset',
  noteId?: string,
): Promise<DailyReview> {
  const payload = await fetchLocalApi<{ ok: boolean; review: DailyReview }>('/daily-review/action', {
    method: 'POST', body: JSON.stringify({ type, noteId }),
  }, 8000);
  return payload.review;
}

export async function batchUpdateNoteStatus(
  ids: string[],
  updates: { favorite?: boolean; readState?: 'unread' | 'read' | 'later' },
): Promise<{ notes: Note[]; updatedCount: number }> {
  const payload = await fetchLocalApi<{ ok: boolean; notes: RawNote[]; updatedCount: number }>('/notes/batch-status', {
    method: 'POST', body: JSON.stringify({ ids, updates }),
  }, 60_000);
  const normalized = normalizeRemoteNotes(payload);
  return { notes: normalized.notes, updatedCount: payload.updatedCount };
}

// ─── 存储位置 ─────────────────────────────────────────────────────────────────

export type StorageLocation = 'icloud' | 'local' | 'custom';

export type StorageInfo = {
  dataDirectory: string;
  location: StorageLocation;
  icloudAvailable: boolean;
  icloudPath: string | null;
  localPath: string;
};

export type StorageMigrationResult = {
  migrated: boolean;
  from?: string;
  to?: string;
  backup?: string | null;
  noteCount?: number;
  sourceNoteCount?: number;
  targetNoteCount?: number;
  mediaFiles?: number;
  conflicts?: number;
};

export type LibraryCandidate = {
  id: string;
  kind: 'directory' | 'archive';
  path: string;
  name: string;
  status: 'healthy' | 'warning' | 'damaged' | 'unverified';
  noteCount: number | null;
  invalidNotes?: number;
  mediaFiles: number | null;
  size: number;
  lastUpdatedAt: string;
  issue: string;
  isCurrent: boolean;
};

export type LibraryDiscoveryResult = {
  ok: boolean;
  currentDirectory: string;
  candidates: LibraryCandidate[];
  recoverableCount: number;
};

export type LibraryRecoveryPreview = {
  candidate: LibraryCandidate;
  currentNoteCount: number;
  candidateNoteCount: number;
  resultNoteCount: number;
  added: number;
  updated: number;
  kept: number;
  conflicts: number;
  skipped: number;
  groupCount: number;
  archiveVerified: boolean;
};

export async function getStorageInfo(): Promise<StorageInfo> {
  return fetchLocalApi<{ ok: boolean } & StorageInfo>('/storage', undefined, 8000);
}

export async function discoverLibraries(): Promise<LibraryDiscoveryResult> {
  return fetchLocalApi<LibraryDiscoveryResult>('/libraries/discover', undefined, 30_000);
}

export async function previewLibraryRecovery(candidateId: string): Promise<LibraryRecoveryPreview> {
  const payload = await fetchLocalApi<{ ok: boolean; preview: LibraryRecoveryPreview }>(
    '/libraries/preview',
    { method: 'POST', body: JSON.stringify({ candidateId }) },
    120_000,
  );
  return payload.preview;
}

export async function restoreLibraryCandidate(candidateId: string): Promise<{ ok: boolean; notes: Note[]; total: number }> {
  const payload = await fetchLocalApi<{ ok: boolean; notes: RawNote[]; total: number }>(
    '/libraries/restore',
    { method: 'POST', body: JSON.stringify({ candidateId }) },
    24 * 60 * 60_000,
  );
  const normalized = normalizeRemoteNotes(payload);
  return { ok: payload.ok, notes: normalized.notes, total: normalized.notes.length };
}

export async function setStorageLocation(
  location: StorageLocation,
  path?: string,
): Promise<StorageInfo & { needsRestart: boolean; migrated: boolean; migration?: StorageMigrationResult; message: string }> {
  return fetchLocalApi<StorageInfo & { needsRestart: boolean; migrated: boolean; migration?: StorageMigrationResult; message: string }>(
    '/storage/location',
    { method: 'POST', body: JSON.stringify({ location, path }) },
    60_000,
  );
}

export async function restartApp(): Promise<{ ok: boolean; message: string }> {
  return fetchLocalApi<{ ok: boolean; message: string }>('/setup/restart', { method: 'POST' }, 8000);
}

// ─── AI 服务商/模型预设 ──────────────────────────────────────────────────────

export type ProviderModelPreset = { id: string; name: string; description: string };
export type ProviderPreset = { id: string; name: string; endpoint: string; models: ProviderModelPreset[] };
export type AiPresets = { llm: ProviderPreset[]; transcribe: ProviderPreset[] };

export async function getAiPresets(): Promise<AiPresets> {
  const data = await fetchLocalApi<{ ok: boolean; presets: AiPresets }>('/ai/presets', undefined, 8000);
  return data.presets;
}
