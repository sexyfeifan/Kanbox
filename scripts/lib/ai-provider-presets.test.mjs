import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLM_PROVIDERS, TRANSCRIBE_PROVIDERS, aiPresets, validateProviderPresets } from './ai-provider-presets.mjs';

test('validateProviderPresets 校验通过', () => {
  assert.equal(validateProviderPresets(), true);
});

test('LLM 推荐服务商至少包含 5 家，且字段完整', () => {
  assert.ok(LLM_PROVIDERS.length >= 5);
  for (const provider of LLM_PROVIDERS) {
    assert.ok(/^https:\/\//.test(provider.endpoint), `${provider.name} endpoint 应为 https`);
    assert.ok(provider.models.length > 0, `${provider.name} 应有模型`);
    for (const model of provider.models) {
      assert.ok(model.id.trim());
      assert.ok(model.description.trim(), `${model.id} 缺少介绍`);
    }
  }
});

test('转写推荐服务商包含 MiMo / Whisper，且字段完整', () => {
  assert.ok(TRANSCRIBE_PROVIDERS.length >= 3);
  const ids = TRANSCRIBE_PROVIDERS.map((p) => p.id);
  assert.ok(ids.includes('mimo-asr'));
  assert.ok(ids.some((id) => id.includes('whisper')));
  for (const provider of TRANSCRIBE_PROVIDERS) {
    assert.ok(/^https:\/\//.test(provider.endpoint));
    for (const model of provider.models) {
      assert.ok(model.id.trim());
      assert.ok(model.description.trim(), `${model.id} 缺少介绍`);
    }
  }
});

test('aiPresets 返回 llm 与 transcribe 两组', () => {
  const presets = aiPresets();
  assert.ok(Array.isArray(presets.llm) && presets.llm.length > 0);
  assert.ok(Array.isArray(presets.transcribe) && presets.transcribe.length > 0);
});
