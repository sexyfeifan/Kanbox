const BUTTON_ID = 'kanbox-note-import-button';
const PAYLOAD_PREFIX = 'KANBOX_NOTE:';
const CARD_PAYLOAD_PREFIX = 'KANBOX_CARD:';
const PAGE_DATA_SOURCE = 'kanbox-note-page-data';
const PAGE_DATA_REQUEST_EVENT = 'kanbox-note-capture-request';
let cachedPageData = null;
let requestedNoteId = '';
let savedNoteIds = new Set();
// 由 page-data.js（MAIN world）通过 postMessage 桥接过来的 xsec_token 映射。
// 不能在这里直接读 window.__INITIAL_STATE__（ISOLATED world 读不到页面主世界的全局变量）。
let xsecTokenMap = {};

// Platform detection
function detectPlatform() {
  const host = location.hostname;
  if (host.includes('xiaohongshu.com') || host.includes('xhslink.com')) return 'xiaohongshu';
  if (host.includes('bilibili.com')) return 'bilibili';
  if (host.includes('weibo.com') || host.includes('weibo.cn')) return 'weibo';
  if (host.includes('douyin.com')) return 'douyin';
  if (host.includes('zhihu.com')) return 'zhihu';
  if (host.includes('kuaishou.com') || host.includes('gifshow.com')) return 'kuaishou';
  if (host.includes('toutiao.com') || host.includes('toutiaocdn.com')) return 'toutiao';
  return 'unknown';
}

const PLATFORM = detectPlatform();

async function checkAndMarkSavedNotes() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_SAVED_IDS' });
    if (response?.ok && Array.isArray(response.ids)) {
      savedNoteIds = new Set(response.ids);
      markSavedNotesOnPage();
    }
  } catch {
    // Ignore errors - extension might not be ready
  }
}

function markSavedNotesOnPage() {
  // Remove existing marks
  document.querySelectorAll('.kanbox-saved-mark').forEach(el => el.remove());

  // Find all note links and mark saved ones
  document.querySelectorAll('a[href*="/explore/"], a[href*="/search_result/"], a[href*="/discovery/item/"]').forEach(link => {
    const href = link.getAttribute('href');
    const match = href?.match(/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})/i);
    if (!match) return;

    const noteId = match[1];
    if (!savedNoteIds.has(noteId)) return;

    // Find the card container
    const card = link.closest('section, [class*="note-item"], [class*="feed-item"], [class*="note-card"]')
      || link.parentElement?.parentElement?.parentElement;
    if (!card) return;

    // Don't add duplicate marks
    if (card.querySelector('.kanbox-saved-mark')) return;

    // Add saved mark
    const mark = document.createElement('div');
    mark.className = 'kanbox-saved-mark';
    mark.innerHTML = '✓';
    Object.assign(mark.style, {
      position: 'absolute',
      top: '8px',
      right: '8px',
      width: '24px',
      height: '24px',
      borderRadius: '50%',
      background: '#829987',
      color: '#fff',
      fontSize: '12px',
      fontWeight: '700',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '10',
      boxShadow: '0 2px 8px rgba(130,153,135,0.4)',
      pointerEvents: 'none',
    });

    // Make card position relative if needed
    const position = getComputedStyle(card).position;
    if (position === 'static') {
      card.style.position = 'relative';
    }
    card.appendChild(mark);
  });
}

// Call checkAndMarkSavedNotes periodically and on page load
checkAndMarkSavedNotes();
setInterval(checkAndMarkSavedNotes, 30000); // Check every 30 seconds

