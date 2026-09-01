const DRAG_PAYLOAD_PREFIX = 'KANBOX_NOTE:';
const CARD_DRAG_PAYLOAD_PREFIX = 'KANBOX_CARD:';
const ALLOWED_HOSTS = new Set([
  'xiaohongshu.com',
  'www.xiaohongshu.com',
  'm.xiaohongshu.com',
]);
// 小红书 App/网页分享短链域名，需要先展开重定向到真实笔记页
const SHORT_LINK_HOSTS = new Set([
  'xhslink.com',
  'www.xhslink.com',
]);

const NOTE_PATH_PATTERNS = [
  /^\/explore\/([0-9a-f]{24})(?:\/|$)/i,
  /^\/search_result\/([0-9a-f]{24})(?:\/|$)/i,
  /^\/discovery\/item\/([0-9a-f]{24})(?:\/|$)/i,
  /^\/user\/profile\/[0-9a-f]{24}\/([0-9a-f]{24})(?:\/|$)/i,
];

function extractUrls(input) {
  if (typeof input !== 'string') return [];
  return input.match(/https?:\/\/[^\s<>"'，。！？；）】]+/gi)
    ?.map((value) => value.replace(/[),.;!?]+$/g, '')) ?? [];
}

function parseSupportedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('没有识别到有效的小红书笔记链接');
  }

  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('只支持小红书笔记页面');
  }

  return url;
}

