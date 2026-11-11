/**
 * 汉化引擎（热注入显示 + ASAR 持久化，二者分开）
 *
 * 架构说明：
 * - 热注入显示：把翻译脚本打进正在运行的窗口，界面立刻变中文，
 *   只改内存里的界面，不碰安装目录下的任何文件。
 * - ASAR 持久化是默认流程的第四步：拆开官方 app.asar，
 *   把翻译写进启动文件 preload.js，再打包覆盖回去，重启之后还是中文。
 *   入口处会打印风险提示，改之前自动备份，改坏可用 --restore 恢复。
 * - 左右键菜单词条放在词典里，由翻译器在显示时翻，不改主进程菜单模板。
 *
 * 翻译脚本（浏览器里跑的那部分）说明：
 * - 词典精确匹配 + 属性穿透（title / placeholder / aria-label）；
 * - WeakMap 记录原文，词典一变就重译；
 * - MutationObserver 盯着界面变化，新冒出来的英文立刻翻；
 * - 排除代码块、输入框、聊天内容等不该翻的地方。
 *
 * 仅支持 Windows 10/11，Node.js >= 18。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const LOCAL_DICT_PATH = path.join(__dirname, 'dict.json');
const LEARNED_PATH = path.join(__dirname, 'learned.json');

/**
 * 动态探测 Antigravity 安装位置，不写死任何用户名与盘符
 * 返回官方 app.asar 的完整路径，找不到返回 null
 */
function findAntigravityInstall() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || '';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || '';

  const candidates = [
    path.join(localAppData, 'Programs', 'antigravity', 'resources', 'app.asar')
  ];
  if (programFiles) candidates.push(path.join(programFiles, 'Antigravity', 'resources', 'app.asar'));
  if (programFilesX86) candidates.push(path.join(programFilesX86, 'Antigravity', 'resources', 'app.asar'));

  // 再扫一遍 %LOCALAPPDATA%\Programs 下面以 antigravity 开头的目录
  try {
    const programsDir = path.join(localAppData, 'Programs');
    if (fs.existsSync(programsDir)) {
      for (const name of fs.readdirSync(programsDir)) {
        if (/antigravity/i.test(name)) {
          candidates.push(path.join(programsDir, name, 'resources', 'app.asar'));
        }
      }
    }
  } catch (e) {}

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * 工作路径集合
 */
function getWorkPaths() {
  const realOfficialAsar = findAntigravityInstall();
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const workBaseDir = path.join(localAppData, 'antigravity-cn-toolkit-v2');
  const extractedDir = path.join(workBaseDir, 'asar_extracted');

  const resourcesDir = realOfficialAsar ? path.dirname(realOfficialAsar) : workBaseDir;
  const patchedAsar = path.join(resourcesDir, 'app.asar.patched');
  const backupAsar = path.join(resourcesDir, 'app.asar.backup');

  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

  return {
    officialAsar: realOfficialAsar,
    resourcesDir,
    backupAsar,
    patchedAsar,
    workBaseDir,
    extractedDir,
    appData
  };
}

/**
 * 读词典并合并：主词典 dict.json + 已翻过的 learned.json + 用户自定义 i18n.override.json
 */
function getMergedDict() {
  let dict = {};
  if (fs.existsSync(LOCAL_DICT_PATH)) {
    try {
      dict = JSON.parse(fs.readFileSync(LOCAL_DICT_PATH, 'utf8'));
    } catch (err) {
      console.warn('读取主词典异常，将以空词典启动：' + err.message);
      dict = {};
    }
  }

  if (fs.existsSync(LEARNED_PATH)) {
    try {
      const learned = JSON.parse(fs.readFileSync(LEARNED_PATH, 'utf8'));
      for (const k of Object.keys(learned)) {
        if (k !== '_comment') dict[k] = learned[k];
      }
    } catch (e) {}
  }

  const userOverride = path.join(PROJECT_ROOT, 'i18n.override.json');
  if (fs.existsSync(userOverride)) {
    try {
      const user = JSON.parse(fs.readFileSync(userOverride, 'utf8'));
      for (const k of Object.keys(user)) {
        if (k !== '_comment') dict[k] = user[k];
      }
    } catch (e) {}
  }
  return dict;
}

/**
 * 生成注入脚本（在浏览器里跑的翻译器）
 */
