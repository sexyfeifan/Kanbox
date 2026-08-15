import test from 'node:test';
import assert from 'node:assert/strict';

import { inferCategoryFromNote, reCategorizeNotes } from './category-inference.mjs';

test('classifies frontend component notes as coding', () => {
  const category = inferCategoryFromNote({
    title: '液态交互动效怎么做？试试这个开源组件..',
    content: '',
    rawContent: '',
    tags: ['网页设计', '前端', '动效', 'AI教程'],
  });

  assert.equal(category, '编程开发');
});

test('classifies agent workflow notes as ai tools', () => {
  const category = inferCategoryFromNote({
    title: '我的龙虾是会刷X的Agent了！【附教程】',
    content: '',
    rawContent: '',
    tags: ['效率神器', 'openclaw', 'agent', 'claudecode'],
  });

  assert.equal(category, 'AI工具');
});

test('classifies sociology and literature notes as reading', () => {
  const category = inferCategoryFromNote({
    title: '从《乡土中国》到2026：差序格局的传承与变',
    content: '',
    rawContent: '',
    tags: ['社会学', '乡土中国', '返乡', '人文社科'],
  });

  assert.equal(category, '阅读思考');
});

test('classifies visual trend notes as design aesthetics', () => {
  const category = inferCategoryFromNote({
    title: '当下最热的视觉流行趋势',
    content: '',
    rawContent: '',
    tags: ['设计解析', '品牌设计', 'ascii', '视觉趋势'],
  });

  assert.equal(category, '设计美学');
});

test('classifies veo short film notes as visual creation', () => {
  const category = inferCategoryFromNote({
    title: 'Veo2 原创短片实验',
    content: '',
    rawContent: 'Veo2、可灵和海螺的视频能力已经能做更完整的镜头语言和动画短片。',
    tags: ['动画短片', 'AI视频'],
  });

  assert.equal(category, '影像创作');
});

test('uses local OCR text when title and body are sparse', () => {
  const category = inferCategoryFromNote({
    title: '收藏一下',
    content: '',
    rawContent: '',
    ocrText: 'React 前端组件开发与 TypeScript 调试步骤',
    tags: [],
  });

  assert.equal(category, '编程开发');
});

test('reCategorizeNotes reclassifies 待分类 notes and leaves determined categories alone', () => {
  const notes = [
    { id: 'a', title: '液态交互动效怎么做？试试这个开源组件', content: '', tags: ['前端', '动效'], category: '待分类' },
    { id: 'b', title: '我的龙虾是会刷X的Agent了', content: '', tags: ['agent', 'claudecode'], category: '' },
    { id: 'c', title: '手动归类的笔记', content: '', tags: [], category: '设计美学' },
    { id: 'd', title: '一条毫无特征的水笔记', content: '水', tags: [], category: '待分类' },
  ];

  const result = reCategorizeNotes(notes);

  assert.equal(result.notes[0].category, '编程开发');
  assert.equal(result.notes[1].category, 'AI工具');
  assert.equal(result.notes[2].category, '设计美学'); // 不动已确定分类
  assert.equal(result.notes[3].category, '待分类'); // 推断不出 → 保持待分类
  assert.equal(result.reclassified, 2);
  assert.equal(result.remaining, 1);
  assert.deepEqual(result.reclassifiedIds, ['a', 'b']);
});

test('reCategorizeNotes treats missing category as uncategorized', () => {
  const notes = [
    { id: 'x', title: 'React 前端组件开发与 TypeScript 调试', content: '', tags: [] },
  ];
  const result = reCategorizeNotes(notes);
  assert.equal(result.notes[0].category, '编程开发');
  assert.equal(result.reclassified, 1);
});

test('reCategorizeNotes is a no-op when nothing to reclassify', () => {
  const notes = [
    { id: 'a', title: '已经分好类', content: '', tags: [], category: '旅行户外' },
  ];
  const result = reCategorizeNotes(notes);
  assert.equal(result.notes[0].category, '旅行户外');
  assert.equal(result.reclassified, 0);
  assert.equal(result.remaining, 0);
});
