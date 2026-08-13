/**
 * Simple pinyin matching for Chinese text search.
 * Maps common pinyin initials to Chinese characters for basic matching.
 * No external dependencies — works entirely locally.
 */

// Pinyin initial consonant to common character mapping (simplified)
const PINYIN_MAP = {
  'a': '啊阿吖嗄', 'b': '不吧把被百半办帮包抱北本比边变别病并补不步部',
  'c': '才参草策曾差产长常超朝车陈称成城程吃冲出处穿传创春此次从村存',
  'd': '打大但当到道的得等低地弟点电调定东冬都度短对队多',
  'e': '额恶恩而儿耳二',
  'f': '发法反方非分风夫服父复',
  'g': '该感刚高告哥给更公功古关观管光广国果过',
  'h': '还好好和合河很恨后厚花华化话怀坏欢环换黄会活火或',
  'j': '几己计记纪加家间见将讲交叫教接街解今金进近京经精就举句决军',
  'k': '开看可客空口快况',
  'l': '来老乐了理力历利立连联脸良两亮量料林六龙路论落',
  'm': '马吗买满慢忙没美门们梦米面民明名模末莫某木目母',
  'n': '那哪拿南难内能你年念娘宁农女暖',
  'o': '哦', 'p': '怕排派盘判跑配朋批片飘平破普',
  'q': '七其奇起气千前强桥切亲青清情请秋求区去全群',
  'r': '然让人认日容如入',
  's': '三色山上少社身生声十时实世事是视室收手首受书术数双水睡说思死四送算虽随岁所',
  't': '他她它台太谈天田条铁听通同统头图土团推',
  'w': '外完万王往望为位文问我无五物',
  'x': '西希习系细下先想象小笑些心新信行醒姓兄弟休许续选学',
  'y': '呀压言眼阳养样要也业叶一已以意义因音应英影用由有又于与语元远院愿月云',
  'z': '在再早则怎曾张长找者这真正之知只指至治中钟终种重周主住注转装准子自走足族组最昨作做坐座',
};

export function pinyinMatch(text, query) {
  if (!text || !query) return false;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // Direct text match
  if (lowerText.includes(lowerQuery)) return true;

  // Check if query could be pinyin
  if (!/^[a-z]+$/.test(lowerQuery)) return false;

  // Try to match pinyin initials
  const firstChar = lowerQuery[0];
  const candidates = PINYIN_MAP[firstChar] || '';
  if (!candidates) return false;

  // Check if any candidate character appears in text at positions matching the pinyin
  for (const char of candidates) {
    if (lowerText.includes(char)) return true;
  }

  return false;
}

export function fuzzyMatch(text, query) {
  if (!text || !query) return false;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // Exact substring match
  if (lowerText.includes(lowerQuery)) return true;

  // Fuzzy: all query characters appear in order
  let qi = 0;
  for (let ti = 0; ti < lowerText.length && qi < lowerQuery.length; ti++) {
    if (lowerText[ti] === lowerQuery[qi]) qi++;
  }
  return qi === lowerQuery.length;
}
