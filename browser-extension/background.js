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
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'kanbox-save-link') {
    const url = info.linkUrl;
    const match = url.match(/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})/i);
    if (!match) return;

    const noteId = match[1];

    if (tab?.id) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: 'CAPTURE_NOTE_BY_URL',
          url: url,
        });
        if (response?.ok) {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon-48.png',
            title: 'Kanbox',
            message: '笔记已收藏',
          });
        }
      } catch {
        await importNoteById(noteId, url);
      }
    }
  }

  if (info.menuItemId === 'kanbox-save-bilibili' || info.menuItemId === 'kanbox-save-weibo') {
    const url = info.linkUrl || info.pageUrl;

    if (tab?.id) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: 'SAVE_CURRENT_NOTE',
        });
        if (response?.ok) {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon-48.png',
            title: 'Kanbox',
            message: '内容已收藏',
          });
        }
      } catch {
        console.error('Failed to save via context menu');
      }
    }
  }
});

async function importNoteById(noteId, sourceUrl) {
  try {
    await importNote({
      id: noteId,
      sourceUrl: sourceUrl,
      title: '来自右键收藏',
      content: '',
      imageUrls: [],
      type: 'normal',
    });
  } catch (error) {
    console.error('Failed to import:', error);
  }
}

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
