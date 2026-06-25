require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const DEFAULT_LIMIT = 200;
const REPORT_DIR = 'reports';

const STOP_WORDS = new Set([
  'patagonia',
  '小红书',
  '分享',
  '真的',
  '这个',
  '一个',
  '一些',
  '我的',
  '适合',
  '推荐',
  '穿搭',
  '笔记',
  '品牌',
  '衣服',
  '衣橱',
  '今天',
  '日常',
  '怎么',
  '为什么',
]);

const STYLE_RULES = [
  { label: '山系户外', terms: ['山系', '户外', '徒步', '露营', '登山', '机能', 'hiking', 'camping', 'outdoor'] },
  { label: '城市通勤', terms: ['通勤', '上班', '城市', 'city', 'citywalk', '街头', '街拍', '松弛'] },
  { label: '复古美式', terms: ['复古', '美式', 'vintage', '古着', '老钱', 'archive'] },
  { label: '秋冬叠穿', terms: ['秋冬', '冬天', '保暖', '叠穿', '抓绒', 'fleece', '内搭'] },
  { label: '极简基础', terms: ['基础款', '极简', '简约', '百搭', '黑白灰', '胶囊'] },
  { label: '情侣/男女同款', terms: ['情侣', '男生', '女生', '男女', '男友', '女友', '同款'] },
];

const SCENE_RULES = [
  { label: '公园/树林', terms: ['公园', '树林', '森林', '草地', '湖边', '河边'] },
  { label: '山路/徒步', terms: ['山', '徒步', '登山', '爬山', '步道'] },
  { label: '露营', terms: ['露营', '营地', '帐篷', 'camping'] },
  { label: '街拍/城市', terms: ['街拍', '街头', '城市', 'citywalk', '咖啡', '书店'] },
  { label: '居家/镜子自拍', terms: ['居家', '镜子', '自拍', '试穿', '上身'] },
  { label: '旅行', terms: ['旅行', '旅游', '出游', '机场', '自驾'] },
];

const ITEM_RULES = [
  { label: '冲锋衣/硬壳', terms: ['冲锋衣', '硬壳', 'hardshell', 'shell', '防水'] },
  { label: '抓绒/摇粒绒', terms: ['抓绒', '摇粒绒', 'fleece', 'synchilla'] },
  { label: '羽绒/棉服', terms: ['羽绒', '棉服', '保暖', 'down'] },
  { label: '背心/马甲', terms: ['背心', '马甲', 'vest'] },
  { label: 'T恤/卫衣', terms: ['t恤', 'tee', '卫衣', 'hoodie', 'sweatshirt'] },
  { label: '工装裤/牛仔裤', terms: ['工装裤', '牛仔裤', '长裤', '短裤', 'denim', 'pants'] },
  { label: '帽子/包/鞋', terms: ['帽子', '包', '鞋', '斜挎', '托特', '腰包', 'cap', 'bag'] },
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePositiveInteger(value, fallback, optionName) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return parsed;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const keywordParts = [];
  let limit = DEFAULT_LIMIT;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--limit') {
      limit = parsePositiveInteger(args[index + 1], DEFAULT_LIMIT, '--limit');
      index += 1;
    } else if (arg.startsWith('--limit=')) {
      limit = parsePositiveInteger(arg.slice('--limit='.length), DEFAULT_LIMIT, '--limit');
    } else {
      keywordParts.push(arg);
    }
  }

  const keyword = keywordParts.join(' ').trim();
  if (!keyword) {
    throw new Error('Missing keyword. Usage: node analyze.js Patagonia --limit=200');
  }

  return { keyword, limit };
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseLikeCount(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) {
    return null;
  }

  const match = text.match(/([\d.]+)/);
  if (!match) {
    return null;
  }

  const number = Number.parseFloat(match[1]);
  if (!Number.isFinite(number)) {
    return null;
  }

  if (text.includes('万') || text.includes('w')) {
    return Math.round(number * 10000);
  }

  if (text.includes('k')) {
    return Math.round(number * 1000);
  }

  return Math.round(number);
}

function countMatches(notes, rules) {
  return rules
    .map((rule) => {
      const matchedNotes = notes.filter((note) => {
        const text = `${note.title || ''} ${note.raw_data && note.raw_data.card_text ? note.raw_data.card_text : ''}`.toLowerCase();
        return rule.terms.some((term) => text.includes(term.toLowerCase()));
      });

      return {
        label: rule.label,
        count: matchedNotes.length,
        examples: matchedNotes.slice(0, 3),
      };
    })
    .filter((item) => item.count > 0)
    .sort((left, right) => right.count - left.count);
}

