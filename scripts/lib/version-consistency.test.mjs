import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const read = (name) => readFile(path.join(root, name), 'utf8');

test('发布版本号在桌面端、扩展、备份、归档和文档中完全一致', async () => {
  const packageJson = JSON.parse(await read('package.json'));
  const expected = packageJson.version;
  const checks = [
    ['package-lock.json', JSON.parse(await read('package-lock.json')).version],
    ['tauri.conf.json', JSON.parse(await read('src-tauri/tauri.conf.json')).version],
    ['extension manifest', JSON.parse(await read('browser-extension/manifest.json')).version],
    ['Cargo.toml', (await read('src-tauri/Cargo.toml')).match(/^version = "([^"]+)"/m)?.[1]],
    ['Cargo.lock kanbox', (await read('src-tauri/Cargo.lock')).match(/name = "kanbox"\nversion = "([^"]+)"/)?.[1]],
    ['backup schema', (await read('scripts/local-api.mjs')).match(/BACKUP_VERSION = '([^']+)'/)?.[1]],
    ['archive manifest', (await read('scripts/lib/full-archive.mjs')).match(/appVersion: '([^']+)'/)?.[1]],
    ['extension popup', (await read('browser-extension/popup.html')).match(/>v([0-9.]+)<\/span>/)?.[1]],
    ['README badge', (await read('README.md')).match(/Version-([0-9.]+)-green/)?.[1]],
  ];
  for (const [name, actual] of checks) assert.equal(actual, expected, `${name} 版本号偏离 ${expected}`);
});
