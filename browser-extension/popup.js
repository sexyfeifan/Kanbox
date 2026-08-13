const API_BASE = 'http://127.0.0.1:4318';

async function checkConnection() {
  try {
    const response = await fetch(`${API_BASE}/health`, {
      signal: AbortSignal.timeout(3000)
    });
    const data = await response.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

async function getNotes() {
  try {
    const response = await fetch(`${API_BASE}/notes`, {
      signal: AbortSignal.timeout(5000)
    });
    const data = await response.json();
    return data.notes || [];
  } catch {
    return [];
  }
}

async function getCurrentTabNoteId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  const match = tab.url.match(/xiaohongshu\.com\/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})/i);
  return match?.[1] || null;
}

async function saveCurrentNote() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const btn = document.getElementById('saveCurrentBtn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px;"></div> 收藏中...';

  try {
    // Send message to content script to capture and save
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'SAVE_CURRENT_NOTE' });
    if (response?.ok) {
      btn.innerHTML = '✓ 已收藏';
      btn.style.background = '#6E9478';
      setTimeout(() => {
        btn.innerHTML = '收藏当前笔记';
        btn.style.background = '#829987';
        btn.disabled = false;
        loadStats();
      }, 2000);
    } else {
      throw new Error(response?.error || '收藏失败');
    }
  } catch (error) {
    btn.innerHTML = error.message || '收藏失败';
    btn.style.background = '#B56A5B';
    setTimeout(() => {
      btn.innerHTML = '收藏当前笔记';
      btn.style.background = '#829987';
      btn.disabled = false;
    }, 2000);
  }
}

function formatTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 7) return `${days}天前`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

async function loadStats() {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const statsContainer = document.getElementById('statsContainer');
  const recentContainer = document.getElementById('recentContainer');

  // Check connection
  const connected = await checkConnection();
  if (!connected) {
    statusDot.className = 'status-dot error';
    statusText.textContent = '未连接 Kanbox';
    statsContainer.style.display = 'none';
    recentContainer.style.display = 'none';
    return;
  }

  statusDot.className = 'status-dot connected';
  statusText.textContent = '已连接';

  // Load notes
  const notes = await getNotes();

  // Update stats
  statsContainer.style.display = 'flex';
  document.getElementById('totalCount').textContent = notes.length;

  const today = new Date().toDateString();
  const todayNotes = notes.filter(n => new Date(n.savedAt).toDateString() === today);
  document.getElementById('todayCount').textContent = todayNotes.length;

  // Show recent notes
  if (notes.length > 0) {
    recentContainer.style.display = 'block';
    const recent = notes.slice(0, 3);
    const recentList = document.getElementById('recentList');
    recentList.innerHTML = recent.map(note => `
      <div class="recent-item">
        ${note.coverUrl
          ? `<img class="recent-thumb" src="${note.coverUrl}" alt="" />`
          : `<div class="recent-thumb" style="background: linear-gradient(135deg, #82998722, #82998744);"></div>`
        }
        <div class="recent-info">
          <div class="recent-name">${note.title || '未命名笔记'}</div>
          <div class="recent-time">${formatTime(note.savedAt)}</div>
        </div>
      </div>
    `).join('');
  }

  // Check if current page is a note
  const noteId = await getCurrentTabNoteId();
  const saveBtn = document.getElementById('saveCurrentBtn');
  if (noteId) {
    saveBtn.disabled = false;
    // Check if already saved
    const saved = notes.some(n => n.id === noteId);
    if (saved) {
      saveBtn.innerHTML = '✓ 已收藏过';
      saveBtn.style.background = '#6E9478';
      saveBtn.disabled = true;
    }
  } else {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '请先打开笔记页面';
  }
}

// Event listeners
document.getElementById('saveCurrentBtn').addEventListener('click', saveCurrentNote);
document.getElementById('openAppBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://localhost:3000' });
});

// Initialize
loadStats();
