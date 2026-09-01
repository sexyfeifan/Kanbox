export const NOTE_VIEW_KEYS = ['all', 'favorite', 'unread', 'later', 'read', 'recent', 'today', 'conflict'];

function validTime(value) {
  const time = new Date(value || '').getTime();
  return Number.isFinite(time) ? time : 0;
}

function localDayKey(value) {
  const date = value instanceof Date ? value : new Date(value || '');
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function matchesNoteView(note, view, now = new Date()) {
  switch (view) {
    case 'favorite': return note?.favorite === true;
    case 'unread': return (note?.readState || 'unread') === 'unread';
    case 'later': return note?.readState === 'later';
    case 'read': return note?.readState === 'read';
    case 'recent': {
      const readAt = validTime(note?.lastReadAt);
      return readAt > 0 && readAt <= now.getTime() && readAt >= now.getTime() - 7 * 24 * 60 * 60 * 1000;
    }
    case 'today': return localDayKey(note?.savedAt) === localDayKey(now);
    case 'conflict': return note?.syncConflict === true;
    case 'all':
    default: return true;
  }
}

export function filterNotesByView(notes, view, now = new Date()) {
  return (Array.isArray(notes) ? notes : []).filter((note) => matchesNoteView(note, view, now));
}

export function countNoteViews(notes, now = new Date()) {
  return Object.fromEntries(NOTE_VIEW_KEYS.map((view) => [view, filterNotesByView(notes, view, now).length]));
}

export function sortNotesForView(notes, sortBy) {
  const sorted = [...(Array.isArray(notes) ? notes : [])];
  if (sortBy === 'oldest') return sorted.sort((a, b) => validTime(a?.savedAt) - validTime(b?.savedAt));
  if (sortBy === 'title') return sorted.sort((a, b) => String(a?.title || '').localeCompare(String(b?.title || ''), 'zh-CN'));
  if (sortBy === 'lastRead') return sorted.sort((a, b) => validTime(b?.lastReadAt) - validTime(a?.lastReadAt) || validTime(b?.savedAt) - validTime(a?.savedAt));
  return sorted.sort((a, b) => validTime(b?.savedAt) - validTime(a?.savedAt));
}
