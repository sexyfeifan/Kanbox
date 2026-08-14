const PAGE_HOSTS = new Set([
  'xiaohongshu.com',
  'www.xiaohongshu.com',
  'm.xiaohongshu.com',
]);
const SHORT_LINK_HOSTS = new Set([
  'xhslink.com',
  'www.xhslink.com',
]);
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstString(object, keys) {
  for (const key of keys) {
    const value = cleanString(object?.[key]);
    if (value) return value;
  }
  return '';
}

function assertAllowedPageUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !PAGE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('匿名解析器只允许访问小红书笔记页面');
  }
  return url;
}

function imageUrlFromItem(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';

  const direct = firstString(item, ['urlDefault', 'urlPre', 'url', 'originUrl']);
  if (/^https?:\/\//i.test(direct)) return direct.replace(/^http:/i, 'https:');

  for (const listKey of ['urlList', 'infoList', 'stream']) {
    const list = item[listKey];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const nested = imageUrlFromItem(entry);
      if (nested) return nested;
    }
  }
  return '';
}

function imageUrlsFromNote(note) {
  const urls = [];
  for (const key of ['imageList', 'images', 'image_list']) {
    const list = note?.[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const url = imageUrlFromItem(item);
      if (url) urls.push(url);
    }
  }

  for (const candidate of [note?.cover, note?.video?.cover, note?.video?.firstFrame]) {
    const url = imageUrlFromItem(candidate);
    if (url) urls.push(url);
  }
  return Array.from(new Set(urls)).slice(0, 20);
}

function isAllowedVideoUrl(value) {
  try {
    const url = new URL(value.replace(/^http:/i, 'https:'));
    return url.protocol === 'https:'
      && (url.hostname.endsWith('.xhscdn.com') || url.hostname.endsWith('.xhsimg.com'))
      && !/\.(?:avif|gif|heic|heif|jpe?g|png|webp)(?:$|\?)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function videoUrlFromNote(note) {
  if (!note || typeof note !== 'object') return '';
  const queue = [{ value: note, path: '' }];
  const visited = new WeakSet();
  const candidates = [];
  while (queue.length && candidates.length < 30) {
    const { value, path } = queue.shift();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    for (const [key, entry] of Object.entries(value)) {
      const entryPath = `${path}.${key}`;
      if (typeof entry === 'string' && isAllowedVideoUrl(entry)) {
        const url = new URL(entry.replace(/^http:/i, 'https:'));
        const score = (/video/i.test(url.hostname) ? 5 : 0)
          + (/video|stream|h264|h265|avc|hevc|master|originVideo/i.test(entryPath) ? 4 : 0)
          + (/masterUrl|master_url|backupUrls|url/i.test(key) ? 2 : 0)
          - (/cover|image|avatar/i.test(entryPath) ? 6 : 0);
        if (score >= 4) candidates.push({ url: url.toString(), score });
      } else if (entry && typeof entry === 'object') {
        queue.push({ value: entry, path: entryPath });
      }
    }
  }
  return candidates.sort((a, b) => b.score - a.score)[0]?.url || '';
}

function looksLikeNote(value, noteId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidateId = firstString(value, ['noteId', 'note_id', 'id']).toLowerCase();
  if (candidateId !== noteId.toLowerCase()) return false;
  return Boolean(
    firstString(value, ['title', 'displayTitle', 'desc', 'description', 'content'])
    || imageUrlsFromNote(value).length,
  );
}

function findNote(root, noteId) {
  if (!root || typeof root !== 'object') return null;
  const directCandidates = [
    root?.noteDetailMap?.[noteId]?.note,
    root?.noteDetailMap?.[noteId],
    root?.noteData?.data?.noteData,
    root?.noteData?.note,
  ];
  const direct = directCandidates.find((value) => looksLikeNote(value, noteId));
  if (direct) return direct;

  const queue = [{ value: root, depth: 0 }];
  const visited = new WeakSet();
  let inspected = 0;
  while (queue.length && inspected < 20_000) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    inspected += 1;
    if (looksLikeNote(value, noteId)) return value;
    if (depth >= 8) continue;

    let entries;
    try {
      entries = Array.isArray(value) ? value : Object.values(value);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry && typeof entry === 'object') queue.push({ value: entry, depth: depth + 1 });
    }
  }
  return null;
}

function extractInitialState(html) {
  const marker = 'window.__INITIAL_STATE__=';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const valueStart = start + marker.length;
  const valueEnd = html.indexOf('</script>', valueStart);
  if (valueEnd === -1) return null;
  const serialized = html.slice(valueStart, valueEnd).trim().replace(/;$/, '');

  try {
    return JSON.parse(serialized);
  } catch {
    try {
      return JSON.parse(serialized.replace(/\bundefined\b/g, 'null'));
    } catch {
      return null;
    }
  }
}

