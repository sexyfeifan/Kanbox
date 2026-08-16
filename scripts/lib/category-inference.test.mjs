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
  assert.equal(result.notes[3].category, '其他'); // 推断不出 → 兜底「其他」
  assert.equal(result.reclassified, 2);
  assert.equal(result.remaining, 1);
  assert.equal(result.changed, true);
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
  assert.equal(result.changed, false);
});

test('classifies router/device notes as digital hardware', () => {
  const category = inferCategoryFromNote({
    title: '这个百元路由器性价比拉满',
    content: '路由器测评，信号、散热、稳定性对比',
    rawContent: '',
    tags: ['数码', '路由器'],
  });

  assert.equal(category, '数码硬件');
});

test('classifies outfit/beauty notes as fashion beauty', () => {
  const category = inferCategoryFromNote({
    title: '秋冬穿搭公式，显瘦显高',
    content: '毛衣叠穿、配色、发型建议',
    rawContent: '',
    tags: ['穿搭', '时尚'],
  });

  assert.equal(category, '时尚美妆');
});

test('falls back to 其他 when no category is confident', () => {
  const category = inferCategoryFromNote({
    title: '先这样！再那样！',
    content: '随便记一下',
    rawContent: '',
    tags: [],
  });

  assert.equal(category, '其他');
});

test('reCategorizeNotes migrates 待分类 notes to 其他 fallback when undeterminable', () => {
  const notes = [
    { id: 'x', title: '水笔记', content: '水', tags: [], category: '待分类' },
  ];
  const result = reCategorizeNotes(notes);
  assert.equal(result.notes[0].category, '其他');
  assert.equal(result.reclassified, 0);
  assert.equal(result.remaining, 1);
  assert.equal(result.changed, true);
});

test('classifies fitness notes as 健身运动', () => {
  const category = inferCategoryFromNote({
    title: '新手减脂训练计划，在家也能练',
    content: '力量训练、有氧结合，配合饮食',
    rawContent: '',
    tags: ['健身', '减脂', '运动'],
  });
  assert.equal(category, '健身运动');
});

test('classifies wellness notes as 健康养生', () => {
  const category = inferCategoryFromNote({
    title: '秋冬养生食谱，护肝养胃',
    content: '中医调理、食疗滋补',
    rawContent: '',
    tags: ['养生', '健康'],
  });
  assert.equal(category, '健康养生');
});

test('classifies home decor notes as 家居生活', () => {
  const category = inferCategoryFromNote({
    title: '出租屋改造，小户型收纳技巧',
    content: '软装、家具摆放',
    rawContent: '',
    tags: ['装修', '收纳'],
  });
  assert.equal(category, '家居生活');
});

test('classifies pet notes as 宠物', () => {
  const category = inferCategoryFromNote({
    title: '新手养猫指南，猫粮怎么选',
    content: '猫咪日常、猫砂',
    rawContent: '',
    tags: ['宠物', '猫咪'],
  });
  assert.equal(category, '宠物');
});

test('classifies car notes as 汽车', () => {
  const category = inferCategoryFromNote({
    title: '预算15万买新能源电车怎么选',
    content: '试驾、油耗、续航对比',
    rawContent: '',
    tags: ['买车', '新能源'],
  });
  assert.equal(category, '汽车');
});

test('classifies career notes as 职场', () => {
  const category = inferCategoryFromNote({
    title: '大厂面试高频题整理',
    content: '简历怎么写、跳槽经验',
    rawContent: '',
    tags: ['职场', '面试'],
  });
  assert.equal(category, '职场');
});

test('classifies finance notes as 理财投资', () => {
  const category = inferCategoryFromNote({
    title: '基金定投怎么开始，攒钱攻略',
    content: '理财、投资组合',
    rawContent: '',
    tags: ['理财', '基金'],
  });
  assert.equal(category, '理财投资');
});

test('classifies parenting notes as 母婴育儿', () => {
  const category = inferCategoryFromNote({
    title: '宝宝辅食添加顺序',
    content: '育儿经验分享',
    rawContent: '',
    tags: ['母婴', '辅食'],
  });
  assert.equal(category, '母婴育儿');
});

test('classifies gaming notes as 游戏 (not 影像创作)', () => {
  const category = inferCategoryFromNote({
    title: '原神新版本攻略',
    content: '抽卡、配队',
    rawContent: '',
    tags: ['手游', '游戏'],
  });
  assert.equal(category, '游戏');
});

test('classifies movie/drama notes as 影视娱乐', () => {
  const category = inferCategoryFromNote({
    title: '这个月值得追的韩剧片单',
    content: '剧情、演员阵容',
    rawContent: '',
    tags: ['追剧', '韩剧'],
  });
  assert.equal(category, '影视娱乐');
});

test('classifies healing/emotion notes as 情感治愈', () => {
  const category = inferCategoryFromNote({
    title: '套上怪兽的外壳，守护内心的小孩',
    content: '拥抱内在的小孩，成人的世界也需要童话',
    rawContent: '',
    tags: ['童话', '治愈'],
  });
  assert.equal(category, '情感治愈');
});
