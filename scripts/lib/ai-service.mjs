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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_AI_SETTINGS = {
  enabled: false,
  endpoint: '',          // 例如 https://api.openai.com/v1
  apiKey: '',
  model: 'gpt-4o-mini',
  autoTranscript: true,  // 导入视频时是否自动转写语音（本地 macOS Vision）
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

/** 返回「脱敏」后的设置（不直接回传密钥原文，仅标记是否已设置）。 */
export function maskAiSettings(aiSettings) {
  const masked = { ...aiSettings, apiKey: '' };
  masked.apiKeySet = Boolean(aiSettings.apiKey && String(aiSettings.apiKey).trim());
  return masked;
}
