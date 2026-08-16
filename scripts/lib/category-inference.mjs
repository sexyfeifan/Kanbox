const CATEGORY_RULES = [
  {
    category: '编程开发',
    strong: [
      /代码|编程|脚本|github|git|api|sdk|node|python|javascript|typescript|终端|terminal|cli|cursor|vscode|debug|仓库|接口|数据库|前端|后端|组件|开源组件|react|next\.js|网页开发/i,
    ],
    weak: [/开发|部署|工程|函数|自动化脚本|动效组件|网页设计/i],
    tagBoost: [/前端|后端|开发|编程|代码|组件|开源|网页设计/i],
  },
  {
    category: 'AI工具',
    strong: [
      /claude|openclaw|gpt|llm|aigc|midjourney|sora|comfyui|prompt|提示词|大模型|人工智能|智能体|agent|gemini|claudecode/i,
    ],
    weak: [/(^|[^a-z])ai([^a-z]|$)/i, /工作流|自动化|模型/i],
    tagBoost: [/AI|agent|openclaw|claudecode|效率神器|智能体|模型/i],
  },
  {
    category: '阅读思考',
    strong: [
      /读书|阅读|书单|书评|乡土中国|费孝通|卡夫卡|戈多|人类学|社会学|哲学|戏剧|文学|理论|思想|批评|人文社科|荒诞|贝克特/i,
    ],
    weak: [/认知|思考|概念|文本|语境|经典|作家|研究/i],
    tagBoost: [/书籍|文学|社会学|哲学|人类学|剧本|卡夫卡|乡土中国|人文社科/i],
  },
  {
    category: '设计美学',
    strong: [
      /设计|视觉|品牌|排版|字体|海报|审美|ascii|界面|ui|ux|平面|视觉趋势|品牌设计|设计解析|壁画|马赛克艺术/i,
    ],
    weak: [/美学|视觉流行趋势|风格|色彩/i],
    tagBoost: [/设计|品牌|视觉|ascii|排版|ui|ux|审美/i],
  },
  {
    category: '时尚美妆',
    strong: [
      /穿搭|美妆|护肤|彩妆|口红|香水|化妆|发型|发色|ootd|时尚|衣服|裙子|美甲|美容|皮肤|粉底|眼影|腮红|防晒|面膜|精华|衣品/i,
    ],
    weak: [/变美|气质|身材|配色|高级感|搭配|显瘦|显高/i],
    tagBoost: [/穿搭|美妆|护肤|彩妆|时尚|ootd|发型|衣品/i],
  },
  {
    category: '旅行户外',
    strong: [
      /旅行|旅游|徒步|环线|自驾|景点|路线|机票|酒店|露营|city walk|户外|游记|登山|雪山|海拔|香格里拉|腾冲|芒市|川西|冰岛|青海|漠河|阿拉木图|乌孙古道/i,
    ],
    weak: [/攻略|目的地|出行|行程|打卡/i],
    tagBoost: [/旅行|旅游|徒步|露营|户外/i],
  },
  {
    category: '美食餐饮',
    strong: [/美食|好吃|餐厅|探店|火锅|菜谱|烹饪|营养|食物|饮食|咖啡|甜品|潮汕|陈晓卿/i],
    weak: [/吃|口味|下饭|食材/i],
    tagBoost: [/美食|咖啡|餐厅|菜谱|探店/i],
  },
  {
    category: '影像创作',
    strong: [
      /摄影|分镜|电影|镜头|胶片|画面|构图|色彩|视觉叙事|影像|视频剪辑|动画|短片|可灵|veo|海螺|ray2|游戏制作/i,
    ],
    weak: [/叙事|故事|画幅|拍摄|视频/i],
    tagBoost: [/摄影|电影|镜头|影像|分镜|动画|短片/i],
  },
  {
    category: '数码硬件',
    strong: [
      /路由器|手机|电脑|笔记本|键盘|鼠标|显示器|耳机|音箱|音响|平板|手表|手环|智能家居|芯片|cpu|gpu|显卡|内存|硬盘|固态硬盘|ssd|nas|充电器|充电宝|电池|相机|无人机|数码|电子产品|家电|处理器|屏幕|续航|散热|开箱/i,
    ],
    weak: [/测评|评测|性价比|参数|配置|性能|硬件/i],
    tagBoost: [/数码|硬件|测评|评测|开箱|路由器|手机|电脑|键盘|耳机|相机/i],
  },
  {
    category: '方法论',
    strong: [/方法|步骤|清单|复盘|框架|流程|避坑|经验/i],
    weak: [/执行|打法|策略|教程|指南/i],
    tagBoost: [/教程|指南|复盘|方法|框架/i],
  },
  {
    category: '生活方式',
    strong: [/效率|习惯|时间管理|知识管理|收藏|整理|沉淀|身心|生活方式/i],
    weak: [/生活|管理|状态/i],
    tagBoost: [/效率|整理|知识管理|生活方式/i],
  },
  {
    category: '健身运动',
    strong: [
      /健身|减脂|增肌|撸铁|力量训练|有氧|hiit|体脂|马甲线|腹肌|肌肉|拉伸|跳绳|私教|健身房|瑜伽|普拉提|跑步|晨跑|夜跑|马拉松|燃脂/i,
    ],
    weak: [/训练|体能|运动|身材管理/i],
    tagBoost: [/健身|减脂|增肌|瑜伽|跑步|运动|撸铁/i],
  },
  {
    category: '健康养生',
    strong: [
      /养生|中医|睡眠|失眠|体检|血压|血糖|肠胃|食疗|滋补|调理|穴位|艾灸|拔罐|泡脚|抗衰|抗氧化|维生素|免疫力|脱发|护发|养胃|护肝/i,
    ],
    weak: [/健康|保养/i],
    tagBoost: [/养生|健康|中医|睡眠|食疗|抗衰/i],
  },
  {
    category: '家居生活',
    strong: [
      /装修|家居|软装|家具|收纳|租房|改造|全屋|绿植|摆件|家装|户型|北欧风|日式|简约|客厅|卧室|厨房|卫生间|阳台|窗帘|地毯|灯具/i,
    ],
    weak: [/布置|整理|家居好物/i],
    tagBoost: [/装修|家居|收纳|软装|家装|改造/i],
  },
  {
    category: '母婴育儿',
    strong: [
      /宝宝|母婴|育儿|怀孕|备孕|辅食|奶粉|尿不湿|尿布|亲子|绘本|儿童|早教|月子|胎教|婴儿|新生儿|断奶|哄睡/i,
    ],
    weak: [/育儿经验|带娃/i],
    tagBoost: [/母婴|育儿|宝宝|辅食|亲子|早教/i],
  },
  {
    category: '宠物',
    strong: [
      /猫咪|狗狗|宠物|养宠|吸猫|萌宠|猫粮|狗粮|铲屎官|撸猫|遛狗|猫砂|布偶|英短|柯基|金毛|柴犬|泰迪|狸花猫/i,
    ],
    weak: [/毛孩子|主子|喵星人/i],
    tagBoost: [/宠物|猫咪|狗狗|养宠|萌宠/i],
  },
  {
    category: '汽车',
    strong: [
      /汽车|买车|车评|新能源|电车|电动车|特斯拉|比亚迪|小米汽车|驾驶|油耗|suv|轿车|提车|试驾|交规|保养|洗车|轮胎|内饰|发动机|变速箱|充电桩|自动驾驶/i,
    ],
    weak: [/车型|落地价|裸车/i],
    tagBoost: [/汽车|买车|新能源|电车|试驾|提车/i],
  },
  {
    category: '职场',
    strong: [
      /职场|面试|简历|升职|加薪|裁员|跳槽|薪资|offer|大厂|打工人|绩效|同事|领导|汇报|年终奖|离职|裸辞|副业|转行/i,
    ],
    weak: [/工作|上班/i],
    tagBoost: [/职场|面试|简历|跳槽|副业/i],
  },
  {
    category: '理财投资',
    strong: [
      /理财|基金|股票|投资|存款|保险|省钱|攒钱|收益|财富|基金定投|炒股|开户|退休金|养老金|房贷|利息|复利|被动收入|财务自由/i,
    ],
    weak: [/存钱|记账|预算/i],
    tagBoost: [/理财|基金|股票|投资|攒钱|省钱/i],
  },
  {
    category: '游戏',
    strong: [
      /switch|ps5|xbox|主机|手游|原神|塞尔达|王者荣耀|英雄联盟|吃鸡|steam|单机游戏|网游|电竞|手柄|任天堂|索尼|游戏机|开黑|上分|氪金|抽卡|新游|steamdeck/i,
    ],
    weak: [/游戏|玩家/i],
    tagBoost: [/游戏|手游|电竞|主机|steam/i],
  },
];

