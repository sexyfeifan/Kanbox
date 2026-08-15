/**
 * AI 服务商「推荐配置」预设（v0.7.1）。
 *
 * 设置面板里有两处需要填 API 配置：
 *   1. AI 摘要 / 知识拓展（通用 LLM）：endpoint + apiKey + model；
 *   2. 音转文字增强（转写）：transcribeEndpoint + transcribeApiKey + transcribeModel。
 * 两处的接口形态不同（转写还分 Whisper multipart 与 MiMo chat 形态），
 * 所以分别给出推荐的服务商与模型，前端据此渲染下拉建议，同时保留「用户自定义」。
 *
 * 所有字段仅作展示与自动填充用，不参与任何网络请求。
 */

/** 通用 LLM（AI 摘要 / 知识拓展）推荐服务商。 */
export const LLM_PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek（深度求索）',
    endpoint: 'https://api.deepseek.com/v1',
    models: [
      { id: 'deepseek-chat', name: 'deepseek-chat', description: 'DeepSeek-V3 通用对话模型，擅长中文写作、代码与知识问答，性价比高。' },
      { id: 'deepseek-reasoner', name: 'deepseek-reasoner', description: '深度推理模型（R1），擅长复杂推理、数学与逻辑，响应较慢。' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini', description: '轻量多模态模型，速度快、成本低，适合日常总结与拓展。' },
      { id: 'gpt-4o', name: 'gpt-4o', description: '旗舰多模态模型，理解与生成能力最强，成本较高。' },
    ],
  },
  {
    id: 'moonshot',
    name: 'Moonshot（月之暗面 Kimi）',
    endpoint: 'https://api.moonshot.cn/v1',
    models: [
      { id: 'moonshot-v1-8k', name: 'moonshot-v1-8k', description: 'Kimi 基础模型，8k 上下文，擅长中文长文本处理。' },
      { id: 'moonshot-v1-32k', name: 'moonshot-v1-32k', description: 'Kimi 长上下文版本（32k），适合一次处理大量内容。' },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 AI（GLM）',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-4-flash', name: 'glm-4-flash', description: '免费/低成本快速模型，适合批量摘要与拓展。' },
      { id: 'glm-4', name: 'glm-4', description: '通用旗舰模型，综合能力均衡。' },
    ],
  },
  {
    id: 'qwen',
    name: '通义千问（阿里云 DashScope）',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen-plus', name: 'qwen-plus', description: '性能与速度均衡，中文理解能力强。' },
      { id: 'qwen-turbo', name: 'qwen-turbo', description: '快速低成本，适合高并发轻量任务。' },
    ],
  },
  {
    id: 'mimo',
    name: '小米 MiMo',
    endpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
    models: [
      { id: 'mimo-v2.5-pro', name: 'mimo-v2.5-pro', description: '小米旗舰模型，通用能力强，中文与多模态表现均衡。' },
    ],
  },
];

/** 音转文字增强（转写）推荐服务商。 */
export const TRANSCRIBE_PROVIDERS = [
  {
    id: 'mimo-asr',
    name: '小米 MiMo ASR',
    endpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
    models: [
      { id: 'mimo-v2.5-asr', name: 'mimo-v2.5-asr', description: '中文语音识别，走 chat 形态（input_audio），长音频自动分片，推荐。' },
    ],
  },
  {
    id: 'openai-whisper',
    name: 'OpenAI Whisper',
    endpoint: 'https://api.openai.com/v1',
    models: [
      { id: 'whisper-1', name: 'whisper-1', description: '通用语音转文字（Whisper 接口），多语言支持。' },
    ],
  },
  {
    id: 'groq-whisper',
    name: 'Groq（Whisper 加速）',
    endpoint: 'https://api.groq.com/openai/v1',
    models: [
      { id: 'whisper-large-v3', name: 'whisper-large-v3', description: '高速 Whisper 推理，低延迟，适合大批量转写。' },
    ],
  },
];

/**
 * 校验预设结构是否完整（供单测与运行时自检）。
 * 每条：endpoint 为 https，models 非空，每个 model 有 id 与 description。
 */
export function validateProviderPresets() {
  for (const provider of [...LLM_PROVIDERS, ...TRANSCRIBE_PROVIDERS]) {
    if (typeof provider.id !== 'string' || !provider.id.trim()) return false;
    if (typeof provider.name !== 'string' || !provider.name.trim()) return false;
    if (typeof provider.endpoint !== 'string' || !/^https:\/\//.test(provider.endpoint)) return false;
    if (!Array.isArray(provider.models) || provider.models.length === 0) return false;
    for (const model of provider.models) {
      if (typeof model.id !== 'string' || !model.id.trim()) return false;
      if (typeof model.name !== 'string' || !model.name.trim()) return false;
      if (typeof model.description !== 'string' || !model.description.trim()) return false;
    }
  }
  return true;
}

/** 供 /ai/presets 端点返回的推荐配置。 */
export function aiPresets() {
  return { llm: LLM_PROVIDERS, transcribe: TRANSCRIBE_PROVIDERS };
}