function getNoteId() {
  if (PLATFORM === 'xiaohongshu') {
    return location.pathname.match(/^\/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})(?:\/|$)/i)?.[1] || '';
  }
  if (PLATFORM === 'bilibili') {
    // Bilibili note/video ID from URL
    return location.pathname.match(/^\/(?:video|read|opus)\/(?:av|BV|cv)?([a-zA-Z0-9]+)/i)?.[1] || '';
  }
  if (PLATFORM === 'weibo') {
    // Weibo post ID
    return location.pathname.match(/^\/\d+\/([a-zA-Z0-9]+)/i)?.[1]
      || location.pathname.match(/^\/detail\/([a-zA-Z0-9]+)/i)?.[1] || '';
  }
  if (PLATFORM === 'douyin') {
    return location.pathname.match(/\/video\/(\d+)/i)?.[1]
      || location.pathname.match(/\/note\/(\d+)/i)?.[1] || '';
  }
  if (PLATFORM === 'zhihu') {
    return location.pathname.match(/\/(?:p|answer)\/(\d+)/i)?.[1] || '';
  }
  if (PLATFORM === 'kuaishou') {
    return location.pathname.match(/\/short-video\/([a-zA-Z0-9]+)/i)?.[1]
      || location.pathname.match(/\/photo\/([a-zA-Z0-9]+)/i)?.[1] || '';
  }
  if (PLATFORM === 'toutiao') {
    return location.pathname.match(/\/article\/(\d+)/i)?.[1]
      || location.pathname.match(/\/video\/(\d+)/i)?.[1] || '';
  }
  return '';
}

function noteCardFromDragTarget(target) {
  if (!(target instanceof Element) || target.closest(`#${BUTTON_ID}`)) return null;
  const link = target.closest('a[href*="/explore/"], a[href*="/search_result/"], a[href*="/discovery/item/"]');
  if (!link) return null;

  try {
    const sourceUrl = new URL(link.getAttribute('href'), location.href);
    if (!['www.xiaohongshu.com', 'm.xiaohongshu.com'].includes(sourceUrl.hostname)) return null;
    const id = sourceUrl.pathname.match(/^\/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})(?:\/|$)/i)?.[1];
    if (!id) return null;

    // 从页面 __INITIAL_STATE__ 提取该笔记的 xsec_token。
    // 小红书 2026 起详情页必须带 xsec_token 才能匿名访问，否则 302→404。
    const xsecToken = findXsecTokenById(id);
    if (xsecToken) sourceUrl.searchParams.set('xsec_token', xsecToken);

    const card = link.closest('section, [class*="note-item"], [class*="feed-item"], [class*="note-card"]')
      || link.parentElement?.parentElement?.parentElement;
    const title = card?.querySelector('[class*="title"]')?.textContent?.trim()
      || (link.textContent || '').trim()
      || '这条笔记';

    return { id, sourceUrl: sourceUrl.toString(), title, xsecToken: xsecToken || '' };
  } catch {
    return null;
  }
}

// 从 page-data.js（MAIN world）桥接过来的 token map 里按 noteId 找 xsecToken。
// 不能在这里直接读 window.__INITIAL_STATE__：content.js 运行在 ISOLATED world，
// 读不到页面 MAIN world 设置的该全局变量（这是上一版 token 永远提取不到的根因）。
function findXsecTokenById(noteId) {
  if (!noteId) return '';
  const token = xsecTokenMap[String(noteId).toLowerCase()];
  return typeof token === 'string' ? token : '';
}

function firstText(selectors) {
  for (const selector of selectors) {
    const value = document.querySelector(selector)?.textContent?.trim();
    if (value) return value;
  }
  return '';
}

function metaContent(property) {
  return document.querySelector(`meta[property="${property}"]`)?.content?.trim()
    || document.querySelector(`meta[name="${property}"]`)?.content?.trim()
    || '';
}

function bestSrcsetUrl(value) {
  if (typeof value !== 'string') return '';
  const candidates = value.split(',').map((candidate) => {
    const [url, descriptor = '0w'] = candidate.trim().split(/\s+/);
    return { url, size: Number.parseFloat(descriptor) || 0 };
  });
  return candidates.sort((a, b) => b.size - a.size)[0]?.url || '';
}