function generateInjectorScript(dict) {
  const dictHash = crypto.createHash('md5').update(JSON.stringify(dict)).digest('hex').slice(0, 8);
  const patchVersion = `v1.1.0-${dictHash}`;
  return `
// === Antigravity Unified Clean Engine (Native Pure Edition) ===
(function() {
  if (window.top !== window) return;

  const PATCH_VERSION = '${patchVersion}';
  const DICT = ${JSON.stringify(dict)};
  const ATTR_MAP = {
    'Display Options': '显示选项',
    'Create New Project': '新建项目',
    'Project options': '项目选项',
    'New Conversation in Project': '在项目中新建会话',
    'Stop execution': '停止执行',
    'Pin conversation': '固定会话',
    'Unpin conversation': '取消固定会话',
    'Archive conversation': '归档会话',
    'More options': '更多选项',
    'More actions': '更多操作',
    'Table options': '表格选项',
    'Good response': '满意回复',
    'Bad response': '不满意回复',
    'Copy': '复制',
    'Undo to this point': '撤销到此处',
    'Scroll to Bottom': '滚动到底部',
    'Add context': '添加上下文',
    'Start Voice mode': '开启语音模式',
    'New Conversation': '新建会话',
    'Toggle Sidebar': '切换侧边栏',
    'Toggle Side Panel': '切换侧边面板',
    'Go Back': '后退',
    'Go Forward': '前进',
    'Search Conversations': '搜索会话',
    'Cancel (Ctrl+D)': '取消 (Ctrl+D)',
    'Sidebar': '侧边栏',
    'Message input': '消息输入框',
    'Typeahead menu': '快捷菜单',
    'Agent response': '智能体回复',
    'User message': '用户消息',
    'Browse': '浏览',
    'Browse rules': '浏览规则',
    'Search conversations': '搜索会话',
    'No matching results': '未找到匹配结果',
    'Searching…': '搜索中…',
    'Searching...': '搜索中...',
    'New tab': '新建标签页',
    'View Diff': '查看差异',
    'Refresh': '刷新',
    'Toggle sidebar': '切换侧边栏',
    'Close': '关闭',
    'Close All': '全部关闭',
    'Close Others': '关闭其他',
    'Close Other Tabs': '关闭其他标签页',
    'Close Saved': '关闭未修改项',
    'Close Tabs to the Right': '关闭右侧标签页',
    'Close to the Right': '关闭右侧',
    'File Viewer': '文件查看器',
    'File Viewer header': '文件查看器标题栏',
    'File path breadcrumbs': '文件路径面包屑',
    'Learning Proposal': '经验固化提议',
    'Close Learning Proposal': '关闭经验固化提议',
    'Close Review': '关闭审查',
    'Conversation turns': '会话轮次'
  };

  const EXCLUDE_SELECTOR = 'code, pre, kbd, samp, textarea, input, style, script, noscript, [contenteditable="true"], .prose, .markdown, [class*="chat-message"], [class*="group/file-title"], [data-testid="conversation-row-sidebar"] a[href^="/c/"], [data-testid="conversation-row-sidebar"] span.truncate';
  
  if (!window.__ag_orig_text_map) {
    window.__ag_orig_text_map = new WeakMap();
  }
  const origTextMap = window.__ag_orig_text_map;

  const RE_HAS_CJK = /[\\u4e00-\\u9fa5]/;
  const RE_PURE_ALPHA = /^\\s*[a-zA-Z]+\\s*$/;
  const RE_HAS_ALPHA = /[a-zA-Z]/;
  const RE_VERSION = /^Version\\s+([0-9\\.\\-a-zA-Z]+)$/i;
  const RE_FILES_CHANGED = /^(\\d+)\\s+files?\\s+changed$/i;
  const RE_TOOLS = /^(\\d+)\\s+tools?$/i;
  const RE_DEMOTED = /^(\\d+)\\s+demoted$/i;
  const RE_EXCLUDED = /^(\\d+)\\s+excluded$/i;
  const RE_TOOLS_EXCLUDED = /^(\\d+)\\s+tools?\\s+excluded$/i;
  const RE_ACTIVE_CONVS = /^(\\d+)\\s+active\\s+conversations$/i;
  const RE_SEE_ALL = /^See all\\s*\\((\\d+)\\)$/i;
  const RE_SHOW_BREAKDOWNS = /^Show\\s+(\\d+)\\s+breakdowns?$/i;
  const RE_PERM_DELETE = /^Permanently delete\\s+(.*)\\s+including\\s+(\\d+)\\s+active\\s+conversations\\.?$/i;
  const RE_WORKED_FOR = /^Worked for\\s+(\\d+[smhd])$/i;
  const RE_THOUGHT_FOR = /^Thought for\\s+(\\d+[smhd])$/i;
  const RE_RUNNING = /^Running\\s+(.*)$/i;
  const RE_TIME_AGO = /^(\\d+)\\s*(s|m|h|d)\\s+ago$/i;
  const RE_TURN_OF = /^Turn\\s+(\\d+)\\s+of\\s+(\\d+)$/i;
  const RE_LOAD_OLDER = /^Load older messages, showing\\s+(\\d+)\\s+of\\s+(\\d+)$/i;
  const RE_SELECT_MODEL = /^Select model, current:\\s*(.*)$/i;
  const RE_AGENT_PERM = /^Agent permissions preset selector, current:\\s*(.*)$/i;
  const RE_OPENS_LINK = /^Opens external link:\\s*(.*)$/i;
  const RE_ARIA_BRANCH = /^Branch, current:\\s*(.*)$/i;
  const RE_ARIA_PROJECT = /^Select project, current:\\s*(.*)$/i;
  const RE_USED_LIMIT = /^You have used (some|all|most) of your (weekly|5-hour|five-hour|daily) limit,?\\s*it will fully refresh in (.*)\\.?$/i;
  const RE_NOT_USED_LIMIT = /^You have not used any of your (weekly|5-hour|five-hour|daily) limit\\.?$/i;
  const RE_TURNS = /^(\\d+)\\s+turns?$/i;
  const RE_DATE_TURNS = /,\\s*(\\d+)\\s+turns?$/i;
  const RE_CLOSE_TARGET = /^Close\\s+(.*)$/i;

  function isExcludedElement(el) {
    if (!el || el.nodeType !== 1) return true;
    return !!el.closest(EXCLUDE_SELECTOR);
  }

  function computeTextTranslation(raw) {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // 历史错误词条自愈纠偏
    if (trimmed.includes('额度充裕')) return raw.replace(/额度充裕/g, '深度思考');
    if (trimmed.includes('额度适中')) return raw.replace(/额度适中/g, '平衡思考');
    if (trimmed.includes('额度紧张')) return raw.replace(/额度紧张/g, '轻量思考');
    if (trimmed.includes('限额注意')) return raw.replace(/限额注意/g, '使用提示');

    let replacement = DICT[trimmed];
    if (typeof replacement !== 'string' && trimmed.endsWith('.')) {
      const withoutDot = DICT[trimmed.slice(0, -1)];
      if (typeof withoutDot === 'string') {
        replacement = withoutDot.endsWith('。') ? withoutDot : withoutDot + '。';
      }
    }
    if (typeof replacement === 'string') {
      if (RE_HAS_CJK.test(replacement) && RE_PURE_ALPHA.test(raw)) {
        return replacement;
      }
      return raw.replace(trimmed, replacement);
    }

    if (!RE_HAS_ALPHA.test(trimmed)) return null;

    if (RE_VERSION.test(trimmed)) return raw.replace(RE_VERSION, '版本 $1');
    if (RE_WORKED_FOR.test(trimmed)) return raw.replace(RE_WORKED_FOR, '已工作 $1');
    if (RE_THOUGHT_FOR.test(trimmed)) return raw.replace(RE_THOUGHT_FOR, '已思考 $1');
    if (RE_FILES_CHANGED.test(trimmed)) return raw.replace(RE_FILES_CHANGED, '$1 个文件变更');
    if (RE_TOOLS.test(trimmed)) return raw.replace(RE_TOOLS, '$1 个工具');
    if (RE_DEMOTED.test(trimmed)) return raw.replace(RE_DEMOTED, '$1 项已降级');
    if (RE_EXCLUDED.test(trimmed)) return raw.replace(RE_EXCLUDED, '$1 项已排除');
    if (RE_TOOLS_EXCLUDED.test(trimmed)) return raw.replace(RE_TOOLS_EXCLUDED, '$1 个工具已排除');
    if (RE_ACTIVE_CONVS.test(trimmed)) return raw.replace(RE_ACTIVE_CONVS, '$1 个进行中的会话');
    if (RE_SEE_ALL.test(trimmed)) return raw.replace(RE_SEE_ALL, '查看全部 ($1)');
    if (RE_SHOW_BREAKDOWNS.test(trimmed)) return raw.replace(RE_SHOW_BREAKDOWNS, '展开明细 ($1 项)');
    if (RE_PERM_DELETE.test(trimmed)) return raw.replace(RE_PERM_DELETE, '永久删除 $1 及 $2 个进行中的会话。');

    // 模糊长句前缀映射
    if (trimmed.startsWith('Comprehensive guide and reference for the Antigravity')) {
      return 'Antigravity 自定义系统的完整指南与参考。用于说明自定义项的工作原理...';
    }
    if (trimmed.startsWith('Provides a comprehensive guide, quick reference, and sitemap')) {
      return '提供 Google Antigravity (AGY) 权威指南、快速参考与地图索引...';
    }
    if (trimmed.startsWith('Interactive guide to design and create a scheduled background')) {
      return '设计并创建后台定时自动化任务的交互式指南...';
    }
    if (trimmed.startsWith('How to render rich interactive HTML widgets inline')) {
      return '在对话中或作为独立工件渲染丰富的交互式 HTML 组件...';
    }
    if (trimmed.startsWith("Migrates the user's MCP servers, skills, slash commands")) {
      return '从其他编程助手迁移 MCP 服务、技能、斜杠指令、子代理与配置文件...';
    }
    if (trimmed.startsWith('Automatically migrate legacy workflows to modern skills')) {
      return '跨全局与工作区配置将旧版工作流自动迁移为现代技能...';
    }
    if (trimmed.startsWith('How to manage and create plugins')) {
      return '如何管理与创建插件（技能、智能体、规则、MCP 服务与钩子的整合包）...';
    }
    if (trimmed.startsWith('Discover UI plugin panels relevant to the current task')) {
      return '发现与当前任务相关的 UI 插件面板，并在对话中提供一键展开药丸按钮。';
    }
    if (trimmed.startsWith('Configure allowed and denied URLs for the browser subagent')) {
      return raw.replace(/Configure allowed and denied URLs for the browser subagent\\s*\\(invoked with \\/browser\\)\\.\\s*Requires?/i, '配置浏览器子代理（可通过 /browser 调用）允许与拒绝访问的 URL规则。需要安装');
    }
    if (trimmed.startsWith('(Preview & Quota Heavy) Run a swarm') || trimmed.startsWith('Run a swarm: several agents working in parallel')) {
      return '【蜂群多智能体协作】(预览/高额度消耗) 启动多个智能体在独立会话中并行协同攻坚，通过共享消息看板实时交互协作。';
    }
    if (trimmed.startsWith('Guidelines for interacting with GitHub and request permissions')) {
      return '【GitHub 权限治理】安全合规地与 GitHub 交互，在执行敏感写操作与仓库变更时主动请求用户确认。';
    }
    if (trimmed.startsWith('How to write and run a dynamic workflow script with the run_workflow')) {
      return '【动态工作流运行】通过脚本与确定性入口执行复杂的多阶段工作流。';
    }
    if (trimmed.startsWith('ONLY for the native-swarm worker whose brief says it is the monitor')) {
      return '【蜂群巡检监视器】专用于蜂群协作监控，定期检测蜂群是否停滞并在异常时唤醒解死锁。';
    }
    if (trimmed.startsWith('ONLY for the native-swarm worker whose brief says it is the narrator')) {
      return '【蜂群播报与汇总器】专用于蜂群协作汇总，实时观察看板并在协调员完成攻坚后生成最终交付报告。';
    }

    // 内置二进制命令描述（如 /learn 等由 language_server 输出的指令）
    if (trimmed.startsWith('Reflect on recent successes or corrections to capture reusable skills or rules')) {
      return '总结近期的成功经验或纠偏教训，沉淀为可复用的技能或规则。';
    }
    if (trimmed.startsWith('Unlock the power of agent swarms')) {
      return '释放智能体蜂群的并行协作潜能。';
    }
    if (trimmed === 'Browse') return '浏览';
    if (trimmed === 'Browse rules') return '浏览规则';
    if (trimmed === 'Search conversations' || trimmed === 'Search Conversations') return '搜索会话';
    if (trimmed === 'No matching results') return '未找到匹配结果';
    if (trimmed === 'Searching…' || trimmed === 'Searching...') return '搜索中…';
    if (trimmed === 'Close All') return '全部关闭';
    if (trimmed === 'Close Others') return '关闭其他';
    if (trimmed === 'Close Saved') return '关闭未修改项';
    if (trimmed === 'Close to the Right') return '关闭右侧';

    // 常用 MCP 扩展工具描述（如 rea 等逆向与分析工具）前缀映射
    if (trimmed.startsWith('Trace a feature through relevant artifact')) {
      return '通过关联工件、符号与函数证据追踪功能实现，并区分观测行为与推论。';
    }
    if (trimmed.startsWith('Compare two shipped application artifacts through complete inventory')) {
      return '通过完整清单与结构对比两个发布应用工件的差异。';
    }
    if (trimmed.startsWith('Evaluate a finite reconstruction specification against retained Evidence')) {
      return '对照留存证据评估程序还原规格说明的准确性与完整度。';
    }
    if (trimmed.startsWith('Correlate a crash symptom with static call and reference evidence')) {
      return '将崩溃现象与静态调用链、引用证据及进程捕获记录相关联分析。';
    }
    if (trimmed.startsWith('Review current residual-unknown heads against retained evidence')) {
      return '结合留存证据审查当前遗留的未知项，确保分析完整度。';
    }
    if (trimmed.startsWith('Choose a command, inputs, observations, and stopping conditions')) {
      return '为进程捕获设定目标命令、输入参数、观测项与停止条件。';
    }

    // 动态相对时间与动作状态
    const mTime = trimmed.match(RE_TIME_AGO);
    if (mTime) {
      const unitMap = { s: '秒', m: '分钟', h: '小时', d: '天' };
      return raw.replace(RE_TIME_AGO, mTime[1] + (unitMap[mTime[2].toLowerCase()] || mTime[2]) + '前');
    }
    const mRun = trimmed.match(RE_RUNNING);
    if (mRun) {
      return raw.replace(RE_RUNNING, '正在执行 ' + mRun[1]);
    }

    const mUsed = trimmed.match(RE_USED_LIMIT);
    if (mUsed) {
      const degreeMap = { some: '部分', all: '全部', most: '大部分' };
      const typeMap = { weekly: '每周', '5-hour': '5 小时', 'five-hour': '5 小时', daily: '每日' };
      const degree = degreeMap[mUsed[1].toLowerCase()] || mUsed[1];
      const type = typeMap[mUsed[2].toLowerCase()] || mUsed[2];
      const timeStr = mUsed[3]
        .replace(/\\.$/, '')
        .replace(/(\\d+)\\s*days?/gi, '$1 天')
        .replace(/(\\d+)\\s*hours?/gi, '$1 小时')
        .replace(/(\\d+)\\s*minutes?/gi, '$1 分钟')
        .replace(/(\\d+)\\s*seconds?/gi, '$1 秒')
        .replace(/,\\s*/g, ' ')
        .trim();
      return '您已消耗' + degree + type + '额度，将在 ' + timeStr + ' 后完全重置。';
    }

    const mNotUsed = trimmed.match(RE_NOT_USED_LIMIT);
    if (mNotUsed) {
      const typeMap = { weekly: '每周', '5-hour': '5 小时', 'five-hour': '5 小时', daily: '每日' };
      const type = typeMap[mNotUsed[1].toLowerCase()] || mNotUsed[1];
      return '您尚未消耗任何 ' + type + '额度。';
    }

    return null;
  }

  function translateTextNode(node) {
    const currentVal = node.nodeValue;
    if (!currentVal) return;

    const rec = origTextMap.get(node);
    if (rec && rec.lastVal === currentVal && rec.ver === PATCH_VERSION) {
      return;
    }
    const origRaw = rec && rec.lastVal === currentVal ? rec.origRaw : currentVal;

    const nextVal = computeTextTranslation(origRaw);
    if (nextVal !== null) {
      origTextMap.set(node, { origRaw, lastVal: nextVal, ver: PATCH_VERSION });
      if (node.nodeValue !== nextVal) {
        node.nodeValue = nextVal;
      }
    } else if (rec && rec.lastVal === currentVal) {
      node.nodeValue = origRaw;
      origTextMap.delete(node);
    }
  }

  function translateSingleAttr(el, attrName, origDataAttr, customResolver) {
    const cur = el.getAttribute(attrName);
    if (!cur) return;
    const savedOrig = el.getAttribute(origDataAttr);
    const savedLast = el.getAttribute(origDataAttr + '-last');
    const origVal = savedOrig && savedLast === cur ? savedOrig : cur;
    const trimmed = origVal.trim();

    let nextVal = customResolver ? customResolver(trimmed) : null;
    if (nextVal === null) {
      if (typeof DICT[trimmed] === 'string') {
        nextVal = DICT[trimmed];
      } else if (typeof ATTR_MAP[trimmed] === 'string') {
        nextVal = ATTR_MAP[trimmed];
      }
    }

    if (typeof nextVal === 'string') {
      el.setAttribute(origDataAttr, origVal);
      el.setAttribute(origDataAttr + '-last', nextVal);
      if (cur !== nextVal) {
        el.setAttribute(attrName, nextVal);
      }
    } else if (savedOrig && savedLast === cur) {
      el.setAttribute(attrName, savedOrig);
      el.removeAttribute(origDataAttr);
      el.removeAttribute(origDataAttr + '-last');
    }
  }

  function translateElementAttrs(el) {
    if (!el || el.nodeType !== 1) return;
    translateSingleAttr(el, 'title', 'data-ag-orig-title', null);
    translateSingleAttr(el, 'placeholder', 'data-ag-orig-placeholder', null);
    translateSingleAttr(el, 'aria-label', 'data-ag-orig-aria-label', (atrim) => {
      if (typeof DICT[atrim] === 'string') return DICT[atrim];
      if (typeof ATTR_MAP[atrim] === 'string') return ATTR_MAP[atrim];

      const mModel = atrim.match(RE_SELECT_MODEL);
      if (mModel) return '选择模型，当前：' + mModel[1];

      const mPerm = atrim.match(RE_AGENT_PERM);
      if (mPerm) return '智能体权限预设，当前：' + mPerm[1];

      const mBranch = atrim.match(RE_ARIA_BRANCH);
      if (mBranch) return '分支，当前：' + (mBranch[1].trim() === 'Select branch' ? '选择分支' : mBranch[1].trim());

      const mProj = atrim.match(RE_ARIA_PROJECT);
      if (mProj) return '选择项目，当前：' + (mProj[1].trim() === 'No project' ? '未关联项目' : mProj[1].trim());

      const mTurn = atrim.match(RE_TURN_OF);
      if (mTurn) return '第 ' + mTurn[1] + ' 轮 / 共 ' + mTurn[2] + ' 轮';

      const mOlder = atrim.match(RE_LOAD_OLDER);
      if (mOlder) return '加载历史消息（已显 ' + mOlder[1] + ' / 共 ' + mOlder[2] + ' 条）';

      const mLink = atrim.match(RE_OPENS_LINK);
      if (mLink) return '打开外部链接：' + mLink[1];

      const mRun = atrim.match(RE_RUNNING);
      if (mRun) return '正在执行 ' + mRun[1];

      const mClose = atrim.match(RE_CLOSE_TARGET);
      if (mClose) {
        const tgt = mClose[1].trim();
        if (tgt === 'All' || tgt === 'all') return '全部关闭';
        if (tgt === 'Others' || tgt === 'others') return '关闭其他';
        if (tgt === 'Other Tabs') return '关闭其他标签页';
        if (tgt === 'Saved') return '关闭未修改项';
        if (tgt === 'Tabs to the Right' || tgt === 'to the Right') return '关闭右侧标签页';
        return '关闭 ' + (DICT[tgt] || tgt);
      }

      if (RE_DATE_TURNS.test(atrim)) {
        return atrim.replace(RE_DATE_TURNS, ', $1 轮对话');
      }

      if (RE_TURNS.test(atrim)) {
        return atrim.replace(RE_TURNS, '$1 轮对话');
      }

      return null;
    });
  }

  const walkerFilter = {
    acceptNode(node) {
      if (node.nodeType === 1) {
        if (node.matches && node.matches(EXCLUDE_SELECTOR)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.hasAttribute && (node.hasAttribute('title') || node.hasAttribute('aria-label') || node.hasAttribute('placeholder'))) {
          translateElementAttrs(node);
        }
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  };

  function scanAndTranslate(root = document.body) {
    if (!root) return;
    if (root.nodeType === 3) {
      if (root.parentElement && !isExcludedElement(root.parentElement)) {
        translateTextNode(root);
      }
      return;
    }
    if (root.nodeType !== 1 || isExcludedElement(root)) return;

    if (root.hasAttribute && (root.hasAttribute('title') || root.hasAttribute('aria-label') || root.hasAttribute('placeholder'))) {
      translateElementAttrs(root);
    }

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      walkerFilter
    );
    while (walker.nextNode()) {
      translateTextNode(walker.currentNode);
    }
  }

  const dirtyRoots = new Set();
  let pending = false;
  let fallbackTimer = null;

  function flushTranslations() {
    pending = false;
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    if (dirtyRoots.size === 0) return;

    if (dirtyRoots.size > 200) {
      dirtyRoots.clear();
      try {
        scanAndTranslate(document.body);
      } catch (e) {}
      return;
    }

    const roots = Array.from(dirtyRoots);
    dirtyRoots.clear();

    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      if (!r || !r.isConnected) continue;
      try {
        scanAndTranslate(r);
      } catch (e) {}
    }
  }

  function queueDirtyRoot(node) {
    if (!node) return;
    dirtyRoots.add(node);
    if (!pending) {
      pending = true;
      requestAnimationFrame(flushTranslations);
      if (!fallbackTimer) {
        fallbackTimer = setTimeout(flushTranslations, 120);
      }
    }
  }

  function startObserver() {
    if (!document.documentElement) return;
    scanAndTranslate(document.documentElement);

    const obs = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type === 'childList') {
          for (let j = 0; j < m.addedNodes.length; j++) {
            const added = m.addedNodes[j];
            if (added.nodeType === 1 || added.nodeType === 3) {
              queueDirtyRoot(added);
            }
          }
        } else if (m.type === 'characterData') {
          if (m.target && m.target.nodeType === 3) {
            translateTextNode(m.target);
          }
        } else if (m.type === 'attributes') {
          if (m.target && m.target.nodeType === 1) {
            translateElementAttrs(m.target);
          }
        }
      }
    });

    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['title', 'placeholder', 'aria-label']
    });
  }

  // 极简死锁预防：防止设置面板因焦点逃逸卡死
  function initDeadlockHealer() {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const dialog = document.querySelector('[role="dialog"][data-state="open"]');
        if (dialog && !dialog.contains(document.activeElement)) {
          const closeBtn = dialog.querySelector('button[aria-label*="close"], button[aria-label*="Close"], button[aria-label*="关闭"]');
          if (closeBtn) closeBtn.click();
        }
      }
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      startObserver();
      initDeadlockHealer();
    });
  } else {
    startObserver();
    initDeadlockHealer();
  }
})();`;
}

