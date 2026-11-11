/**
 * 技能与插件说明汉化（扫文件夹版，不用写死名单）
 *
 * 做法：
 * 1. 扫 .gemini 下面 4 个目录里的技能与插件；
 * 2. 读每个 SKILL.md 的 description、每个 plugin.json 的 displayName 与 description；
 * 3. 判断是不是英文（有英文字母、没有中文）；
 * 4. 翻过的查本地词典 learned.json，有就直接用；
 * 5. 没翻过的列入待翻译清单，打印出来，留给运行本工具的模型翻译；
 *    脚本自己不编造翻译；
 * 6. 模型翻完后，把翻译写成 JSON 文件，用 --apply 写回去，同时记进 learned.json。
 *
 * 只改说明文字，不改代码，不改配置。写之前先备份（.orig），重复执行安全。
 * 改的是用户配置目录（.gemini）下的文件，不碰 Antigravity 安装目录。
 *
 * 用法：
 *   node src/system/localize-skills.js              扫描并应用已翻过的，列出待翻译清单
 *   node src/system/localize-skills.js --apply 翻译.json   把翻译写回去并记进词典
 * 翻译.json 的格式：{ "英文原文": "中文", ... }
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const LEARNED_PATH = path.join(__dirname, '..', 'i18n', 'learned.json');

/**
 * 4 个目标目录（都在用户主目录下）
 */
function getTargetDirs() {
  const userProfile = process.env.USERPROFILE || os.homedir();
  return {
    builtinSkills: path.join(userProfile, '.gemini', 'antigravity', 'builtin', 'skills'),
    builtinPlugins: path.join(userProfile, '.gemini', 'antigravity', 'builtin', 'plugins'),
    configSkills: path.join(userProfile, '.gemini', 'config', 'skills'),
    configPlugins: path.join(userProfile, '.gemini', 'config', 'plugins')
  };
}

/**
 * 判断一段文字是不是英文：有英文字母、没有中文，就是英文
 */
function isEnglish(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  if (/[\u4e00-\u9fa5]/.test(t)) return false;
  return /[a-zA-Z]/.test(t);
}

/**
 * 读本地已翻过的词典（英文原文 -> 中文）
 */
function loadLearned() {
  try {
    if (!fs.existsSync(LEARNED_PATH)) return {};
    const data = JSON.parse(fs.readFileSync(LEARNED_PATH, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    return {};
  }
}

function saveLearned(map) {
  fs.mkdirSync(path.dirname(LEARNED_PATH), { recursive: true });
  fs.writeFileSync(LEARNED_PATH, JSON.stringify(map, null, 2), 'utf8');
}

/**
 * 从 SKILL.md 内容里取出 description 的值
 */
function extractSkillDescription(content) {
  const re = /description:\s*(?:>-\s*)?([\s\S]*?)(?=\n[a-z0-9_-]+:|\n---)/i;
  const m = content.match(re);
  if (!m) return null;
  return m[1].replace(/\s+/g, ' ').trim();
}

/**
 * 改写 SKILL.md 的 description，改前先备份（.orig，有备份就不再备）
 */
function updateSkillDescription(filePath, newDesc) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  if (content.includes(newDesc)) return false;

  const reDesc = /description:\s*(?:>-\s*)?([\s\S]*?)(?=\n[a-z0-9_-]+:|\n---)/i;
  if (!reDesc.test(content)) return false;

  const origPath = filePath + '.orig';
  if (!fs.existsSync(origPath)) {
    try { fs.copyFileSync(filePath, origPath); } catch (e) {}
  }

  const updated = content.replace(reDesc, `description: ${newDesc}`);
  fs.writeFileSync(filePath, updated, 'utf8');
  return true;
}

/**
 * 改写 plugin.json 的 displayName 与 description，改前先备份
 */
function updatePluginJson(filePath, meta) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(raw);
    let changed = false;

    if (meta.displayName && json.displayName !== meta.displayName) {
      json.displayName = meta.displayName;
      changed = true;
    }
    if (meta.description && json.description !== meta.description) {
      json.description = meta.description;
      changed = true;
    }

    if (changed) {
      const origPath = filePath + '.orig';
      if (!fs.existsSync(origPath)) {
        try { fs.copyFileSync(filePath, origPath); } catch (e) {}
      }
      fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf8');
      return true;
    }
  } catch (e) {}
  return false;
}

/**
 * 扫描 4 个目录，收集所有技能与插件的说明项
 * 返回：[{ kind: '技能'|'插件', name, file, field, text }]
 */
