/**
 * Simple extractive text summarization.
 * Scores sentences by keyword frequency and position,
 * returns the top N sentences as a summary.
 * No external APIs — runs entirely locally.
 */

const SENTENCE_SPLIT = /(?<=[。！？.!?])\s*/;
const WORD_SPLIT = /[\s,，。！？.!?、；;：:（）()【】\[\]""'']+/;

// Chinese/English stop words to ignore
const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
  'not', 'no', 'nor', 'so', 'yet', 'both', 'either', 'neither',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
]);

function extractKeywords(text) {
  const words = text.split(WORD_SPLIT).filter(w => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()));
  const freq = new Map();
  for (const word of words) {
    const lower = word.toLowerCase();
    freq.set(lower, (freq.get(lower) || 0) + 1);
  }
  return freq;
}

function scoreSentence(sentence, keywords, index, total) {
  const words = sentence.split(WORD_SPLIT).filter(w => w.length > 1);
  if (words.length === 0) return 0;

  // Keyword score
  let keywordScore = 0;
  for (const word of words) {
    keywordScore += keywords.get(word.toLowerCase()) || 0;
  }
  keywordScore = keywordScore / words.length;

  // Position score — first and last sentences are more important
  const positionScore = index === 0 ? 1.5
    : index === 1 ? 1.2
    : index < total * 0.2 ? 1.0
    : index > total * 0.8 ? 0.8
    : 0.5;

  // Length penalty — very short sentences are usually not meaningful
  const lengthScore = words.length < 3 ? 0.3 : words.length < 8 ? 0.7 : 1.0;

  return keywordScore * positionScore * lengthScore;
}

export function summarizeText(text, maxSentences = 3) {
  if (!text || typeof text !== 'string') return '';

  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length < 50) return cleaned;

  const sentences = cleaned.split(SENTENCE_SPLIT)
    .map(s => s.trim())
    .filter(s => s.length >= 10);

  if (sentences.length <= maxSentences) return sentences.join('\n');

  const keywords = extractKeywords(cleaned);
  const scored = sentences.map((sentence, index) => ({
    sentence,
    index,
    score: scoreSentence(sentence, keywords, index, sentences.length),
  }));

  // Sort by score, take top N, then re-sort by original position
  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.index - b.index)
    .map(item => item.sentence);

  return top.join('\n');
}

export function summarizeNote(note) {
  const parts = [];
  if (note.title) parts.push(note.title);
  if (note.rawContent || note.content) parts.push(note.rawContent || note.content);
  if (note.ocrText) parts.push(note.ocrText.slice(0, 2000));
  if (note.transcriptText) parts.push(note.transcriptText.slice(0, 2000));

  return summarizeText(parts.join('\n'), 4);
}