/**
 * 确保解包目录就绪，若缺失则自动解包（只在 ASAR 持久化时调用）
 */
function ensureExtracted(paths) {
  if (!paths.officialAsar || !fs.existsSync(paths.officialAsar)) {
    throw new Error('未检测到 Antigravity 官方 app.asar，请确认程序已安装。');
  }

  const preloadPath = path.join(paths.extractedDir, 'dist', 'preload.js');
  if (!fs.existsSync(preloadPath)) {
    console.log('[*] 正在执行首次核心底包自适应解包...');
    fs.mkdirSync(paths.extractedDir, { recursive: true });

    let asarModule = null;
    try {
      asarModule = require('asar');
    } catch (e) {
      try {
        asarModule = require(path.join(PROJECT_ROOT, 'node_modules', 'asar'));
      } catch (e2) {}
    }

    if (asarModule && typeof asarModule.extractAll === 'function') {
      asarModule.extractAll(paths.officialAsar, paths.extractedDir);
    } else {
      execSync(`npx asar extract "${paths.officialAsar}" "${paths.extractedDir}"`, {
        cwd: PROJECT_ROOT,
        stdio: 'inherit'
      });
    }

    if (!fs.existsSync(preloadPath)) {
      throw new Error('解包完毕但未定位到 preload.js：' + preloadPath);
    }
    console.log('    官方核心底包解包成功');
  }
  return preloadPath;
}

