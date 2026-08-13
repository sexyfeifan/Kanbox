const LOCAL_IMPORT_URL = 'http://127.0.0.1:4318/notes/import';
const LOCAL_NOTES_URL = 'http://127.0.0.1:4318/notes';

async function importNote(note) {
  const response = await fetch(LOCAL_IMPORT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '本地导入失败');
  return payload;
}

async function getSavedNoteIds() {
  try {
    const response = await fetch(LOCAL_NOTES_URL, {
      signal: AbortSignal.timeout(3000),
    });
    const data = await response.json();
    return (data.notes || []).map(n => n.id);
  } catch {
    return [];
  }
}

// Create context menus when extension is installed
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'kanbox-save-link',
    title: '收藏到 Kanbox',
    contexts: ['link'],
    targetUrlPatterns: [
      '*://*.xiaohongshu.com/explore/*',
      '*://*.xiaohongshu.com/search_result/*',
      '*://*.xiaohongshu.com/discovery/item/*',
      '*://*.xiaohongshu.com/explore/*',
      '*://*.xiaohongshu.com/search_result/*',
      '*://*.xiaohongshu.com/discovery/item/*',
    ],
  });

  chrome.contextMenus.create({
    id: 'kanbox-save-image',
    title: '收藏图片到 Kanbox',
    contexts: ['image'],
    targetUrlPatterns: [
      '*://*.xhscdn.com/*',
      '*://*.xhsimg.com/*',
    ],
  });

  // Bilibili
  chrome.contextMenus.create({
    id: 'kanbox-save-bilibili',
    title: '收藏到 Kanbox',
    contexts: ['link', 'page'],
    documentUrlPatterns: ['*://*.bilibili.com/*'],
  });

  // Weibo
  chrome.contextMenus.create({
    id: 'kanbox-save-weibo',
    title: '收藏到 Kanbox',
    contexts: ['link', 'page'],
    documentUrlPatterns: ['*://*.weibo.com/*', '*://*.weibo.cn/*'],
  });

  // Douyin
  chrome.contextMenus.create({
    id: 'kanbox-save-douyin',
    title: '收藏到 Kanbox',
    contexts: ['link', 'page'],
    documentUrlPatterns: ['*://*.douyin.com/*'],
  });

  // Zhihu
  chrome.contextMenus.create({
    id: 'kanbox-save-zhihu',
    title: '收藏到 Kanbox',
    contexts: ['link', 'page'],
    documentUrlPatterns: ['*://*.zhihu.com/*'],
  });

  // Kuaishou
  chrome.contextMenus.create({
    id: 'kanbox-save-kuaishou',
    title: '收藏到 Kanbox',
    contexts: ['link', 'page'],
    documentUrlPatterns: ['*://*.kuaishou.com/*', '*://*.gifshow.com/*'],
  });

  // Toutiao
  chrome.contextMenus.create({
    id: 'kanbox-save-toutiao',
    title: '收藏到 Kanbox',
    contexts: ['link', 'page'],
    documentUrlPatterns: ['*://*.toutiao.com/*'],
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info) => {
  let noteData = null;

  if (info.menuItemId === 'kanbox-save-link') {
    const url = info.linkUrl;
    if (!url) return;
    const match = url.match(/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})/i);
    if (!match) return;
    noteData = {
      id: match[1],
      sourceUrl: url,
      title: '来自右键收藏',
      content: '',
      imageUrls: [],
      type: 'normal',
    };
  }

  if (info.menuItemId === 'kanbox-save-image') {
    const url = info.srcUrl;
    if (!url) return;
    noteData = {
      id: `img_${Date.now().toString(36)}`,
      sourceUrl: info.pageUrl || url,
      title: '收藏的图片',
      content: '',
      imageUrls: [url],
      coverUrl: url,
      type: 'normal',
    };
  }

  if (info.menuItemId === 'kanbox-save-bilibili' || info.menuItemId === 'kanbox-save-weibo' || info.menuItemId === 'kanbox-save-douyin' || info.menuItemId === 'kanbox-save-zhihu' || info.menuItemId === 'kanbox-save-kuaishou' || info.menuItemId === 'kanbox-save-toutiao') {
    const url = info.linkUrl || info.pageUrl;
    if (!url) return;
    // Extract a simple ID from the URL
    const biliMatch = url.match(/bilibili\.com\/(?:video|read|opus)\/(?:av|BV|cv)?([a-zA-Z0-9]+)/i);
    const weiboMatch = url.match(/weibo\.com\/\d+\/([a-zA-Z0-9]+)/i);
    const douyinMatch = url.match(/douyin\.com\/(?:video|note)\/(\d+)/i);
    const zhihuMatch = url.match(/zhihu\.com\/(?:p|answer)\/(\d+)/i);
    const ksMatch = url.match(/kuaishou\.com\/(?:short-video|photo)\/([a-zA-Z0-9]+)/i);
    const ttMatch = url.match(/toutiao\.com\/(?:article|video)\/(\d+)/i);
    const id = biliMatch?.[1] ? `bili_${biliMatch[1]}` : weiboMatch?.[1] ? `weibo_${weiboMatch[1]}` : douyinMatch?.[1] ? `dy_${douyinMatch[1]}` : zhihuMatch?.[1] ? `zhihu_${zhihuMatch[1]}` : ksMatch?.[1] ? `ks_${ksMatch[1]}` : ttMatch?.[1] ? `tt_${ttMatch[1]}` : `link_${Date.now().toString(36)}`;
    noteData = {
      id,
      sourceUrl: url,
      title: '来自右键收藏',
      content: '',
      imageUrls: [],
      type: 'normal',
    };
  }

  if (noteData) {
    try {
      await importNote(noteData);
    } catch (error) {
      console.error('Context menu import failed:', error);
    }
  }
});

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'IMPORT_NOTE') {
    importNote(message.note)
      .then((payload) => sendResponse({ ok: true, created: payload.created !== false }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : '无法连接Kanbox',
        });
      });
    return true;
  }

  if (message?.type === 'GET_SAVED_IDS') {
    getSavedNoteIds()
      .then(ids => sendResponse({ ok: true, ids }))
      .catch(() => sendResponse({ ok: true, ids: [] }));
    return true;
  }

  return false;
});
