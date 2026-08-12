function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripDuplicateTagSuffix(content, tags = []) {
  const source = typeof content === 'string' ? content.trim() : '';
  if (!source) return '';

  const xhsTopicSuffix = /(?:\s*#[^#\r\n]+?\[话题\]#)+\s*(?:@[^\r\n]+)?\s*$/u;
  const withoutXhsTopics = source.replace(xhsTopicSuffix, '').trim();
  if (withoutXhsTopics !== source) return withoutXhsTopics;

  const tagNames = Array.isArray(tags)
    ? tags.map((tag) => String(tag).replace(/^#/, '').trim()).filter(Boolean)
    : [];
  if (tagNames.length === 0) return source;

  const alternatives = tagNames.sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  const duplicateTagSuffix = new RegExp(
    `(?:\\s*#(?:${alternatives})(?:\\[话题\\])?#?)+\\s*(?:@[^\\r\\n]+)?\\s*$`,
    'u',
  );
  return source.replace(duplicateTagSuffix, '').trim();
}