function imageUrlFromElement(image) {
  return bestSrcsetUrl(image.getAttribute('srcset'))
    || bestSrcsetUrl(image.parentElement?.querySelector('source')?.getAttribute('srcset'))
    || image.currentSrc
    || image.getAttribute('data-src')
    || image.src
    || '';
}

function isNoteImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && (url.hostname.endsWith('.xhscdn.com') || url.hostname.endsWith('.xhsimg.com'));
  } catch {
    return false;
  }
}

function normalizeNoteImageUrl(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/^http:/i, 'https:');
  return isNoteImageUrl(normalized) ? normalized : '';
}

function collectImages() {
  const urls = new Set(
    Array.isArray(cachedPageData?.imageUrls)
      ? cachedPageData.imageUrls.map(normalizeNoteImageUrl).filter(Boolean)
      : [],
  );
  const metaImage = metaContent('og:image');
  const normalizedMetaImage = normalizeNoteImageUrl(metaImage);
  if (normalizedMetaImage) urls.add(normalizedMetaImage);

  document.querySelectorAll('.note-content img, .swiper-slide img, [class*="note-content"] img, [class*="carousel"] img').forEach((image) => {
    const url = normalizeNoteImageUrl(imageUrlFromElement(image));
    if (url) urls.add(url);
  });

  return Array.from(urls).slice(0, 20);
}

function collectVideoUrl() {
  const candidates = [];
  const addCandidate = (value, context, baseScore = 0) => {
    const url = normalizeNoteVideoUrl(value);
    if (!url) return;
    const parsed = new URL(url);
    const score = baseScore
      + (/video/i.test(parsed.hostname) ? 6 : 0)
      + (/video|media|stream|h264|h265|avc|hevc|master|originVideo/i.test(context) ? 5 : 0)
      + (/video|stream/i.test(parsed.pathname) ? 2 : 0)
      - (/webpic|image|avatar|cover/i.test(`${parsed.hostname} ${context}`) ? 8 : 0);
    if (score >= 5) candidates.push({ url, score });
  };

  addCandidate(cachedPageData?.videoUrl, 'cached video state', 20);
  document.querySelectorAll('video, video source').forEach((node) => {
    addCandidate(node.currentSrc, 'video currentSrc', 15);
    for (const attribute of ['src', 'data-src', 'data-url', 'data-video-src']) {
      addCandidate(node.getAttribute(attribute), `video ${attribute}`, 12);
    }
  });
  addCandidate(metaContent('og:video'), 'og video', 10);
  addCandidate(metaContent('og:video:url'), 'og video url', 10);

  performance.getEntriesByType('resource').forEach((entry) => {
    addCandidate(entry.name, `${entry.initiatorType || ''} performance resource`, entry.initiatorType === 'video' ? 12 : 0);
  });

  document.querySelectorAll('script').forEach((script) => {
    const text = script.textContent || '';
    if (!/xhs(?:cdn|img)\.com/i.test(text) || text.length > 12 * 1024 * 1024) return;
    const matches = text.matchAll(/https?(?::|%3A)(?:(?:\\u002[fF]|\\\/|\/)){2}[^"'\s<]+/g);
    for (const match of matches) {
      const decoded = match[0]
        .replace(/%3A/gi, ':')
        .replace(/\\u002[fF]/g, '/')
        .replace(/\\u0026/gi, '&')
        .replace(/\\u003[dD]/g, '=')
        .replace(/\\\//g, '/');
      addCandidate(decoded, 'embedded video stream');
    }
  });

  return candidates.sort((a, b) => b.score - a.score)[0]?.url || '';
}

function normalizeNoteVideoUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value.replace(/^http:/i, 'https:'));
    return url.protocol === 'https:'
      && (url.hostname.endsWith('.xhscdn.com') || url.hostname.endsWith('.xhsimg.com'))
      && !/\.(?:avif|gif|heic|heif|jpe?g|png|webp)(?:$|\?)/i.test(url.pathname)
      ? url.toString()
      : '';
  } catch {
    return '';
  }
}

