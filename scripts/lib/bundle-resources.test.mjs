import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('桌面安装包包含 local-api 的全部本地模块依赖', async () => {
  const [source, tauriConfig] = await Promise.all([
    readFile(new URL('../local-api.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  const importedModules = [...source.matchAll(/from\s+['"]\.\/lib\/([^'"]+\.mjs)['"]/g)]
    .map((match) => `../scripts/lib/${match[1]}`)
    .sort();
  const bundledResources = new Set(Object.keys(tauriConfig?.bundle?.resources || {}));
  const missing = importedModules.filter((modulePath) => !bundledResources.has(modulePath));
  assert.deepEqual(missing, [], `安装包资源清单缺少：${missing.join(', ')}`);
});