const CATEGORY_PRIORITY = [
  '编程开发',
  'AI工具',
  '阅读思考',
  '设计美学',
  '时尚美妆',
  '旅行户外',
  '美食餐饮',
  '影像创作',
  '数码硬件',
  '方法论',
  '生活方式',
  '健身运动',
  '健康养生',
  '家居生活',
  '母婴育儿',
  '宠物',
  '汽车',
  '职场',
  '理财投资',
  '游戏',
];

// 「其他」是兜底分类：分类器尽力推断仍无法确定具体分类时，笔记落进这里，
// 而不是停留在「待分类」→「待整理」inbox 里积压。
export const FALLBACK_CATEGORY = '其他';

// 这些值都表示「尚未确定具体分类」，重新归档（reCategorizeNotes）时会重新推断。
// 「待分类」是历史遗留/过渡态值；「其他」是当前兜底分类；空串表示尚未分类。
const NON_SPECIFIC_CATEGORIES = new Set(['', '待分类', FALLBACK_CATEGORY]);

function hitScore(text, regs, weight) {
  if (!regs || regs.length === 0) return 0;
  return regs.reduce((acc, re) => acc + (re.test(text) ? weight : 0), 0);
}

export function inferCategoryFromNote(note) {
  const title = typeof note?.title === 'string' ? note.title : '';
  const content = typeof note?.content === 'string' ? note.content : '';
  const rawContent = typeof note?.rawContent === 'string' ? note.rawContent : '';
  const ocrText = typeof note?.ocrText === 'string' ? note.ocrText : '';
  const transcriptText = typeof note?.transcriptText === 'string' ? note.transcriptText : '';
  const tags = Array.isArray(note?.tags) ? note.tags.filter(Boolean).join(' ') : '';
  const source = `${title}\n${content}\n${rawContent}\n${ocrText}\n${transcriptText}\n${tags}`;
  const scores = new Map();

  for (const rule of CATEGORY_RULES) {
    const score = hitScore(source, rule.strong, 3)
      + hitScore(source, rule.weak, 1)
      + hitScore(tags, rule.tagBoost, 2)
      + hitScore(title, rule.tagBoost, 2);
    scores.set(rule.category, score);
  }

  const reading = scores.get('阅读思考') || 0;
  const design = scores.get('设计美学') || 0;
  const coding = scores.get('编程开发') || 0;
  const ai = scores.get('AI工具') || 0;

  if (reading >= 4) {
    scores.set('方法论', Math.max(0, (scores.get('方法论') || 0) - 2));
  }
  if (design >= 4 && coding >= 3) {
    scores.set('编程开发', coding + 1);
  }
  if (ai >= 4 && coding >= 4 && /agent|openclaw|claudecode|模型|prompt/i.test(source)) {
    scores.set('AI工具', ai + 1);
  }
  if ((scores.get('影像创作') || 0) >= 4 && /veo|可灵|海螺|动画|短片|视频|镜头/.test(source)) {
    scores.set('影像创作', (scores.get('影像创作') || 0) + 2);
    scores.set('AI工具', Math.max(0, (scores.get('AI工具') || 0) - 1));
  }

  let bestCategory = FALLBACK_CATEGORY;
  let bestScore = 0;

  for (const category of CATEGORY_PRIORITY) {
    const score = scores.get(category) || 0;
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  return bestScore >= 2 ? bestCategory : FALLBACK_CATEGORY;
}


// 对「未确定具体分类」的笔记重新跑分类推断（用于「重新归档」）。
// 只重算 category 缺失/空/「待分类」/「其他」的笔记，绝不动已有确定分类的笔记（可能是用户手动改的）。
// 推断出具体分类 → 写回；推断不出 → 落进兜底分类「其他」（并把历史「待分类」一并迁移过来，清空待整理）。
// 返回 { notes, reclassified, remaining, reclassifiedIds, changed }。
export function reCategorizeNotes(notes) {
  const list = Array.isArray(notes) ? notes : [];
  let reclassified = 0;
  let remaining = 0;
  let changed = false;
  const reclassifiedIds = [];

  const updated = list.map((note) => {
    const current = String(note?.category || '').trim();
    if (current && !NON_SPECIFIC_CATEGORIES.has(current)) {
      return note;
    }
    const inferred = inferCategoryFromNote(note);
    if (inferred !== FALLBACK_CATEGORY) {
      reclassified += 1;
      reclassifiedIds.push(note.id);
      changed = true;
      return { ...note, category: inferred };
    }
    remaining += 1;
    if (current !== FALLBACK_CATEGORY) {
      changed = true;
      return { ...note, category: FALLBACK_CATEGORY };
    }
    return note;
  });

  return { notes: updated, reclassified, remaining, reclassifiedIds, changed };
}