function collectTags() {
  const tags = new Set();
  document.querySelectorAll('#detail-desc a, .desc a, [class*="desc"] a').forEach((node) => {
    const value = node.textContent?.trim().replace(/^#/, '');
    if (value && value.length <= 40) tags.add(value);
  });
  return Array.from(tags).slice(0, 20);
}

function captureBilibiliNote(id) {
  const title = document.querySelector('.video-title, h1, [class*="title"]')?.textContent?.trim() || document.title;
  const content = document.querySelector('.desc-info-text, .basic-desc-info, [class*="desc"]')?.textContent?.trim() || '';
  const author = document.querySelector('.up-name, [class*="author"]')?.textContent?.trim() || '未知作者';
  const coverUrl = document.querySelector('meta[property="og:image"]')?.content
    || document.querySelector('.pic-cover img, video')?.poster || '';

  return {
    id: `bili_${id}`,
    sourceUrl: location.href,
    title,
    content,
    imageUrls: coverUrl ? [coverUrl] : [],
    coverUrl,
    videoUrl: '',
    author: { name: author, avatar: '', userId: '' },
    tags: [],
    type: 'normal',
  };
}

function captureWeiboNote(id) {
  const title = document.querySelector('.weibo-text, [class*="content"]')?.textContent?.trim()?.slice(0, 100) || document.title;
  const content = document.querySelector('.weibo-text, [class*="content"]')?.textContent?.trim() || '';
  const author = document.querySelector('.name, [class*="author"]')?.textContent?.trim() || '未知作者';
  const images = Array.from(document.querySelectorAll('.weibo-media img, [class*="pic"] img'))
    .map(img => img.src)
    .filter(src => src && !src.includes('avatar'));

  return {
    id: `weibo_${id}`,
    sourceUrl: location.href,
    title: title.slice(0, 100),
    content,
    imageUrls: images.slice(0, 9),
    coverUrl: images[0] || '',
    videoUrl: '',
    author: { name: author, avatar: '', userId: '' },
    tags: [],
    type: 'normal',
  };
}

function captureDouyinNote(id) {
  const title = document.querySelector('[class*="title"], h1')?.textContent?.trim() || document.title;
  const content = document.querySelector('[class*="desc"], [class*="content"]')?.textContent?.trim() || '';
  const author = document.querySelector('[class*="author"], [class*="nickname"]')?.textContent?.trim() || '未知作者';
  const video = document.querySelector('video');
  return {
    id: `dy_${id}`,
    sourceUrl: location.href,
    title: title.slice(0, 100),
    content,
    imageUrls: [],
    coverUrl: video?.poster || '',
    videoUrl: video?.src || '',
    author: { name: author, avatar: '', userId: '' },
    tags: [],
    type: video ? 'video' : 'normal',
  };
}

function captureZhihuNote(id) {
  const title = document.querySelector('.Post-Title, .ContentItem-title, h1')?.textContent?.trim() || document.title;
  const content = document.querySelector('.Post-RichText, .RichContent-inner, .AnswerItem-content')?.textContent?.trim() || '';
  const author = document.querySelector('.AuthorInfo-name, .UserLink-link')?.textContent?.trim() || '未知作者';
  const images = Array.from(document.querySelectorAll('.Post-RichText img, .RichContent img'))
    .map(img => img.src)
    .filter(src => src && !src.includes('avatar') && !src.includes('equation'));
  return {
    id: `zhihu_${id}`,
    sourceUrl: location.href,
    title: title.slice(0, 100),
    content: content.slice(0, 5000),
    imageUrls: images.slice(0, 20),
    coverUrl: images[0] || '',
    videoUrl: '',
    author: { name: author, avatar: '', userId: '' },
    tags: [],
    type: 'normal',
  };
}

function captureKuaishouNote(id) {
  const title = document.querySelector('[class*="title"], [class*="caption"], h1')?.textContent?.trim() || document.title;
  const content = document.querySelector('[class*="desc"], [class*="content"]')?.textContent?.trim() || '';
  const author = document.querySelector('[class*="author"], [class*="name"]')?.textContent?.trim() || '未知作者';
  const video = document.querySelector('video');
  return {
    id: `ks_${id}`,
    sourceUrl: location.href,
    title: title.slice(0, 100),
    content,
    imageUrls: [],
    coverUrl: video?.poster || '',
    videoUrl: video?.src || '',
    author: { name: author, avatar: '', userId: '' },
    tags: [],
    type: video ? 'video' : 'normal',
  };
}

function captureToutiaoNote(id) {
  const title = document.querySelector('.article-title, [class*="title"], h1')?.textContent?.trim() || document.title;
  const content = document.querySelector('.article-content, [class*="content"], .tt-article-content')?.textContent?.trim() || '';
  const author = document.querySelector('.author-name, [class*="author"]')?.textContent?.trim() || '未知作者';
  const images = Array.from(document.querySelectorAll('.article-content img, [class*="content"] img'))
    .map(img => img.src || img.dataset.src)
    .filter(src => src && !src.includes('avatar'));
  const video = document.querySelector('video');
  return {
    id: `tt_${id}`,
    sourceUrl: location.href,
    title: title.slice(0, 100),
    content: content.slice(0, 5000),
    imageUrls: images.slice(0, 20),
    coverUrl: images[0] || video?.poster || '',
    videoUrl: video?.src || '',
    author: { name: author, avatar: '', userId: '' },
    tags: [],
    type: video ? 'video' : 'normal',
  };
}

function captureCurrentNote() {
  const id = getNoteId();
  if (!id) throw new Error('请先打开一个可收藏的页面');

  if (PLATFORM === 'bilibili') {
    return captureBilibiliNote(id);
  }
  if (PLATFORM === 'weibo') {
    return captureWeiboNote(id);
  }
  if (PLATFORM === 'douyin') {
    return captureDouyinNote(id);
  }
  if (PLATFORM === 'zhihu') {
    return captureZhihuNote(id);
  }
  if (PLATFORM === 'kuaishou') return captureKuaishouNote(id);
  if (PLATFORM === 'toutiao') return captureToutiaoNote(id);

  const title = cachedPageData?.title
    || firstText(['#detail-title', '.note-content .title', '[class*="note"] [class*="title"]'])
    || metaContent('og:title').replace(/\s*[-|_].*小红书.*$/i, '')
    || document.title.replace(/\s*[-|_].*小红书.*$/i, '');
  const content = cachedPageData?.content
    || firstText(['#detail-desc', '.note-content .desc', '[class*="note"] [class*="desc"]'])
    || metaContent('description')
    || metaContent('og:description');
  const imageUrls = collectImages();
  const videoUrl = collectVideoUrl();
  const type = cachedPageData?.type === 'video' || document.querySelector('video') ? 'video' : 'normal';
  if (type === 'video' && !videoUrl) {
    throw new Error('没有读取到视频，请先播放几秒再试');
  }

  return {
    id,
    sourceUrl: location.href,
    title,
    content,
    imageUrls,
    coverUrl: imageUrls[0] || '',
    videoUrl,
    author: {
      name: cachedPageData?.author?.name
        || firstText(['.author-wrapper .username', '.author-wrapper [class*="name"]', '[class*="author"] .username']),
      avatar: cachedPageData?.author?.avatar
        || document.querySelector('.author-wrapper img, [class*="author"] img')?.src
        || '',
      userId: cachedPageData?.author?.userId || '',
    },
    tags: collectTags(),
    type,
  };
}

function setButtonState(button, label, tone) {
  button.textContent = label;
  button.style.background = tone;
}

function installButton() {
  const existing = document.getElementById(BUTTON_ID);
  if (!getNoteId()) {
    existing?.remove();
    return;
  }
  if (existing) return;

  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.type = 'button';
  button.draggable = true;

  const labelText = PLATFORM === 'xiaohongshu' ? '拖到「Kanbox」' : '收藏到 Kanbox';

  button.textContent = labelText;
  button.title = '点击或拖拽收藏当前内容到 Kanbox';
  Object.assign(button.style, {
    position: 'fixed',
    right: '24px',
    bottom: '24px',
    zIndex: '2147483647',
    height: '42px',
    padding: '0 18px',
    border: '1px solid rgba(255,255,255,0.55)',
    borderRadius: '999px',
    background: '#829987',
    color: '#fff',
    boxShadow: '0 10px 30px rgba(42,50,44,0.28)',
    font: '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    cursor: 'grab',
  });

  button.addEventListener('dragstart', (event) => {
    try {
      const note = captureCurrentNote();
      const payload = `${PAYLOAD_PREFIX}${JSON.stringify(note)}`;
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('application/x-kanbox-note', payload);
      event.dataTransfer.setData('text/plain', payload);
      event.dataTransfer.setData('text/uri-list', note.sourceUrl);
    } catch (error) {
      event.preventDefault();
      setButtonState(button, error instanceof Error ? error.message : '读取失败', '#B56A5B');
    }
  });

  button.addEventListener('pointerenter', () => {
    document.dispatchEvent(new CustomEvent(PAGE_DATA_REQUEST_EVENT));
  });

  button.addEventListener('click', () => {
    let note;
    try {
      note = captureCurrentNote();
    } catch (error) {
      setButtonState(button, error instanceof Error ? error.message : '读取失败', '#B56A5B');
      return;
    }

    setButtonState(button, '正在收藏…', '#9AA99D');
    chrome.runtime.sendMessage({ type: 'IMPORT_NOTE', note }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        setButtonState(button, response?.error || '请先打开Kanbox', '#B56A5B');
      } else {
        setButtonState(button, response.created ? 'Saved ✓' : 'Updated ✓', '#6E9478');
      }
      setTimeout(() => {
        const resetLabel = PLATFORM === 'xiaohongshu' ? '拖到「Kanbox」' : '收藏到 Kanbox';
        setButtonState(button, resetLabel, '#829987');
      }, 2200);
    });
  });

  document.documentElement.appendChild(button);
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.source !== PAGE_DATA_SOURCE) return;
  if (event.data.payload?.id === getNoteId()) {
    cachedPageData = event.data.payload;
  }
  if (event.data?.xsecTokens && typeof event.data.xsecTokens === 'object') {
    xsecTokenMap = event.data.xsecTokens;
  }
});

