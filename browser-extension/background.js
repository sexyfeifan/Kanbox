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

// 发送原始 URL/文本，让后端走完整匿名解析链路（补全正文、配图、视频、分类）
async function importNoteRaw(input) {
  const response = await fetch(LOCAL_IMPORT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
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

});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info) => {
  let noteData = null;

  if (info.menuItemId === 'kanbox-save-link') {
    const url = info.linkUrl;
    if (!url) return;
    const match = url.match(/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})/i);
    if (!match) return;
    // 发送 URL 让后端走匿名解析链路（补全正文、配图、分类），而非保存空壳笔记
    try {
      await importNoteRaw(url);
      return;
    } catch {
      // 降级：至少保存链接
    }
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