function collectItems() {
  const dirs = getTargetDirs();
  const items = [];

  // 技能：读 SKILL.md 的 description
  for (const dir of [dirs.builtinSkills, dirs.configSkills]) {
    if (!fs.existsSync(dir)) continue;
    for (const sub of fs.readdirSync(dir)) {
      const skillPath = path.join(dir, sub, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      try {
        const content = fs.readFileSync(skillPath, 'utf8');
        const desc = extractSkillDescription(content);
        if (desc) {
          items.push({ kind: '技能', name: sub, file: skillPath, field: 'description', text: desc });
        }
      } catch (e) {}
    }
  }

  // 插件：读 plugin.json 的 displayName 与 description
  for (const dir of [dirs.builtinPlugins, dirs.configPlugins]) {
    if (!fs.existsSync(dir)) continue;
    for (const sub of fs.readdirSync(dir)) {
      const pJson = path.join(dir, sub, 'plugin.json');
      if (!fs.existsSync(pJson)) continue;
      try {
        const json = JSON.parse(fs.readFileSync(pJson, 'utf8'));
        if (json.displayName) {
          items.push({ kind: '插件', name: sub, file: pJson, field: 'displayName', text: String(json.displayName) });
        }
        if (json.description) {
          items.push({ kind: '插件', name: sub, file: pJson, field: 'description', text: String(json.description) });
        }
      } catch (e) {}
    }
  }

  return items;
}

/**
 * 把翻译写回去（只写说明字段），同时记进 learned.json
 * translations：{ 英文原文: 中文 }
 */
function applyTranslations(translations) {
  const learned = loadLearned();
  const items = collectItems();
  let applied = 0;

  for (const [english, chinese] of Object.entries(translations)) {
    if (!english || !chinese) continue;
    const key = String(english).trim();
    const val = String(chinese).trim();
    if (!key || !val) continue;

    for (const item of items) {
      if (item.text.trim() !== key) continue;
      let changed = false;
      if (item.kind === '技能') {
        changed = updateSkillDescription(item.file, val);
      } else {
        const meta = {};
        meta[item.field] = val;
        changed = updatePluginJson(item.file, meta);
      }
      if (changed) {
        applied++;
        console.log(`  已汉化 [${item.kind}] ${item.name}：${item.field}`);
      }
    }
    learned[key] = val;
  }

  saveLearned(learned);
  return { applied, learnedCount: Object.keys(learned).length };
}

/**
 * 扫描并应用已翻过的，列出待翻译清单
 */
function run() {
  console.log('========================================');
  console.log('  技能与插件说明汉化（扫文件夹）');
  console.log('========================================\n');

  const learned = loadLearned();
  const items = collectItems();
  let scanned = 0;
  let applied = 0;
  const pendingMap = new Map();

  for (const item of items) {
    scanned++;
    if (!isEnglish(item.text)) continue;
    const key = item.text.trim();
    if (learned[key]) {
      let changed = false;
      if (item.kind === '技能') {
        changed = updateSkillDescription(item.file, learned[key]);
      } else {
        const meta = {};
        meta[item.field] = learned[key];
        changed = updatePluginJson(item.file, meta);
      }
      if (changed) {
        applied++;
        console.log(`  已汉化（用已翻过的记录）[${item.kind}] ${item.name}：${item.field}`);
      }
    } else if (!pendingMap.has(key)) {
      pendingMap.set(key, { kind: item.kind, name: item.name, field: item.field, text: key });
    }
  }

  const pending = Array.from(pendingMap.values());
  console.log(`\n  扫描：${scanned} 项说明；已用词典汉化：${applied} 项；待翻译：${pending.length} 项。`);

  if (pending.length > 0) {
    console.log('\n----- 待翻译清单（请运行本工具的模型翻译后，用 --apply 写回）-----');
    console.log(JSON.stringify(pending, null, 2));
    console.log('----- 清单结束 -----');
    console.log('\n  翻译办法：把上面清单里的英文翻成中文，写成 JSON 文件（格式 {"英文原文": "中文"}），');
    console.log('  再执行 node src/system/localize-skills.js --apply 翻译.json，翻完会自动记进词典。');
  } else {
    console.log('\n  没有待翻译的英文说明，全部已是中文。');
  }

  console.log('\n========================================');
  console.log('  技能与插件说明汉化完成');
  console.log('========================================');

  return { ok: true, scanned, applied, pending: pending.length };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const applyIdx = args.indexOf('--apply');
  if (applyIdx !== -1 && args[applyIdx + 1]) {
    const file = args[applyIdx + 1];
    try {
      const map = JSON.parse(fs.readFileSync(file, 'utf8'));
      const res = applyTranslations(map);
      console.log(`\n已写回 ${res.applied} 项，本地词典现有 ${res.learnedCount} 条。`);
    } catch (e) {
      console.error('读取翻译文件失败：' + e.message);
      process.exitCode = 1;
    }
  } else {
    run();
  }
}

module.exports = { run, applyTranslations, collectItems, isEnglish, loadLearned, getTargetDirs };
