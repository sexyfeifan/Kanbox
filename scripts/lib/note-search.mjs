import { pinyinMatch, fuzzyMatch } from './pinyin-search.mjs';

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/\s+/g, ' ')
    .trim();
}

export function searchableNoteText(note, extraText = '') {
  const imageOcr = Array.isArray(note?.imageOcr)
    ? note.imageOcr.map((entry) => entry?.text || '')
    : [];
  const transcriptSegments = Array.isArray(note?.transcriptSegments)
    ? note.transcriptSegments.map((entry) => entry?.text || '')
    : [];

  return normalizeSearchText([
    note?.title,
    note?.content,
    note?.rawContent,
    note?.ocrText,
    note?.transcriptText,
    ...imageOcr,
    ...transcriptSegments,
    note?.author?.name,
    note?.category,
    ...(Array.isArray(note?.tags) ? note.tags : []),
    extraText,
  ].filter(Boolean).join('\n'));
}

export function noteMatchesQuery(note, query, extraText = '') {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;

  const haystack = searchableNoteText(note, extraText);
  const tokens = normalizedQuery.split(' ');

  return tokens.every((token) => {
    // Direct substring match
    if (haystack.includes(token)) return true;
    // Pinyin match
    if (pinyinMatch(haystack, token)) return true;
    // Fuzzy match for short queries
    if (token.length >= 2 && fuzzyMatch(haystack, token)) return true;
    return false;
  });
}

export function filterNotesByQuery(notes, query, getExtraText) {
  if (!Array.isArray(notes)) return [];
  const resolveExtraText = typeof getExtraText === 'function' ? getExtraText : () => '';
  return notes.filter((note) => noteMatchesQuery(note, query, resolveExtraText(note)));
}