// Handle messages from popup and other extension pages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'SAVE_CURRENT_NOTE') {
    try {
      const note = captureCurrentNote();
      chrome.runtime.sendMessage({ type: 'IMPORT_NOTE', note }, (response) => {
        sendResponse(response);
      });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : '读取失败',
      });
    }
    return true;
  }

  if (message?.type === 'GET_NOTE_ID') {
    sendResponse({ ok: true, noteId: getNoteId() });
    return false;
  }
});

document.addEventListener('dragstart', (event) => {
  const card = noteCardFromDragTarget(event.target);
  if (!card || !event.dataTransfer) return;

  const payload = `${CARD_PAYLOAD_PREFIX}${JSON.stringify(card)}`;
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData('application/x-kanbox-card', payload);
  event.dataTransfer.setData('text/plain', payload);
  event.dataTransfer.setData('text/uri-list', card.sourceUrl);
}, true);

installButton();
document.dispatchEvent(new CustomEvent(PAGE_DATA_REQUEST_EVENT));
setInterval(() => {
  installButton();
  const noteId = getNoteId();
  if (noteId && noteId !== requestedNoteId) {
    requestedNoteId = noteId;
    document.dispatchEvent(new CustomEvent(PAGE_DATA_REQUEST_EVENT));
  } else if (!noteId) {
    requestedNoteId = '';
    cachedPageData = null;
  }
}, 1000);