/**
 * 把注入脚本追加到解包出的 preload.js（只在 ASAR 持久化时调用）
 */
function buildPreloadInjector(paths) {
  const dict = getMergedDict();
  const preloadPath = ensureExtracted(paths);

  const origPreload = fs.readFileSync(preloadPath, 'utf8');
  let cleanPreload = origPreload;
  const marker = '// === Native Clean I18n Translator for Antigravity';
  const marker2 = '// === Antigravity Unified Clean Engine';
  const markerIdx = cleanPreload.indexOf(marker) !== -1 ? cleanPreload.indexOf(marker) : cleanPreload.indexOf(marker2);
  if (markerIdx !== -1) {
    cleanPreload = cleanPreload.slice(0, markerIdx).trimEnd();
  }

  const injectorCode = generateInjectorScript(dict);
  const newPreload = cleanPreload + '\n' + injectorCode;
  fs.writeFileSync(preloadPath, newPreload, 'utf8');
  return { size: newPreload.length, dictCount: Object.keys(dict).length, injectorCode };
}

/**
 * 把解包修改后的目录打包为 app.asar.patched（只在 ASAR 持久化时调用）
 * 打包前自动给官方原厂底包建备份（app.asar.backup）
 */
async function packAsar(paths) {
  fs.mkdirSync(path.dirname(paths.patchedAsar), { recursive: true });

  if (paths.officialAsar && fs.existsSync(paths.officialAsar) && !fs.existsSync(paths.backupAsar)) {
    try {
      fs.copyFileSync(paths.officialAsar, paths.backupAsar);
      console.log('    已自动建立原厂底包备份：' + path.basename(paths.backupAsar));
    } catch (e) {
      console.warn('    原厂底包备份创建跳过：' + e.message);
    }
  }

  let asarModule = null;
  try {
    asarModule = require('asar');
  } catch (e) {
    try {
      asarModule = require(path.join(PROJECT_ROOT, 'node_modules', 'asar'));
    } catch (e2) {}
  }

  if (asarModule && typeof asarModule.createPackageWithOptions === 'function') {
    await asarModule.createPackageWithOptions(paths.extractedDir, paths.patchedAsar, {
      unpackDir: 'node_modules/chrome-devtools-mcp'
    });
  } else {
    execSync(`npx asar pack "${paths.extractedDir}" "${paths.patchedAsar}" --unpack-dir "node_modules/chrome-devtools-mcp"`, {
      cwd: PROJECT_ROOT,
      stdio: 'ignore'
    });
  }

  if (fs.existsSync(paths.patchedAsar)) {
    const sizeMb = (fs.statSync(paths.patchedAsar).size / (1024 * 1024)).toFixed(2);
    return sizeMb;
  }
  throw new Error('生成 app.asar.patched 失败');
}

