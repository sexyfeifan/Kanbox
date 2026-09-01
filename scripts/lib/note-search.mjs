import { pinyinMatch, fuzzyMatch } from './pinyin-search.mjs';

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/\s+/g, ' ')
    .trim();
}

const SEARCH_FIELDS = new Set(['title', 'author', 'tag', 'category', 'ocr', 'transcript']);

export function parseSearchQuery(query) {
  const source = String(query ?? '').normalize('NFKC').trim();
  const terms = [];
  const pattern = /(-)?(?:(title|author|tag|category|ocr|transcript):)?(?:"([^"]+)"|(\S+))/giu;
  let match;
  while ((match = pattern.exec(source))) {
    const value = normalizeSearchText(match[3] || match[4]);
    if (!value) continue;
    terms.push({ value, exclude: Boolean(match[1]), field: SEARCH_FIELDS.has(match[2]) ? match[2] : '', exact: Boolean(match[3]) });
  }
  return terms;
}

function searchableFieldText(note, field, extraText = '') {
  if (!field) return searchableNoteText(note, extraText);
  if (field === 'title') return normalizeSearchText(note?.title);
  if (field === 'author') return normalizeSearchText(note?.author?.name);
  if (field === 'tag') return normalizeSearchText(Array.isArray(note?.tags) ? note.tags.join('\n') : '');
  if (field === 'category') return normalizeSearchText(note?.category);
  if (field === 'ocr') return normalizeSearchText([
    note?.ocrText,
    ...(Array.isArray(note?.imageOcr) ? note.imageOcr.map((entry) => entry?.text || '') : []),
  ].filter(Boolean).join('\n'));
  if (field === 'transcript') return normalizeSearchText([
    note?.transcriptText,
    ...(Array.isArray(note?.transcriptSegments) ? note.transcriptSegments.map((entry) => entry?.text || '') : []),
  ].filter(Boolean).join('\n'));
  return searchableNoteText(note, extraText);
}

function textMatchesTerm(haystack, term) {
  if (haystack.includes(term.value)) return true;
  if (term.exact) return false;
  if (pinyinMatch(haystack, term.value)) return true;
  return term.value.length >= 2 && fuzzyMatch(haystack, term.value);
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
  const terms = parseSearchQuery(query);
  if (terms.length === 0) return true;
  return terms.every((term) => {
    const matches = textMatchesTerm(searchableFieldText(note, term.field, extraText), term);
    return term.exclude ? !matches : matches;
  });
}

export function filterNotesByQuery(notes, query, getExtraText) {
  if (!Array.isArray(notes)) return [];
  const resolveExtraText = typeof getExtraText === 'function' ? getExtraText : () => '';
  return notes.filter((note) => noteMatchesQuery(note, query, resolveExtraText(note)));
}