// 判断是否为小红书短链（xhslink.com），需要展开才能拿到真实 noteId 与 xsec_token
export function isShortLink(value) {
  if (typeof value !== 'string') return false;
  try {
    return SHORT_LINK_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function extractSharedNoteUrl(input) {
  const candidates = extractUrls(input);
  // 优先匹配小红书长链
  const supportedUrl = candidates
    .map((value) => {
      try {
        return parseSupportedUrl(value);
      } catch {
        return null;
      }
    })
    .find(Boolean);

  if (supportedUrl) return supportedUrl.toString();

  // 否则接受小红书短链（xhslink.com），由 importNote 展开重定向
  const shortLink = candidates.find((value) => isShortLink(value));
  if (shortLink) return new URL(shortLink).toString();

  throw new Error('没有识别到有效的小红书笔记链接');
}

export function extractNoteIdFromUrl(value) {
  const url = parseSupportedUrl(value);
  for (const pattern of NOTE_PATH_PATTERNS) {
    const match = url.pathname.match(pattern);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

export function prepareBatchImportInputs(inputs, maxItems = 50) {
  const raw = Array.isArray(inputs) ? inputs : [];
  if (raw.length === 0) return { items: [], duplicates: [], totalRequested: 0 };
  if (raw.length > 500) throw new Error('一次最多粘贴 500 行');
  const items = [];
  const duplicates = [];
  const seen = new Set();
  raw.forEach((value, index) => {
    const input = String(value ?? '').trim();
    if (!input) return;
    let sourceUrl = '';
    try { sourceUrl = extractSharedNoteUrl(input); } catch {}
    const noteId = sourceUrl ? extractNoteIdFromUrl(sourceUrl) : '';
    const key = noteId ? `id:${noteId.toLowerCase()}` : `raw:${input.normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN')}`;
    if (seen.has(key)) {
      duplicates.push({ index, input: input.slice(0, 500), reason: '重复输入已跳过' });
      return;
    }
    seen.add(key);
    items.push({ input, originalIndex: index });
  });
  if (items.length > maxItems) throw new Error(`去重后一次最多批量导入 ${maxItems} 条笔记`);
  return { items, duplicates, totalRequested: raw.length };
}

export function serializeDraggedNote(note) {
  return `${DRAG_PAYLOAD_PREFIX}${JSON.stringify(note)}`;
}

export function parseDraggedNoteInput(input) {
  if (typeof input !== 'string') return null;
  const markerIndex = input.indexOf(DRAG_PAYLOAD_PREFIX);
  if (markerIndex === -1) return null;

  try {
    return JSON.parse(input.slice(markerIndex + DRAG_PAYLOAD_PREFIX.length));
  } catch {
    throw new Error('拖入的笔记数据已损坏，请刷新页面后重试');
  }
}

export function parseDraggedCardInput(input) {
  if (typeof input !== 'string') return null;
  const markerIndex = input.indexOf(CARD_DRAG_PAYLOAD_PREFIX);
  if (markerIndex === -1) return null;

  try {
    const payload = JSON.parse(input.slice(markerIndex + CARD_DRAG_PAYLOAD_PREFIX.length));
    const sourceUrl = extractSharedNoteUrl(cleanText(payload?.sourceUrl, 5000));
    const noteId = extractNoteIdFromUrl(sourceUrl);
    if (!noteId || noteId !== cleanText(payload?.id, 100).toLowerCase()) return null;
    return {
      id: noteId,
      sourceUrl,
      title: cleanText(payload?.title, 300),
    };
  } catch {
    throw new Error('拖入的笔记链接已损坏，请刷新小红书页面后重试');
  }
}

function cleanText(value, maxLength = 20000) {
  return typeof value === 'string'
    ? value.replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim().slice(0, maxLength)
    : '';
}

// 取第一个非负整数（点赞/收藏/评论数），拿不到或非法返回 0。
function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeImageUrls(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item, 3000))
    .filter((item) => /^https:\/\//i.test(item))
    .slice(0, 20);
}

function normalizeVideoUrl(value) {
  const candidate = cleanText(value, 5000);
  return /^https:\/\//i.test(candidate) ? candidate : '';
}

export function normalizeImportedNote(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('没有读取到笔记内容');
  }

  const sharedUrl = extractSharedNoteUrl(cleanText(payload.sourceUrl, 5000));
  const sourceUrlObject = new URL(sharedUrl);
  // 保留 xsec_token / xsec_source（小红书 2026 反爬必需），清除其他追踪参数
  const keepParams = new URLSearchParams();
  for (const key of ['xsec_token', 'xsec_source']) {
    const val = sourceUrlObject.searchParams.get(key);
    if (val) keepParams.set(key, val);
  }
  sourceUrlObject.search = keepParams.toString() ? `?${keepParams.toString()}` : '';
  sourceUrlObject.hash = '';
  const sourceUrl = sourceUrlObject.toString();
  const noteId = extractNoteIdFromUrl(sourceUrl) || cleanText(payload.id, 100);
  if (!/^[0-9a-f]{24}$/i.test(noteId)) {
    throw new Error('当前页面不是可识别的小红书笔记');
  }

  const title = cleanText(payload.title, 300) || '未命名笔记';
  const content = cleanText(payload.content);
  if (!content && title === '未命名笔记') {
    throw new Error('当前页面没有可收藏的正文，请先打开笔记详情');
  }

  const imageUrls = normalizeImageUrls(payload.imageUrls);
  const type = payload.type === 'video' ? 'video' : 'normal';
  const sourceVideoUrl = type === 'video'
    ? normalizeVideoUrl(payload.videoUrl || payload.sourceVideoUrl)
    : '';

  return {
    id: noteId.toLowerCase(),
    sourceUrl,
    title,
    content,
    rawContent: content,
    ocrText: '',
    coverUrl: cleanText(payload.coverUrl, 3000) || imageUrls[0] || '',
    imageUrls,
    sourceImageUrls: imageUrls,
    imageOcr: [],
    mediaStatus: imageUrls.length > 0 ? 'pending' : 'none',
    mediaError: '',
    sourceVideoUrl,
    videoUrl: '',
    videoDuration: 0,
    transcriptText: '',
    transcriptSegments: [],
    videoStatus: sourceVideoUrl ? 'pending' : 'none',
    videoError: '',
    author: {
      name: cleanText(payload.author?.name, 200) || '未知作者',
      avatar: cleanText(payload.author?.avatar, 3000),
      userId: cleanText(payload.author?.userId, 200),
    },
    likes: nonNegativeInt(payload.likes),
    collects: nonNegativeInt(payload.collects),
    comments: nonNegativeInt(payload.comments),
    category: '待分类',
    savedAt: new Date().toISOString(),
    tags: Array.isArray(payload.tags)
      ? payload.tags.map((tag) => cleanText(tag, 100)).filter(Boolean).slice(0, 20)
      : [],
    type,
    imageAspect: undefined,
  };
}

export function noteFromSharedText(input) {
  const sourceUrl = extractSharedNoteUrl(input);
  const withoutUrl = cleanText(input).replace(sourceUrl, '').trim();
  const lines = withoutUrl
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(复制|打开小红书|查看完整笔记)/.test(line));

  const meaningfulText = lines.join('\n').trim();

  // 单独拖入链接没有正文：抛出异常，由 importNote 走匿名解析补全正文与配图
  if (meaningfulText.length < 12) {
    throw new Error('需要匿名解析正文');
  }

  return normalizeImportedNote({
    sourceUrl,
    title: lines[0],
    content: lines.slice(1).join('\n') || lines[0],
  });
}

// 机器推断的过渡态分类：重导入「刷新内容」时应让新推断结果接管，而不是沿用旧过渡值。
// 其余分类视为「已确定」（可能是用户手动拖拽改的），重导入时保留，避免手动策展被顶掉（P1#1）。
const REINFER_CATEGORY_VALUES = new Set(['待分类', '其他', '']);

export function mergeImportedNote(existingNotes, importedNote) {
  const safeExistingNotes = Array.isArray(existingNotes) ? existingNotes : [];
  const existingIndex = safeExistingNotes.findIndex((note) => note?.id === importedNote?.id);
  const created = existingIndex < 0;
  if (created) {
    return { created, notes: [importedNote, ...safeExistingNotes] };
  }

  const existing = safeExistingNotes[existingIndex];
  // 重导入只覆盖内容性字段，保留用户手动策展：
  // - 分类：旧值非机器过渡态（待分类/其他/空）时保留，否则用新推断；
  // - 标签：新数据为空时保留旧的（避免解析失败把用户标签清空）；
  // - AI 摘要/拓展：保留已生成的（虽会被后台流水线自愈，但手动触发的也不应丢）；
  // - savedAt：保留首次收录时间，重导入不应把笔记顶到列表最前。
  const merged = {
    ...importedNote,
    category: REINFER_CATEGORY_VALUES.has(existing?.category)
      ? importedNote.category
      : (existing?.category ?? importedNote.category),
    tags: Array.isArray(importedNote.tags) && importedNote.tags.length > 0
      ? importedNote.tags
      : (Array.isArray(existing?.tags) ? existing.tags : []),
    aiSummary: existing?.aiSummary ?? importedNote.aiSummary,
    aiSummaryEngine: existing?.aiSummaryEngine ?? importedNote.aiSummaryEngine,
    aiExpansion: existing?.aiExpansion ?? importedNote.aiExpansion,
    savedAt: existing?.savedAt ?? importedNote.savedAt,
    favorite: existing?.favorite ?? importedNote.favorite ?? false,
    readState: existing?.readState ?? importedNote.readState ?? 'unread',
    lastReadAt: existing?.lastReadAt ?? importedNote.lastReadAt,
  };

  const notes = [...safeExistingNotes];
  notes[existingIndex] = merged;
  return { created, notes };
}

export function removeStoredNote(existingNotes, noteId) {
  const safeExistingNotes = Array.isArray(existingNotes) ? existingNotes : [];
  const deletedNote = safeExistingNotes.find((note) => note?.id === noteId) || null;

  return {
    deletedNote,
    notes: deletedNote
      ? safeExistingNotes.filter((note) => note?.id !== noteId)
      : safeExistingNotes,
  };
}
