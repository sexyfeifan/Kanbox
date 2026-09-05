import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const read = (name) => readFile(path.join(root, name), 'utf8');

test('desktop header keeps controls readable at the minimum window size', async () => {
  const [tauriConfig, deskView, globalCss] = await Promise.all([
    read('src-tauri/tauri.conf.json').then(JSON.parse),
    read('app/components/DeskView.tsx'),
    read('app/globals.css'),
  ]);

  const mainWindow = tauriConfig.app?.windows?.[0];
  assert.ok(mainWindow?.minWidth >= 1080, '桌面窗口必须保留可用的最小宽度');
  assert.ok(mainWindow?.minHeight >= 720, '桌面窗口必须保留可用的最小高度');
  assert.match(deskView, /gridTemplateColumns: '170px minmax\(230px, 360px\) minmax\(0, 1fr\)'/);
  assert.match(deskView, /className="header-action-rail"/);
  assert.match(deskView, /justifyContent: 'flex-start'/, '溢出滚动必须从第一个工具开始，不能把左侧按钮裁掉');
  assert.match(deskView, /overflowX: 'auto'/);
  assert.match(globalCss, /\.header-action-rail > button[\s\S]*?flex-shrink: 0;[\s\S]*?white-space: nowrap;/);
  assert.match(globalCss, /\.header-action-rail > button:first-child[\s\S]*?margin-left: auto;/);
});
