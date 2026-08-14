/**
 * AI 服务：读取/写入 Kanbox 的应用设置，并调用 OpenAI 兼容的 LLM 接口
 * 完成「AI 摘要」与「知识拓展」。
 *
 * 设计要点：
 * - 设置持久化到数据目录下的 settings.json（未来可扩展其他设置分组）。
 * - LLM 调用在本地 sidecar（Node）里发起，避免 WebView 的 CORS 限制。
 * - 只支持 OpenAI 兼容的 `/chat/completions` 接口（OpenAI、MiMo、DeepSeek、Moonshot 等均可）。
 */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const DEFAULT_AI_SETTINGS = {
  enabled: false,
  endpoint: '',          // 例如 https://api.openai.com/v1
  apiKey: '',
  model: 'gpt-4o-mini',
  autoTranscript: true,  // 导入视频时是否自动转写语音（本地 macOS Vision）
  enhanceTranscript: false,   // 音转文字增强：开启后用在线大模型转写（更准确）
  autoPipeline: true,         // 素材收录后 5 秒自动执行「转写 → 摘要 → 知识拓展」流水线
  transcribeEndpoint: '',     // 音转文字接口地址（留空则复用上方 AI 摘要接口）
  transcribeApiKey: '',       // 音转文字接口密钥（留空则复用上方 AI 摘要密钥）
  transcribeModel: '',        // 音转文字模型（留空则回退 whisper-1）
};

const MAX_PROMPT_CHARS = 8000;
const REQUEST_TIMEOUT_MS = 60_000;

export function settingsFilePath(dataDirectory) {
  return path.join(dataDirectory, 'settings.json');
}

