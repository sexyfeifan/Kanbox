export function formatMediaTime(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function paginateTimedSegments(segments, secondsPerPage = 60) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const pages = [];
  for (const segment of segments) {
    const start = Math.max(0, Number(segment?.start) || 0);
    const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
    if (!text) continue;
    const pageIndex = Math.floor(start / secondsPerPage);
    while (pages.length <= pageIndex) pages.push([]);
    pages[pageIndex].push({ ...segment, start, text });
  }
  return pages.filter((page) => page.length > 0);
}

export function paginatePlainText(value, maxCharacters = 1100) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return [];
  const paragraphs = text.split(/\n{2,}/).map((entry) => entry.trim()).filter(Boolean);
  const pages = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const chunks = paragraph.match(new RegExp(`[\\s\\S]{1,${maxCharacters}}`, 'g')) || [];
    for (const chunk of chunks) {
      if (current && current.length + chunk.length + 2 > maxCharacters) {
        pages.push(current);
        current = '';
      }
      current = current ? `${current}\n\n${chunk}` : chunk;
    }
  }
  if (current) pages.push(current);
  return pages;
}
