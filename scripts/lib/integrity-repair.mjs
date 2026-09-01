import path from 'node:path';

const REPAIRABLE_MEDIA_FIELDS = [
  'coverUrl',
  'imageUrls',
  'sourceImageUrls',
  'imageOcr',
  'ocrText',
  'mediaStatus',
  'mediaError',
  'sourceVideoUrl',
  'videoUrl',
  'videoDuration',
  'videoStatus',
  'videoError',
  'transcriptText',
  'transcriptSegments',
  'transcriptEngine',
  'transcriptStatus',
];

export function storedMediaFileName(mediaUrl, noteId) {
  if (typeof mediaUrl !== 'string' || !/^[0-9a-f]{24}$/i.test(noteId || '')) return null;
  let pathname;
  try {
    pathname = new URL(mediaUrl, 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
  const prefix = `/media/${noteId}/`;
  if (!pathname.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const encodedName = pathname.slice(prefix.length);
  let fileName;
  try {
    fileName = decodeURIComponent(encodedName);
  } catch {
    return null;
  }
  if (!fileName || fileName !== path.basename(fileName) || fileName === '.' || fileName === '..') return null;
  return fileName;
}

export function findMissingStoredMedia(note, { mediaDirectory, exists }) {
  const missing = [];
  const noteMediaDirectory = path.join(mediaDirectory, note.id);
  for (const imageUrl of Array.isArray(note.imageUrls) ? note.imageUrls : []) {
    const fileName = storedMediaFileName(imageUrl, note.id);
    if (fileName && !exists(path.join(noteMediaDirectory, fileName))) missing.push(fileName);
    else if (!fileName && typeof imageUrl === 'string' && imageUrl.includes('/media/')) missing.push('无效媒体路径');
  }
  if (note.type === 'video' && !exists(path.join(noteMediaDirectory, 'video.mp4'))) missing.push('video.mp4');
  return [...new Set(missing)];
}

// 媒体下载在写队列外进行。提交时只覆盖媒体派生字段，以保留
// 下载期间用户对标题、标签、分类、收藏与阅读状态的最新修改。
export function mergeRepairedMedia(current, repaired) {
  const merged = { ...current };
  for (const field of REPAIRABLE_MEDIA_FIELDS) {
    if (Object.hasOwn(repaired, field)) merged[field] = repaired[field];
  }
  return merged;
}
