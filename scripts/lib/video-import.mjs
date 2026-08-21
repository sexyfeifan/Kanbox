import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const MAX_VIDEO_BYTES = 600 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 120_000;
const MEDIA_HOST_SUFFIXES = ['.xhscdn.com', '.xhsimg.com'];
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export function isAllowedRemoteVideoUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && MEDIA_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

function findNativeAnalyzer() {
  const candidates = [
    process.env.KANKAN_VIDEO_ANALYZER,
    path.resolve(moduleDirectory, '../../src-tauri/bin/kanbox-video-analyzer'),
    path.resolve(moduleDirectory, '../kanbox-video-analyzer'),
    path.resolve(moduleDirectory, '../../kanbox-video-analyzer'),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || '';
}

async function fetchVideoResponse(url, fetchImpl, redirectCount = 0) {
  if (!isAllowedRemoteVideoUrl(url)) throw new Error('视频地址不属于受支持的小红书媒体域名');
  const response = await fetchImpl(url, {
    redirect: 'manual',
    credentials: 'omit',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'video/mp4,video/*;q=0.9,application/octet-stream;q=0.7',
      Referer: 'https://www.xiaohongshu.com/',
      'User-Agent': 'KanboxFavorites/0.1 local-video-import',
    },
  });

  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= MAX_REDIRECTS) throw new Error('视频重定向次数过多');
    const location = response.headers.get('location');
    if (!location) throw new Error('视频重定向缺少目标地址');
    return fetchVideoResponse(new URL(location, url).toString(), fetchImpl, redirectCount + 1);
  }
  if (!response.ok) throw new Error(`视频下载失败：${response.status}`);
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.startsWith('video/') && !contentType.includes('octet-stream')) {
    throw new Error('远程内容不是可识别的视频');
  }
  return response;
}