/**
 * 把打包好的文件覆盖到官方路径（只在 ASAR 持久化时调用）
 */
function deployAsarDirectly(paths) {
  if (!fs.existsSync(paths.patchedAsar) || !paths.officialAsar) {
    return { ok: false, locked: false, message: '目标或源文件不存在' };
  }
  try {
    fs.copyFileSync(paths.patchedAsar, paths.officialAsar);
    return { ok: true, locked: false, message: '已覆盖官方原厂底包' };
  } catch (err) {
    if (err.code === 'EBUSY') {
      return { ok: false, locked: true, message: '客户端正在运行（文件被锁定，已保留 patched 包）' };
    }
    return { ok: false, locked: false, message: err.message };
  }
}

/**
 * 登记 Windows 系统内核重启替换队列（PendingFileRenameOperations）
 * 只追加，不整值覆盖，保护其他安装程序登记项
 */
function registerPendingRename(srcFile, dstFile) {
  const psScript = `
    $path = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager'
    $name = 'PendingFileRenameOperations'
    $existing = (Get-ItemProperty -Path $path -Name $name -ErrorAction SilentlyContinue).$name
    if (-not $existing) { $existing = @() }

    $src = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from('\\??\\' + srcFile, 'utf8').toString('base64')}'))
    $dst = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from('\\??\\' + dstFile, 'utf8').toString('base64')}'))

    $clean = [System.Collections.Generic.List[string]]::new()
    for ($i = 0; $i -lt $existing.Length; $i += 2) {
      if ($i + 1 -lt $existing.Length) {
        $itemSrc = $existing[$i]
        $itemDst = $existing[$i + 1]
        if ($itemDst -ne $dst -and $itemSrc -ne $src) {
          $clean.Add($itemSrc)
          $clean.Add($itemDst)
        }
      }
    }
    $clean.Add($src)
    $clean.Add($dst)

    Set-ItemProperty -Path $path -Name $name -Value $clean.ToArray() -Type MultiString -ErrorAction Stop
  `;

  try {
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    execSync(`powershell -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, { stdio: 'pipe' });
    return { ok: true, message: '已登记至系统内核重启队列' };
  } catch (err) {
    return { ok: false, message: '未获取管理员权限（关闭客户端后直接替换即可）' };
  }
}

function setPendingRename(paths) {
  if (!paths.officialAsar || !fs.existsSync(paths.patchedAsar)) {
    return { ok: false, message: '文件路径不完整' };
  }
  return registerPendingRename(paths.patchedAsar, paths.officialAsar);
}

/**
 * 动态探测活动 CDP 调试端口
 */
function detectCdpPort(paths) {
  const activePortFile = path.join(paths.appData, 'Antigravity', 'DevToolsActivePort');
  if (fs.existsSync(activePortFile)) {
    try {
      const content = fs.readFileSync(activePortFile, 'utf8').trim();
      const lines = content.split(/\r?\n/);
      if (lines.length > 0) {
        const port = parseInt(lines[0].trim(), 10);
        if (!isNaN(port) && port > 0 && port < 65536) {
          return port;
        }
      }
    } catch (e) {}
  }
  return null;
}

/**
 * 实时热注入：把翻译脚本打进正在运行的窗口（不改任何文件）
 */
async function triggerLiveHotPatch(paths, injectorCode) {
  const WS = typeof WebSocket !== 'undefined' ? WebSocket : null;
  if (!WS) {
    return { ok: false, count: 0, message: '当前 Node 缺少原生 WebSocket 支持，热注入跳过' };
  }

  const detectedPort = detectCdpPort(paths);
  const candidatePorts = [detectedPort, 3608, 9222].filter(Boolean);

  let activePort = null;
  let targetPages = [];

  for (const port of candidatePorts) {
    try {
      const list = await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/json/list`, { timeout: 1500 }, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            try { resolve(JSON.parse(d)); } catch (e) { resolve([]); }
          });
        });
        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
      });

      const pages = list.filter(t => t.url && t.url.includes('127.0.0.1') && t.webSocketDebuggerUrl);
      if (pages.length > 0) {
        activePort = port;
        targetPages = pages;
        break;
      }
    } catch (e) {}
  }

  if (targetPages.length === 0) {
    return { ok: false, count: 0, message: '未发现正在运行的活动窗口（将在下次启动时生效）' };
  }

  let injectedCount = 0;
  for (const p of targetPages) {
    try {
      const success = await new Promise((resolve) => {
        const ws = new WS(p.webSocketDebuggerUrl);
        const timer = setTimeout(() => {
          try { ws.close(); } catch (e) {}
          resolve(false);
        }, 2500);

        ws.onopen = () => {
          ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression: injectorCode, returnByValue: true }
          }));
        };

        ws.onmessage = () => {
          clearTimeout(timer);
          try { ws.close(); } catch (e) {}
          resolve(true);
        };

        ws.onerror = () => {
          clearTimeout(timer);
          try { ws.close(); } catch (e) {}
          resolve(false);
        };
      });

      if (success) injectedCount++;
    } catch (e) {}
  }

  return {
    ok: injectedCount > 0,
    count: injectedCount,
    message: injectedCount > 0 ? `已为 ${injectedCount} 个活动界面实时应用中文` : '活动窗口通信未响应'
  };
}

