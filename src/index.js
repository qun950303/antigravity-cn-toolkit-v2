#!/usr/bin/env node
/**
 * 一键入口
 *
 * 默认流程（不碰 Antigravity 安装目录下的任何文件）：
 *   步骤一：免 TUN 网络配置（检测 10808 端口、写用户环境变量、连通性测试）
 *   步骤二：热注入显示（把翻译脚本打进正在运行的窗口，立刻变中文；只改内存里的界面，不改文件）
 *   步骤三：技能与插件说明汉化（扫 .gemini 文件夹，英文说明翻成中文，改的是用户配置，不是程序文件）
 *
 * 可选：
 *   --persist   开启 ASAR 持久化：拆开官方 app.asar、把翻译写进启动文件、再打包覆盖回去，
 *               重启之后还是中文。开启前会打印风险提示。
 *   --restore   一键恢复：把备份的 app.asar.backup 拷回去，恢复官方原厂文件。
 *   --help      看帮助。
 */
const { run: runNetwork } = require('./network/setup-network');
const translator = require('./i18n/translator');
const { run: runLocalizeSkills } = require('./system/localize-skills');

function printHelp() {
  console.log('Antigravity 中文汉化与免 TUN 上网工具箱（一键入口）');
  console.log('');
  console.log('用法：');
  console.log('  node src/index.js             默认流程：免 TUN → 热注入显示 → 技能/插件说明汉化');
  console.log('  node src/index.js --persist   默认流程 + ASAR 持久化（重启后还是中文）');
  console.log('  node src/index.js --restore   一键恢复官方原厂 app.asar（用备份恢复）');
  console.log('  node src/index.js --help      看这个帮助');
  console.log('');
  console.log('默认流程不碰 Antigravity 安装目录下的任何文件。');
  console.log('ASAR 持久化会覆盖官方程序文件，开启前请看清风险提示。');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  if (args.includes('--restore')) {
    await translator.restoreBackup();
    return;
  }

  const persist = args.includes('--persist');

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║        Antigravity 中文汉化与免 TUN 上网工具箱        ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  const summary = { network: null, hotpatch: null, skills: null, persist: null };

  // 步骤一：免 TUN 网络配置
  try {
    const netRes = await runNetwork();
    summary.network = { ok: netRes.ok, data: netRes };
  } catch (err) {
    summary.network = { ok: false, error: err.message };
    console.error('网络步骤异常：' + err.message);
  }
  console.log('\n');

  // 步骤二：热注入显示（默认，不碰安装目录文件）
  try {
    const hotRes = await translator.runHotPatch();
    summary.hotpatch = { ok: hotRes.ok, data: hotRes };
  } catch (err) {
    summary.hotpatch = { ok: false, error: err.message };
    console.error('热注入步骤异常：' + err.message);
  }
  console.log('\n');

  // 步骤三：技能与插件说明汉化
  try {
    const skRes = runLocalizeSkills();
    summary.skills = { ok: skRes.ok, data: skRes };
  } catch (err) {
    summary.skills = { ok: false, error: err.message };
    console.error('技能说明汉化步骤异常：' + err.message);
  }
  console.log('\n');

  // 步骤四：ASAR 持久化（只有明确加 --persist 才跑）
  if (persist) {
    console.log('========================================');
    console.log('  风险提示（ASAR 持久化）');
    console.log('========================================');
    console.log('  接下来的步骤会拆开 Antigravity 安装目录下的官方程序文件');
    console.log('  app.asar，把翻译写进启动文件，再打包覆盖回去。');
    console.log('  风险：官方更新会覆盖改动；改坏可能导致软件无法启动；');
    console.log('        备份已自动建立，改坏可用 node src/index.js --restore 恢复。');
    console.log('  你加了 --persist，代表你已了解并接受以上风险。');
    console.log('========================================\n');
    try {
      const perRes = await translator.runPersist();
      summary.persist = { ok: perRes.ok, data: perRes };
    } catch (err) {
      summary.persist = { ok: false, error: err.message };
      console.error('ASAR 持久化步骤异常：' + err.message);
    }
    console.log('\n');
  } else {
    console.log('提示：本次没有开启 ASAR 持久化，安装目录文件原封未动。');
    console.log('      重启软件后界面会恢复英文，重跑一键即可；想重启后还是中文，');
    console.log('      请加 --persist 开启持久化（开启前会打印风险提示）。\n');
  }

  console.log('========================================');
  console.log('            执行结果汇总');
  console.log('========================================');
  console.log(`[1] 免 TUN 网络：${summary.network?.ok ? '成功' : '未完成（' + (summary.network?.error || '代理端口未开或不通') + '）'}`);
  const hot = summary.hotpatch;
  const hotText = !hot
    ? '失败'
    : (hot.data?.live
      ? `成功（${hot.data.message}）`
      : `本次未生效（${hot.data?.message || hot.error || '未发现正在运行的窗口，下次启动时重跑即可'}）`);
  console.log(`[2] 热注入显示：${hotText}`);
  console.log(`[3] 技能/插件说明汉化：${summary.skills?.ok ? '成功' : '失败（' + (summary.skills?.error || '未知原因') + '）'}`);
  if (persist) {
    console.log(`[4] ASAR 持久化：${summary.persist?.ok ? '成功' : '失败（' + (summary.persist?.error || '未知原因') + '）'}`);
  }

  const allOk = summary.network?.ok && summary.skills?.ok;
  if (allOk) {
    console.log('\n一键配置完成！重启 Antigravity 后即可使用中文界面。');
  } else {
    console.log('\n部分步骤未完成，请看上面的提示处理。');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('执行失败：' + err.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