async function downloadVideo(url, noteDirectory, fetchImpl) {
  const response = await fetchVideoResponse(url, fetchImpl);
  if (!response.body) throw new Error('视频响应没有内容');
  const declaredLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
  if (declaredLength > MAX_VIDEO_BYTES) throw new Error('视频超过 600MB');

  const finalPath = path.join(noteDirectory, 'video.mp4');
  const temporaryPath = path.join(noteDirectory, 'video.part');
  let receivedBytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      callback(receivedBytes > MAX_VIDEO_BYTES ? new Error('视频超过 600MB') : null, chunk);
    },
  });

  await rm(temporaryPath, { force: true });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      limiter,
      createWriteStream(temporaryPath),
    );
    await rename(temporaryPath, finalPath);
    return finalPath;
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function runNativeVideoAnalyzer(videoPath, analyzerPath = findNativeAnalyzer()) {
  if (process.platform !== 'darwin') throw new Error('视频文稿目前仅支持 macOS');
  if (!analyzerPath) throw new Error('本地视频分析组件未安装');
  const { stdout } = await execFileAsync(analyzerPath, [videoPath], {
    timeout: 20 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    // 分析器可能在 stdout 前面打印非 JSON 的告警/日志，JSON.parse 会抛晦涩的
    // "Unexpected token"；这里给出可读的错误，与 extractVideoAudio 的 try/catch 对齐（P2#8）。
    throw new Error('本地视频分析没有返回有效结果');
  }
  if (!result || typeof result !== 'object') throw new Error('本地视频分析没有返回结果');
  return result;
}

/**
 * 从视频中仅提取音轨为 m4a 文件（不本地转写），供在线大模型转写使用。
 * 返回 { audioPath, duration }。
 */
export async function extractVideoAudio(videoPath, analyzerPath = findNativeAnalyzer(), outputPath = '') {
  if (process.platform !== 'darwin') throw new Error('音转文字增强目前仅支持 macOS');
  if (!analyzerPath) throw new Error('本地视频分析组件未安装');
  const audioPath = outputPath || path.join(path.dirname(videoPath), 'audio.m4a');
  const { stdout } = await execFileAsync(analyzerPath, ['--extract-audio', videoPath, audioPath], {
    timeout: 10 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error('提取视频音轨没有返回有效结果');
  }
  if (!result || result.error) throw new Error(result?.error || '提取视频音轨失败');
  return { audioPath: result.audioPath || audioPath, duration: Number.isFinite(result.duration) ? result.duration : 0 };
}

function cleanTranscriptSegments(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => ({
    start: Number.isFinite(entry?.start) ? Math.max(0, entry.start) : 0,
    duration: Number.isFinite(entry?.duration) ? Math.max(0, entry.duration) : 0,
    text: typeof entry?.text === 'string' ? entry.text.trim() : '',
  })).filter((entry) => entry.text);
}

const TRANSITION_PREFIX = /^(但是|但|然而|可是|不过|另外|此外|而且|首先|其次|再次|接着|然后|最后|总之|所以|因此|于是|接下来|总结|其实|事实上|也就是说|换句话说|例如|比如|值得一提的是)/;

/** 按句末标点切句，保留标点附在句尾。 */
function splitTranscriptSentences(text) {
  return text
    .split(/(?<=[。！？；…!?;])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * 根据内容对转写文本做换行/分段处理：
 * - 按句末标点（。！？；… 等）切句；
 * - 遇到语义转折词（但是/然而/首先/最后/总之…）另起一段；
 * - 每段累计不超过 maxSentences 句 / maxChars 字，超了自动分段。
 * 本地与在线大模型两种转写结果都统一走这里，让文稿自然分段可读。
 */
export function reflowTranscriptText(text, options = {}) {
  const raw = String(text || '').replace(/\r\n?/g, '\n');
  if (!raw.trim()) return '';
  const flattened = raw
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
  const maxSentences = options.maxSentences ?? 3;
  const maxChars = options.maxChars ?? 120;
  // 无标点长文本兜底：单句超过 hardSplitMax 时按字数硬切，避免「一面墙」
  const hardSplitMax = Math.max(maxChars, options.hardSplitMax ?? maxChars * 2);
  const sentences = [];
  for (const sentence of splitTranscriptSentences(flattened)) {
    if (sentence.length <= hardSplitMax) {
      sentences.push(sentence);
    } else {
      for (let i = 0; i < sentence.length; i += hardSplitMax) {
        sentences.push(sentence.slice(i, i + hardSplitMax));
      }
    }
  }
  const paragraphs = [];
  let current = '';
  let currentCount = 0;

  for (const sentence of sentences) {
    const startsNew = current !== '' && (TRANSITION_PREFIX.test(sentence) || currentCount >= maxSentences);
    if (startsNew) {
      paragraphs.push(current.trim());
      current = '';
      currentCount = 0;
    }
    current += sentence;
    currentCount += 1;
    if (currentCount >= maxSentences || current.length >= maxChars) {
      paragraphs.push(current.trim());
      current = '';
      currentCount = 0;
    }
  }
  if (current.trim()) paragraphs.push(current.trim());
  return paragraphs.join('\n\n');
}

export function applyVideoAnalysis(note, analysis, localVideoUrl, transcriptEngine = 'local') {
  const transcriptSegments = cleanTranscriptSegments(analysis.transcriptSegments);
  const rawTranscript = transcriptSegments.map((entry) => entry.text).join('');
  const transcriptText = reflowTranscriptText(rawTranscript);
  const warnings = [analysis.speechError].filter(Boolean).join('；');
  const updated = {
    ...note,
    videoUrl: localVideoUrl,
    videoDuration: Number.isFinite(analysis.duration) ? analysis.duration : 0,
    transcriptText,
    transcriptSegments,
    transcriptEngine,
    videoStatus: warnings ? 'partial' : 'ready',
    videoError: warnings,
  };
  delete updated.transcriptSkipped;
  delete updated.transcriptStatus;
  return updated;
}

/**
 * 统一转写入口：根据 options 决定走「在线大模型」还是「本地 macOS」。
 * - options.transcribeAudio 为函数且 options.enhanceTranscript 为 true → 在线转写
 * - 否则走本地 analyzer
 * 返回 { analysis, transcriptEngine }，analysis 与本地形状一致（duration/transcriptSegments/speechError）。
 */
async function runVideoTranscription(videoPath, options) {
  if (options.enhanceTranscript && typeof options.transcribeAudio === 'function') {
    const { audioPath, duration } = await extractVideoAudio(videoPath, options.analyzerPath);
    try {
      const result = await options.transcribeAudio(audioPath);
      return {
        analysis: {
          duration,
          transcriptSegments: result?.segments || [],
          speechError: '',
        },
        transcriptEngine: 'ai',
      };
    } finally {
      await rm(audioPath, { force: true }).catch(() => {});
    }
  }
  const analysis = await (options.analyzer || runNativeVideoAnalyzer)(videoPath);
  return { analysis, transcriptEngine: 'local' };
}

export async function reanalyzeStoredNoteVideo(note, options) {
  if (note.type !== 'video') throw new Error('这条笔记不是视频');
  const videoPath = path.join(options.mediaDirectory, note.id, 'video.mp4');
  if (!existsSync(videoPath)) throw new Error('本地视频文件不存在');
  const { analysis, transcriptEngine } = await runVideoTranscription(videoPath, options);
  const localVideoUrl = `${options.publicBaseUrl}/media/${note.id}/video.mp4`;
  return applyVideoAnalysis(note, analysis, localVideoUrl, transcriptEngine);
}

export async function localizeNoteVideo(note, options) {
  const sourceVideoUrl = typeof note.sourceVideoUrl === 'string'
    ? note.sourceVideoUrl
    : typeof note.videoUrl === 'string' && /^https:\/\//i.test(note.videoUrl)
      ? note.videoUrl
      : '';
  if (note.type !== 'video' || !sourceVideoUrl) {
    return {
      ...note,
      sourceVideoUrl,
      videoUrl: '',
      videoDuration: 0,
      transcriptText: '',
      transcriptSegments: [],
      videoStatus: 'none',
      videoError: note.type === 'video' ? '没有读取到可保存的视频地址' : '',
    };
  }

  const noteDirectory = path.join(options.mediaDirectory, note.id);
  await mkdir(noteDirectory, { recursive: true });
  let videoPath;
  try {
    videoPath = await downloadVideo(sourceVideoUrl, noteDirectory, options.fetchImpl || fetch);
  } catch (error) {
    return {
      ...note,
      sourceVideoUrl,
      videoUrl: '',
      videoStatus: 'partial',
      videoError: error instanceof Error ? error.message : '视频保存失败',
    };
  }

  const localVideoUrl = `${options.publicBaseUrl}/media/${note.id}/video.mp4`;
  if (options.preserveTranscript) {
    return {
      ...note,
      sourceVideoUrl,
      videoUrl: localVideoUrl,
      videoStatus: 'ready',
      videoError: '',
    };
  }
  if (options.skipTranscript) {
    return {
      ...note,
      sourceVideoUrl,
      videoUrl: localVideoUrl,
      videoDuration: 0,
      transcriptText: '',
      transcriptSegments: [],
      transcriptSkipped: true,
      videoStatus: 'ready',
      videoError: '',
    };
  }
  if (options.deferTranscript) {
    // 增强转写延迟到收录后的后台流水线执行：导入阶段只下载视频、标记「待转写」。
    return {
      ...note,
      sourceVideoUrl,
      videoUrl: localVideoUrl,
      videoDuration: 0,
      transcriptText: '',
      transcriptSegments: [],
      transcriptStatus: 'pending',
      videoStatus: 'ready',
      videoError: '',
    };
  }
  try {
    const { analysis, transcriptEngine } = await runVideoTranscription(videoPath, options);
    return applyVideoAnalysis({ ...note, sourceVideoUrl }, analysis, localVideoUrl, transcriptEngine);
  } catch (error) {
    return {
      ...note,
      sourceVideoUrl,
      videoUrl: localVideoUrl,
      videoDuration: 0,
      transcriptText: '',
      transcriptSegments: [],
      videoStatus: 'partial',
      videoError: error instanceof Error ? error.message : '本地视频分析失败',
    };
  }
}