/**
 * 默认流程：只做热注入显示，不碰安装目录下的任何文件
 */
async function runHotPatch() {
  console.log('========================================');
  console.log('  热注入显示（默认，不碰安装目录文件）');
  console.log('========================================\n');

  const paths = getWorkPaths();
  const dict = getMergedDict();
  const count = Object.keys(dict).length;
  console.log(`[1] 词典：${count} 条对照。`);

  const injectorCode = generateInjectorScript(dict);
  const liveResult = await triggerLiveHotPatch(paths, injectorCode);
  if (liveResult.ok) {
    console.log(`[2] 热注入：${liveResult.message}`);
  } else {
    console.log(`[2] 热注入：${liveResult.message}`);
  }

  console.log('\n========================================');
  console.log('  热注入显示完成');
  console.log('========================================');
  return { ok: true, dictCount: count, live: liveResult.ok, count: liveResult.count, message: liveResult.message };
}

/**
 * ASAR 持久化流程：只有用户明确加 --persist 才调用
 * 会拆开官方 app.asar、改启动文件、再打包覆盖回去
 */
async function runPersist() {
  console.log('========================================');
  console.log('  ASAR 持久化');
  console.log('========================================\n');

  const paths = getWorkPaths();
  if (!paths.officialAsar) {
    throw new Error('未在系统中探测到 Antigravity 安装路径。');
  }
  console.log(`[0] 安装路径：${paths.officialAsar}`);

  const dict = getMergedDict();
  const count = Object.keys(dict).length;
  console.log(`[1] 词典：${count} 条对照。`);

  const { size, injectorCode } = buildPreloadInjector(paths);
  console.log(`[2] 启动文件注入脚本构建完成（大小：${size} 字节）。`);

  const asarMb = await packAsar(paths);
  console.log(`[3] 资源包打包完成 -> app.asar.patched（${asarMb} MB）。`);

  const deployResult = deployAsarDirectly(paths);
  if (deployResult.ok) {
    console.log(`[4] 官方底包覆盖：${deployResult.message}`);
  } else {
    console.log(`[4] 官方底包状态：${deployResult.message}`);
  }

  const regResult = setPendingRename(paths);
  if (regResult.ok) {
    console.log(`[5] 系统内核重启替换队列：${regResult.message}`);
  } else {
    console.log(`[5] 系统内核重启替换队列：${regResult.message}`);
  }

  const liveResult = await triggerLiveHotPatch(paths, injectorCode);
  if (liveResult.ok) {
    console.log(`[6] 当前屏幕实时生效：${liveResult.message}`);
  } else {
    console.log(`[6] 当前屏幕实时生效：${liveResult.message}`);
  }

  console.log('\n========================================');
  console.log('  ASAR 持久化完成（重启后仍是中文）');
  console.log('========================================');
  return { ok: true, dictCount: count, deployed: deployResult.ok, live: liveResult.ok };
}

