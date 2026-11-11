/**
 * 免 TUN 模式网络环境自动化配置与体检
 * 原理：只写 Windows 用户级环境变量（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY），
 * 让 Antigravity、Node 运行时、命令行进程走本地代理（默认 127.0.0.1:10808），
 * 不开虚拟网卡，不接管整机路由，不影响其他软件与局域网。
 *
 * 安全规则：只有在代理端口确实在监听时才写环境变量，端口没开就什么都不写，
 * 绝不因为盲目配置导致用户断网。
 *
 * 仅支持 Windows 10/11，Node.js >= 18。
 */
const net = require('net');
const http = require('http');
const { execSync } = require('child_process');

/**
 * 检测本地端口是否在监听
 */
async function checkPort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(1200);
    sock.on('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.connect(port, host);
  });
}

/**
 * 写入一条用户级环境变量（已是目标值就跳过）
 */
function ensureEnv(name, value) {
  try {
    const cur = execSync(`reg query HKCU\\Environment /v ${name}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (cur && cur.includes(value)) {
      return { name, status: '已配置', value, changed: false };
    }
  } catch (e) {
    // 注册表里没有这一项，继续往下写
  }

  try {
    execSync(`setx ${name} "${value}"`, { stdio: 'ignore' });
    return { name, status: '已更新', value, changed: true };
  } catch (e) {
    return { name, status: '写入失败: ' + e.message, value, changed: false };
  }
}

/**
 * 走代理向外网发一个探测请求，确认代理真的能上网
 */
async function testHttpThroughProxy(proxyHost, proxyPort) {
  return new Promise((resolve) => {
    const req = http.request({
      host: proxyHost,
      port: proxyPort,
      path: 'http://www.google.com/generate_204',
      method: 'GET',
      timeout: 3000,
      headers: { Host: 'www.google.com' }
    }, (res) => {
      resolve({ ok: res.statusCode === 204 || (res.statusCode >= 200 && res.statusCode < 400), code: res.statusCode });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: '连接超时' });
    });
    req.end();
  });
}

async function run(options = {}) {
  console.log('========================================');
  console.log('  免 TUN 网络环境体检与配置');
  console.log('========================================\n');

  const proxyPort = options.port || 10808;
  const proxyHost = options.host || '127.0.0.1';

  // 第一步：先检测本地代理端口，端口没开后面什么都不做
  const isPortOpen = await checkPort(proxyPort, proxyHost);
  console.log(`[1] 本地代理端口 (${proxyHost}:${proxyPort})：${isPortOpen ? '正在监听' : '未监听到服务，请先启动 Xray / V2Ray 等代理客户端'}`);

  let testRes = { ok: false };
  if (isPortOpen) {
    testRes = await testHttpThroughProxy(proxyHost, proxyPort);
    if (testRes.ok) {
      console.log(`[2] 代理出海验证：测试通过，状态码 ${testRes.code}，免 TUN 代理正常。`);
    } else {
      console.log(`[2] 代理出海验证：端口已连通，但外网探测返回 ${testRes.error || testRes.code}，请检查节点订阅。`);
    }
  } else {
    console.log('[2] 代理出海验证：端口未开放，跳过外网探测。');
  }

  // 第二步：只有端口开放时才写环境变量，端口没开绝不写，避免断网
  if (isPortOpen) {
    const envResults = [
      ensureEnv('HTTP_PROXY', `http://${proxyHost}:${proxyPort}`),
      ensureEnv('HTTPS_PROXY', `http://${proxyHost}:${proxyPort}`),
      ensureEnv('ALL_PROXY', `socks5://${proxyHost}:${proxyPort}`)
    ];

    console.log('\n[3] 用户级环境变量代理配置：');
    for (const r of envResults) {
      console.log(`    - ${r.name}：${r.value} [${r.status}]`);
    }
    console.log('\n提示：环境变量改完需要重启 Antigravity 才生效。');
  } else {
    console.log('\n[3] 安全保护：代理端口未开启，已跳过写入环境变量，避免导致断网。');
  }

  console.log('\n========================================');
  console.log('  免 TUN 网络配置检查完成');
  console.log('========================================');

  return {
    ok: isPortOpen && testRes.ok,
    portOpen: isPortOpen,
    connected: testRes.ok
  };
}

if (require.main === module) {
  run().catch(console.error);
}

module.exports = { run, checkPort, testHttpThroughProxy, ensureEnv };
