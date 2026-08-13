const LANGUAGES = {
  'zh-CN': {
    appName: 'Kanbox',
    subtitle: (count) => `${count} 条笔记`,
    search: '搜索',
    all: '全部',
    newest: '最新',
    oldest: '最早',
    title: '标题',
    newGroup: '新建分组',
    pasteLink: '粘贴链接',
    settings: '设置',
    tags: '标签',
    plugin: '插件',
    export: '导出',
    dragToSave: '松手收录',
    saved: '已收录',
    processing: '正在处理…',
    error: '错误',
    delete: '删除',
    confirmDelete: '确认删除',
    cancel: '取消',
    rename: '重命名',
    noResults: '没找到相关收藏',
    emptyState: '把一条笔记拖进来',
    emptyHint: '松开后会自动保存图片、识别文字、分析并放进卡片分组',
    viewOriginal: '查看原帖',
    aiSummary: 'AI 摘要',
    imageText: '图片文字',
    videoTranscript: '视频文稿',
    noteContent: '笔记正文',
    dataStats: '数据统计',
    totalNotes: '笔记总数',
    mediaFiles: '媒体文件',
    backups: '备份文件',
    dataDir: '数据目录',
    backupRestore: '备份与恢复',
    createBackup: '创建备份',
    restoreBackup: '从备份恢复',
    integrity: '数据完整性',
    checkIntegrity: '检查数据完整性',
    tagManager: '标签管理',
    noTags: '暂无标签',
    onboardingTitle: '欢迎使用 Kanbox',
    onboardingStep1: '安装 Chrome 扩展',
    onboardingStep2: '打开小红书或其他平台',
    onboardingStep3: '拖拽或点击收藏笔记',
    onboardingSkip: '跳过',
    onboardingNext: '下一步',
    onboardingDone: '开始使用',
  },
  'en': {
    appName: 'Kanbox',
    subtitle: (count) => `${count} notes`,
    search: 'Search',
    all: 'All',
    newest: 'Newest',
    oldest: 'Oldest',
    title: 'Title',
    newGroup: 'New Group',
    pasteLink: 'Paste Link',
    settings: 'Settings',
    tags: 'Tags',
    plugin: 'Plugin',
    export: 'Export',
    dragToSave: 'Drop to save',
    saved: 'Saved',
    processing: 'Processing…',
    error: 'Error',
    delete: 'Delete',
    confirmDelete: 'Confirm',
    cancel: 'Cancel',
    rename: 'Rename',
    noResults: 'No results found',
    emptyState: 'Drag a note here',
    emptyHint: 'Drop to save images, extract text, and organize into groups',
    viewOriginal: 'View Original',
    aiSummary: 'AI Summary',
    imageText: 'Image Text',
    videoTranscript: 'Transcript',
    noteContent: 'Note',
    dataStats: 'Statistics',
    totalNotes: 'Total Notes',
    mediaFiles: 'Media Files',
    backups: 'Backups',
    dataDir: 'Data Directory',
    backupRestore: 'Backup & Restore',
    createBackup: 'Create Backup',
    restoreBackup: 'Restore',
    integrity: 'Data Integrity',
    checkIntegrity: 'Check Integrity',
    tagManager: 'Tag Manager',
    noTags: 'No tags',
    onboardingTitle: 'Welcome to Kanbox',
    onboardingStep1: 'Install Chrome Extension',
    onboardingStep2: 'Open Xiaohongshu or other platforms',
    onboardingStep3: 'Drag or click to save notes',
    onboardingSkip: 'Skip',
    onboardingNext: 'Next',
    onboardingDone: 'Get Started',
  },
};

let currentLang = typeof window !== 'undefined'
  ? (localStorage.getItem('kanbox:lang') || navigator.language || 'zh-CN')
  : 'zh-CN';

if (!LANGUAGES[currentLang]) {
  currentLang = currentLang.startsWith('en') ? 'en' : 'zh-CN';
}

export function t(key) {
  const dict = LANGUAGES[currentLang] || LANGUAGES['zh-CN'];
  return dict[key] || LANGUAGES['zh-CN'][key] || key;
}

export function setLanguage(lang) {
  if (LANGUAGES[lang]) {
    currentLang = lang;
    if (typeof window !== 'undefined') {
      localStorage.setItem('kanbox:lang', lang);
      window.dispatchEvent(new Event('kanbox:langchange'));
    }
  }
}

export function getLanguage() {
  return currentLang;
}

export function getAvailableLanguages() {
  return Object.keys(LANGUAGES).map(code => ({
    code,
    name: code === 'zh-CN' ? '中文' : 'English',
  }));
}