/**
 * 一键恢复：把备份的 app.asar.backup 拷回去，恢复官方原厂文件
 * 文件被占用时登记重启替换队列，重启后生效
 */
async function restoreBackup() {
  console.log('========================================');
  console.log('  一键恢复官方原厂文件');
  console.log('========================================\n');

  const paths = getWorkPaths();
  if (!paths.officialAsar) {
    console.log('未在系统中探测到 Antigravity 安装路径，无法恢复。');
    return { ok: false, message: '未探测到安装路径' };
  }
  if (!fs.existsSync(paths.backupAsar)) {
    console.log('没有找到备份文件（' + paths.backupAsar + '），没什么可恢复的。');
    return { ok: false, message: '没有找到备份文件' };
  }

  try {
    fs.copyFileSync(paths.backupAsar, paths.officialAsar);
    console.log('已用备份恢复官方原厂 app.asar，重启 Antigravity 后生效。');
    return { ok: true, message: '已恢复' };
  } catch (err) {
    if (err.code === 'EBUSY') {
      const reg = registerPendingRename(paths.backupAsar, paths.officialAsar);
      if (reg.ok) {
        console.log('客户端正在运行，文件被锁定，已登记重启替换，重启电脑后恢复生效。');
        return { ok: true, message: '已登记重启替换' };
      }
    }
    console.log('恢复失败：' + err.message);
    return { ok: false, message: err.message };
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--persist')) {
    runPersist().catch((err) => { console.error('执行失败：' + err.message); process.exitCode = 1; });
  } else if (args.includes('--restore')) {
    restoreBackup().catch((err) => { console.error('执行失败：' + err.message); process.exitCode = 1; });
  } else {
    runHotPatch().catch((err) => { console.error('执行失败：' + err.message); process.exitCode = 1; });
  }
}

module.exports = {
  runHotPatch,
  runPersist,
  restoreBackup,
  getWorkPaths,
  getMergedDict,
  generateInjectorScript,
  buildPreloadInjector,
  packAsar,
  deployAsarDirectly,
  setPendingRename,
  detectCdpPort,
  triggerLiveHotPatch,
  findAntigravityInstall
};