export async function loadSettings(dataDirectory) {
  const filePath = settingsFilePath(dataDirectory);
  if (!existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export async function saveSettings(dataDirectory, settings) {
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(settingsFilePath(dataDirectory), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

export async function loadAiSettings(dataDirectory) {
  const settings = await loadSettings(dataDirectory);
  const ai = settings && typeof settings.ai === 'object' && settings.ai ? settings.ai : {};
  return { ...DEFAULT_AI_SETTINGS, ...ai };
}

export async function saveAiSettings(dataDirectory, aiSettings) {
  const existing = await loadSettings(dataDirectory);
  const next = {
    ...existing,
    ai: { ...DEFAULT_AI_SETTINGS, ...(existing.ai || {}), ...aiSettings },
  };
  await saveSettings(dataDirectory, next);
  return next.ai;
}

/**
 * 判断 AI 是否「已配置且可用」——需要开启、填了 endpoint 和 apiKey、有 model。
 */
export function isAiConfigured(aiSettings) {
  return Boolean(
    aiSettings
    && aiSettings.enabled
    && typeof aiSettings.endpoint === 'string' && aiSettings.endpoint.trim()
    && typeof aiSettings.apiKey === 'string' && aiSettings.apiKey.trim()
    && typeof aiSettings.model === 'string' && aiSettings.model.trim()
  );
}

function normalizeEndpoint(endpoint) {
  let base = String(endpoint || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

/**
 * 解析「音转文字增强」实际使用的接口配置：
 * 转写专用字段（transcribeEndpoint/transcribeApiKey/transcribeModel）优先，
 * 留空时回退到 AI 摘要/拓展的 endpoint/apiKey/model，模型再兜底 whisper-1。
 */
export function resolveTranscriptSettings(aiSettings) {
  const source = aiSettings || {};
  return {
    endpoint: String(source.transcribeEndpoint || source.endpoint || '').trim(),
    apiKey: String(source.transcribeApiKey || source.apiKey || '').trim(),
    model: String(source.transcribeModel || source.model || 'whisper-1').trim(),
  };
}

/** 判断「音转文字增强」是否已开启且配置可用。 */
export function isTranscriptEnhanceConfigured(aiSettings) {
  if (!aiSettings || aiSettings.enhanceTranscript !== true) return false;
  const resolved = resolveTranscriptSettings(aiSettings);
  return Boolean(resolved.endpoint && resolved.apiKey && resolved.model);
}

/**
 * 计算一条笔记还有哪些 AI 任务「待处理」（用于收录后的自动流水线与手动全局补跑）。
 * 返回子集，可能包含 'transcript' | 'summary' | 'expansion'。
 * - transcript：视频已本地化、尚未转写，且用户没有明确关闭自动转写（transcriptSkipped）；
 * - summary：AI 已配置且尚未生成摘要；
 * - expansion：AI 已配置且尚未生成知识拓展。
 */
export function computePendingAiKinds(note, aiSettings) {
  const pending = [];
  const isVideo = note?.type === 'video';
  const hasVideo = isVideo && typeof note?.videoUrl === 'string' && note.videoUrl.trim().length > 0;
  const aiOn = isAiConfigured(aiSettings);

  if (hasVideo && !note.transcriptText && !note.transcriptSkipped) {
    pending.push('transcript');
  }
  if (aiOn && !note.aiSummary) pending.push('summary');
  if (aiOn && !note.aiExpansion) pending.push('expansion');
  return pending;
}

function normalizeTranscriptionEndpoint(endpoint) {
  let base = String(endpoint || '').trim().replace(/\/+$/, '');
  if (/\/audio\/transcriptions$/i.test(base)) return base;
  return `${base}/audio/transcriptions`;
}

/** 将 Whiser/OpenAI 兼容的转录结果规整为 { text, segments }。 */
export function normalizeTranscriptResult(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  let segments = [];
  if (Array.isArray(raw.segments) && raw.segments.length > 0) {
    segments = raw.segments
      .map((seg) => {
        const start = Number.isFinite(seg?.start) ? Math.max(0, seg.start) : 0;
        const end = Number.isFinite(seg?.end) ? seg.end : start;
        const segmentText = typeof seg?.text === 'string' ? seg.text.trim() : '';
        return segmentText ? { start, duration: Math.max(0, end - start), text: segmentText } : null;
      })
      .filter(Boolean);
  }
  if (!segments.length && text) {
    segments = [{ start: 0, duration: 0, text }];
  }
  return { text, segments };
}

/**
 * 用在线大模型转写音频，兼容两种接口形态：
 * 1) Whisper/OpenAI 兼容的 `POST /audio/transcriptions`（multipart，OpenAI、Groq 等）；
 * 2) MiMo 等 chat 形态：`POST /chat/completions` + `input_audio` 内容（base64 wav/mp3）。
 * 先按形态 1 请求，若网关返回 404（路由不存在）则自动回退到形态 2。
 * @param {object} aiSettings AI 设置（含增强开关与转写接口字段）
 * @param {string|Buffer} audioPath 本地音频文件路径
 */
export async function transcribeWithAi(aiSettings, audioPath, options = {}) {
  if (!isTranscriptEnhanceConfigured(aiSettings)) {
    throw new Error('音转文字增强尚未配置，请先在设置里填写接口地址、密钥和模型');
  }
  const resolved = resolveTranscriptSettings(aiSettings);
  const audioBuffer = typeof audioPath === 'string' ? await readFile(audioPath) : audioPath;
  const fileName = typeof audioPath === 'string' ? path.basename(audioPath) : 'audio.m4a';
  const timeoutMs = options.timeoutMs || 300_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 形态 1：Whisper /audio/transcriptions（multipart）
    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), fileName);
    form.append('model', resolved.model);
    form.append('response_format', 'verbose_json');
    const whisperUrl = normalizeTranscriptionEndpoint(resolved.endpoint);
    const response = await fetch(whisperUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${resolved.apiKey}` },
      body: form,
      signal: controller.signal,
    });

    if (response.status === 404 || response.status === 405) {
      // 网关不提供 Whisper 路由 → 回退到 chat/completions 的 input_audio 形态（MiMo 等）
      return await transcribeViaInputAudio(resolved, audioPath, timeoutMs);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`音转文字接口返回 ${response.status}：${detail.slice(0, 200)}`);
    }
    return normalizeTranscriptResult(await response.json());
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('音转文字接口请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * chat/completions + input_audio 形态转写（MiMo 等）。
 * 音频须为 wav/mp3，先经 afconvert 把 m4a 转成 16kHz 单声道 WAV 再 base64 上传。
 * 返回 { text, segments }（与 Whisper 结果形状一致）。
 */
async function transcribeViaInputAudio(resolved, audioPath, timeoutMs = 300_000) {
  if (typeof audioPath !== 'string') {
    throw new Error('chat 形态转写需要本地音频文件路径');
  }
  const wavPath = await convertAudioToWav(audioPath);
  let wavBuffer;
  try {
    wavBuffer = await readFile(wavPath);
  } finally {
    await rm(wavPath, { force: true }).catch(() => {});
  }
  const base64 = wavBuffer.toString('base64');
  const chatUrl = normalizeEndpoint(resolved.endpoint);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolved.apiKey}` },
      body: JSON.stringify({
        model: resolved.model,
        messages: [
          { role: 'user', content: [{ type: 'input_audio', input_audio: { data: base64, format: 'wav' } }] },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`音转文字接口返回 ${response.status}：${detail.slice(0, 200)}`);
    }
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('音转文字接口返回结果为空');
    }
    return normalizeTranscriptResult({ text });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('音转文字接口请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 将音频文件转成 16kHz 单声道 16-bit WAV（MiMo 的 input_audio 只接受 wav/mp3）。 */
async function convertAudioToWav(inputPath) {
  const outPath = inputPath.replace(/\.[^.]+$/, '') + '.wav';
  try {
    await execFileAsync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', inputPath, outPath], {
      timeout: 5 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`音轨转码失败：${error?.message || error}`);
  }
  return outPath;
}

/** 测试音转文字接口是否可用（用极小的一段静音音频做连通性探测，兼容 Whisper 与 MiMo 两种形态）。 */
export async function testTranscription(aiSettings) {
  if (!isTranscriptEnhanceConfigured(aiSettings)) {
    throw new Error('音转文字增强尚未配置，请先在设置里填写接口地址、密钥和模型');
  }
  const resolved = resolveTranscriptSettings(aiSettings);
  // 生成一段 0.2 秒的静音 WAV（PCM 16-bit mono 8kHz）作为连通性测试音频
  const sampleRate = 8000;
  const sampleCount = Math.floor(sampleRate * 0.2);
  const wav = Buffer.alloc(44 + sampleCount * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + sampleCount * 2, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(sampleCount * 2, 40);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'probe.wav');
    form.append('model', resolved.model);
    const whisperUrl = normalizeTranscriptionEndpoint(resolved.endpoint);
    const response = await fetch(whisperUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${resolved.apiKey}` },
      body: form,
      signal: controller.signal,
    });

    if (response.status === 404 || response.status === 405) {
      // 回退到 chat 形态连通性探测（把同一段静音 WAV 直接 base64 上传，无需转码）
      const chatUrl = normalizeEndpoint(resolved.endpoint);
      const chatResponse = await fetch(chatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolved.apiKey}` },
        body: JSON.stringify({
          model: resolved.model,
          messages: [
            { role: 'user', content: [{ type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } }] },
          ],
        }),
        signal: controller.signal,
      });
      if (!chatResponse.ok) {
        const detail = await chatResponse.text().catch(() => '');
        throw new Error(`音转文字接口返回 ${chatResponse.status}：${detail.slice(0, 200)}`);
      }
      return await chatResponse.text();
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`音转文字接口返回 ${response.status}：${detail.slice(0, 200)}`);
    }
    return await response.text();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('音转文字接口请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function truncateText(value, maxChars = MAX_PROMPT_CHARS) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export async function chatCompletion(aiSettings, messages, options = {}) {
  if (!isAiConfigured(aiSettings)) {
    throw new Error('AI 功能尚未配置，请先在设置里填写接口地址、密钥和模型');
  }

  const url = normalizeEndpoint(aiSettings.endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aiSettings.apiKey}`,
      },
      body: JSON.stringify({
        model: aiSettings.model,
        messages,
        temperature: options.temperature ?? 0.4,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`AI 接口返回 ${response.status}：${detail.slice(0, 200)}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('AI 接口返回结果为空');
    }
    return content.trim();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('AI 接口请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 汇总一条笔记可用于 AI 的文本（覆盖图文与视频两类内容）。 */
export function buildNoteText(note) {
  const sections = [];
  if (note.title) sections.push(`【标题】${note.title}`);
  if (note.rawContent || note.content) sections.push(`【正文】${note.rawContent || note.content}`);
  if (note.ocrText) sections.push(`【图片文字】${note.ocrText}`);
  if (note.transcriptText) sections.push(`【视频文稿】${note.transcriptText}`);
  return truncateText(sections.join('\n'));
}

export async function summarizeWithAi(aiSettings, note) {
  const text = buildNoteText(note);
  if (!text) return '';
  const content = await chatCompletion(aiSettings, [
    {
      role: 'system',
      content: '你是「看看收藏 Kanbox」的笔记助手，擅长提炼收藏内容的要点。',
    },
    {
      role: 'user',
      content: '请用简洁的中文总结下面这条收藏内容，突出核心信息，控制在 180 字以内，分要点或短段落呈现，不要编造原文没有的信息。\n\n' + text,
    },
  ]);
  return content;
}

export async function expandWithAi(aiSettings, note) {
  const text = buildNoteText(note);
  if (!text) return '';
  const content = await chatCompletion(aiSettings, [
    {
      role: 'system',
      content: '你是「看看收藏 Kanbox」的知识助手，帮助用户围绕收藏内容做知识拓展。',
    },
    {
      role: 'user',
      content: '请围绕下面这条收藏内容，拓展相关的背景知识、概念解释、延伸话题或实用建议，帮助用户更深入地理解主题。用中文分点输出，条理清晰，不要复述原文。\n\n' + text,
    },
  ], { temperature: 0.6 });
  return content;
}

export async function testAi(aiSettings) {
  const content = await chatCompletion(aiSettings, [
    { role: 'user', content: '请只回复两个字：正常' },
  ], { temperature: 0, timeoutMs: 30_000 });
  return content;
}

/** 返回可直接展示的设置（含密钥原文，本地桌面应用密钥本就明文存于 settings.json）。
 *  附 apiKeySet / transcribeApiKeySet 标记，供前端展示「已设置」状态。 */
export function publicAiSettings(aiSettings) {
  const out = { ...aiSettings };
  out.apiKeySet = Boolean(aiSettings.apiKey && String(aiSettings.apiKey).trim());
  out.transcribeApiKeySet = Boolean(aiSettings.transcribeApiKey && String(aiSettings.transcribeApiKey).trim());
  return out;
}