function extractTitleTerms(notes, keyword) {
  const counts = new Map();
  const keywordLower = keyword.toLowerCase();

  for (const note of notes) {
    const title = normalizeText(note.title).toLowerCase();
    const tokens = title.match(/[a-z0-9]+|[\u4e00-\u9fa5]{2,}/g) || [];

    for (const token of tokens) {
      if (token === keywordLower || STOP_WORDS.has(token) || token.length < 2) {
        continue;
      }

      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([term, count]) => ({ term, count }))
    .sort((left, right) => right.count - left.count || left.term.localeCompare(right.term))
    .slice(0, 30);
}

function formatNoteLink(note) {
  const title = normalizeText(note.title) || '(no title)';
  return `[${title}](${note.url})`;
}

function formatExamples(examples) {
  if (!examples.length) {
    return '';
  }

  return examples.map((note) => `  - ${formatNoteLink(note)}`).join('\n');
}

function buildShootingIdeas(styleCounts, sceneCounts, itemCounts) {
  const topStyles = styleCounts.slice(0, 3).map((item) => item.label);
  const topScenes = sceneCounts.slice(0, 3).map((item) => item.label);
  const topItems = itemCounts.slice(0, 4).map((item) => item.label);

  const ideas = [];

  ideas.push({
    title: 'Look 1: 山系户外实穿',
    concept: '用 Patagonia 外套或抓绒搭配工装裤、徒步鞋和帽子，拍出真实户外活动感。',
    scene: topScenes.find((scene) => scene.includes('山') || scene.includes('公园') || scene.includes('露营')) || '公园/树林',
    shots: '全身走路照、拉链/袖口细节、背包或鞋子的局部特写。',
  });

  ideas.push({
    title: 'Look 2: 城市通勤户外风',
    concept: '把户外单品放进城市生活场景，弱化装备感，突出日常可穿。',
    scene: topScenes.find((scene) => scene.includes('街拍') || scene.includes('城市')) || '街拍/城市',
    shots: '街边全身照、咖啡店坐姿、过马路动态照。',
  });

  ideas.push({
    title: 'Look 3: 秋冬叠穿层次',
    concept: '用抓绒、卫衣、背心或冲锋衣做 2-3 层搭配，突出颜色和材质层次。',
    scene: topScenes[0] || '户外自然光',
    shots: '敞开外套半身照、内搭层次特写、同一件单品三套搭配。',
  });

  ideas.push({
    title: 'Look 4: 单品测评上身',
    concept: `围绕 ${topItems[0] || '核心单品'} 做“值得买吗/怎么搭”内容，强化实用参考价值。`,
    scene: '白墙、镜子、户外各一组',
    shots: '正面/侧面/背面上身、面料细节、口袋和版型展示。',
  });

  if (topStyles.includes('复古美式')) {
    ideas.push({
      title: 'Look 5: 复古美式户外',
      concept: '用宽松版型、牛仔裤、旧色系和生活化场景，拍出 vintage 感。',
      scene: '书店、老街、木质家具背景',
      shots: '坐姿半身照、logo 特写、复古配饰局部。',
    });
  }

  return ideas;
}

function sanitizeFilePart(value) {
  return normalizeText(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

function buildReport(keyword, notes) {
  const notesWithLikes = notes.map((note) => ({
    ...note,
    like_number: parseLikeCount(note.like_count),
  }));

  const styleCounts = countMatches(notesWithLikes, STYLE_RULES);
  const sceneCounts = countMatches(notesWithLikes, SCENE_RULES);
  const itemCounts = countMatches(notesWithLikes, ITEM_RULES);
  const titleTerms = extractTitleTerms(notesWithLikes, keyword);
  const shootingIdeas = buildShootingIdeas(styleCounts, sceneCounts, itemCounts);
  const topLikedNotes = notesWithLikes
    .filter((note) => note.like_number !== null)
    .sort((left, right) => right.like_number - left.like_number)
    .slice(0, 15);
  const latestNotes = notesWithLikes
    .slice()
    .sort((left, right) => new Date(right.crawled_at).getTime() - new Date(left.crawled_at).getTime())
    .slice(0, 20);

  const lines = [];
  lines.push(`# ${keyword} 小红书采集数据拍摄参考`);
  lines.push('');
  lines.push(`生成时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`样本数量：${notesWithLikes.length}`);
  lines.push('');
  lines.push('## 快速结论');
  lines.push('');
  lines.push(`- 高频风格：${styleCounts.slice(0, 5).map((item) => `${item.label}(${item.count})`).join('、') || '样本中暂未识别到明显风格词'}`);
  lines.push(`- 高频场景：${sceneCounts.slice(0, 5).map((item) => `${item.label}(${item.count})`).join('、') || '样本中暂未识别到明显场景词'}`);
  lines.push(`- 高频单品：${itemCounts.slice(0, 5).map((item) => `${item.label}(${item.count})`).join('、') || '样本中暂未识别到明显单品词'}`);
  lines.push('');
  lines.push('## 标题高频词');
  lines.push('');
  lines.push('| 词 | 出现次数 |');
  lines.push('| --- | ---: |');
  for (const item of titleTerms.slice(0, 20)) {
    lines.push(`| ${item.term} | ${item.count} |`);
  }
  lines.push('');
  lines.push('## 风格线索');
  lines.push('');
  for (const item of styleCounts) {
    lines.push(`### ${item.label} (${item.count})`);
    lines.push(formatExamples(item.examples));
    lines.push('');
  }
  lines.push('## 场景线索');
  lines.push('');
  for (const item of sceneCounts) {
    lines.push(`### ${item.label} (${item.count})`);
    lines.push(formatExamples(item.examples));
    lines.push('');
  }
  lines.push('## 单品线索');
  lines.push('');
  for (const item of itemCounts) {
    lines.push(`### ${item.label} (${item.count})`);
    lines.push(formatExamples(item.examples));
    lines.push('');
  }
  lines.push('## 拍摄方案草案');
  lines.push('');
  for (const idea of shootingIdeas) {
    lines.push(`### ${idea.title}`);
    lines.push(`- 概念：${idea.concept}`);
    lines.push(`- 场景：${idea.scene}`);
    lines.push(`- 镜头：${idea.shots}`);
    lines.push('');
  }
  lines.push('## 点赞较高的参考笔记');
  lines.push('');
  lines.push('| 点赞 | 标题 | 链接 |');
  lines.push('| ---: | --- | --- |');
  for (const note of topLikedNotes) {
    lines.push(`| ${note.like_count || ''} | ${normalizeText(note.title) || '(no title)'} | ${note.url} |`);
  }
  lines.push('');
  lines.push('## 最近采集的笔记');
  lines.push('');
  lines.push('| 采集时间 | 标题 | 链接 |');
  lines.push('| --- | --- | --- |');
  for (const note of latestNotes) {
    lines.push(`| ${note.crawled_at || ''} | ${normalizeText(note.title) || '(no title)'} | ${note.url} |`);
  }
  lines.push('');
  lines.push('## 使用提醒');
  lines.push('');
  lines.push('- 这些结论来自搜索结果页公开卡片，不代表全平台真实排名。');
  lines.push('- 建议打开高相关笔记链接，看正文、评论和封面细节后再定最终拍摄脚本。');
  lines.push('- 避免照搬封面和文案，把它们当作风格参考。');

  return lines.join('\n');
}

async function fetchNotes(supabase, keyword, limit) {
  const { data, error } = await supabase
    .from('xhs_notes')
    .select('keyword,title,url,author_name,like_count,cover_url,raw_data,crawled_at')
    .eq('keyword', keyword)
    .order('crawled_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return data || [];
}

async function main() {
  try {
    const { keyword, limit } = parseArgs();
    const supabase = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const notes = await fetchNotes(supabase, keyword, limit);
    if (!notes.length) {
      throw new Error(`No notes found for keyword "${keyword}". Run node crawl.js ${keyword} first.`);
    }

    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const filename = `xhs-analysis-${sanitizeFilePart(keyword)}-${new Date().toISOString().slice(0, 10)}.md`;
    const reportPath = path.join(REPORT_DIR, filename);
    const report = buildReport(keyword, notes);

    fs.writeFileSync(reportPath, report, 'utf8');
    console.log(`Analyzed ${notes.length} notes for "${keyword}".`);
    console.log(`Report written to ${reportPath}`);
  } catch (error) {
    console.error('Analysis failed.');
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

main();