function tagsFromNote(note) {
  const tags = [];
  for (const key of ['tagList', 'tags', 'topicList']) {
    const values = note?.[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const tag = typeof value === 'string'
        ? value
        : firstString(value, ['name', 'title', 'tagName', 'topicName']);
      if (tag) tags.push(tag.replace(/^#/, ''));
    }
  }
  return Array.from(new Set(tags)).slice(0, 20);
}

function notePayloadFromHtml(html, noteId, sourceUrl) {
  const state = extractInitialState(html);
  const noteRoot = state?.note || state?.noteData || null;
  const note = findNote(noteRoot, noteId);
  if (!note) {
    // 小红书对匿名访问的详情页，缺少 xsec_token 时返回 404「页面不见了」或空 noteDetailMap。
    const looksBlocked = /页面不见了|暂时无法浏览|sec_/i.test(html) || html.includes('"noteDetailMap":{}');
    if (looksBlocked) {
      throw new Error('小红书需要登录才能查看此笔记。请在浏览器打开小红书并登录，然后用以下任一方式导入：\n1. 打开笔记详情页，拖动右下角「拖到 Kanbox」按钮\n2. 在搜索结果页直接拖动笔记卡片到 Kanbox\n3. 复制 App 分享链接粘贴到 Kanbox');
    }
    throw new Error('匿名解析没有读到完整笔记内容。请打开笔记详情页，拖动右下角「拖到 Kanbox」按钮直接收藏');
  }

  const user = note.user || note.author || {};
  const imageUrls = imageUrlsFromNote(note);
  const title = firstString(note, ['title', 'displayTitle']);
  const content = firstString(note, ['desc', 'description', 'content']);
  const videoUrl = videoUrlFromNote(note);
  if (!title && !content && imageUrls.length === 0) {
    throw new Error('匿名解析返回的笔记内容为空');
  }

  return {
    id: noteId,
    sourceUrl,
    title,
    content,
    imageUrls,
    coverUrl: imageUrls[0] || '',
    videoUrl,
    author: {
      name: firstString(user, ['nickname', 'name', 'nickName']),
      avatar: firstString(user, ['avatar', 'image']),
      userId: firstString(user, ['userId', 'user_id', 'id']),
    },
    tags: tagsFromNote(note),
    type: note.type === 'video' || note.video ? 'video' : 'normal',
  };
}

async function fetchAnonymousPage(sourceUrl, fetchImpl) {
  let currentUrl = assertAllowedPageUrl(sourceUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'User-Agent': 'KanboxFavorites/0.1 anonymous-local-resolver',
      },
    });

    if (response.status >= 300 && response.status < 400) {
      if (redirectCount >= MAX_REDIRECTS) throw new Error('匿名解析重定向次数过多');
      const location = response.headers.get('location');
      if (!location) throw new Error('匿名解析重定向缺少目标地址');
      currentUrl = assertAllowedPageUrl(new URL(location, currentUrl).toString());
      continue;
    }
    if (!response.ok) throw new Error(`匿名解析请求失败：${response.status}`);

    const declaredLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
    if (declaredLength > MAX_HTML_BYTES) throw new Error('匿名解析页面过大');
    const html = await response.text();
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error('匿名解析页面过大');
    return html;
  }

  throw new Error('匿名解析失败');
}

export async function resolveAnonymousNote(sourceUrl, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;

  // 小红书短链（xhslink.com）需要先展开：跟随重定向拿到真实笔记页 URL。
  // 展开后的 URL 通常自带 xsec_token，详情页匿名访问必须带该参数，否则 302→404。
  let pageUrl = sourceUrl;
  if (isShortLink(sourceUrl)) {
    pageUrl = await expandShortLink(sourceUrl, fetchImpl);
  }

  const url = assertAllowedPageUrl(pageUrl);
  const noteId = options.expectedNoteId || [
    /^\/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})(?:\/|$)/i,
    /^\/user\/profile\/[0-9a-f]{24}\/([0-9a-f]{24})(?:\/|$)/i,
  ].map((pattern) => url.pathname.match(pattern)?.[1] || '').find(Boolean);
  if (!noteId || !/^[0-9a-f]{24}$/i.test(noteId)) {
    throw new Error('匿名解析器没有识别到笔记 ID');
  }

  const html = await fetchAnonymousPage(url.toString(), fetchImpl);
  return notePayloadFromHtml(html, noteId.toLowerCase(), url.toString());
}

function isShortLink(value) {
  try {
    return SHORT_LINK_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function expandShortLink(shortUrl, fetchImpl) {
  const response = await fetchImpl(shortUrl, {
    method: 'GET',
    redirect: 'manual',
    credentials: 'omit',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'KanboxFavorites/0.1 anonymous-local-resolver',
    },
  });

  const location = response.headers.get('location');
  if (response.status >= 300 && response.status < 400 && location) {
    return new URL(location, shortUrl).toString();
  }
  if (response.ok) {
    // 某些短链直接返回 HTML，尝试从内容里解析真实链接
    const html = await response.text();
    const canonical = html.match(/https?:\/\/[^\s"'<>]+xiaohongshu\.com[^\s"'<>]*/i)?.[0];
    if (canonical) return canonical;
  }
  throw new Error('短链展开失败，无法获取真实笔记地址');
}
