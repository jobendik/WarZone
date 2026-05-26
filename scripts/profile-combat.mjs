import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const gameUrl = process.env.GAME_URL || 'http://127.0.0.1:5175/?perfTrace=1';
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profileDir = path.resolve('.codex-chrome-profile-run');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startChrome() {
  return spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-extensions',
    '--no-first-run',
    gameUrl,
  ], { stdio: 'ignore', windowsHide: true });
}

async function waitForChrome() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) return;
    } catch {
      // keep waiting
    }
    await sleep(250);
  }
  throw new Error('Chrome remote debugging did not start.');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const pair = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) pair.reject(new Error(JSON.stringify(msg.error)));
      else pair.resolve(msg.result);
      return;
    }

    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (/\[perf|Arena|NavMesh|Shader|error|warn|failed/i.test(text) ||
          msg.params.type === 'warning' || msg.params.type === 'error') {
        console.log(`[browser:${msg.params.type}] ${text}`);
      }
    }

    if (msg.method === 'Runtime.exceptionThrown') {
      const e = msg.params.exceptionDetails;
      console.log('[browser:exception]', e.text, e.exception?.description ?? '');
    }
  });

  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  function send(method, params = {}) {
    const msgId = ++id;
    ws.send(JSON.stringify({ id: msgId, method, params }));
    return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject }));
  }

  return { ws, opened, send };
}

async function getPageTarget() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:5175'));
  if (!page) throw new Error('No WarZone page target.');
  return page;
}

async function runProfile(cdp) {
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  async function evalExpr(expression, timeoutMs = 30000) {
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`eval timeout: ${expression.slice(0, 100)}`)), timeoutMs);
    });
    const result = await Promise.race([
      cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      }),
      timeout,
    ]);
    if (result.exceptionDetails) {
      throw new Error(`${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`);
    }
    return result.result?.value;
  }

  async function waitFor(label, expression, timeoutMs = 60000) {
    console.log('wait', label);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await evalExpr(`Boolean(${expression})`, 5000)) {
          console.log('ready', label);
          return;
        }
      } catch {
        // poll again
      }
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  await waitFor('__td', 'window.__td && document.readyState !== "loading"', 60000);
  await evalExpr(`
    localStorage.setItem('warzone_perf_trace','1');
    window.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__longTasks.push({ duration: e.duration, start: e.startTime, name: e.name });
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch (e) {}
  `);

  await evalExpr(`(async () => {
    document.getElementById('sgPlay')?.click();
    await new Promise((r) => setTimeout(r, 500));
    if (!document.querySelector('#mmDeploy')) {
      const menu = await import('/src/ui/MainMenu.ts');
      menu.showMainMenu();
    }
  })()`);
  await waitFor('deploy button', 'document.querySelector("#mmDeploy")', 30000);
  await evalExpr(`document.querySelector('#mmDeploy')?.click()`);
  await waitFor(
    'world loaded',
    'window.__td.gameState.agents.length > 2 && !document.getElementById("loadingScreen")?.classList.contains("on")',
    180000,
  );

  await evalExpr(`(async () => {
    try {
      const m = await import('/src/ui/MatchIntro.ts');
      m.skipIntro();
    } catch (e) {}
  })()`);
  await waitFor('intro inactive', '!window.__td.gameState._introActive', 30000).catch(() => {});
  await evalExpr(`window.__td.gameState.paused = false`);

  const pre = await evalExpr(`(() => ({
    programs: window.__td.renderInfo().programs,
    render: window.__td.renderInfo(),
    walls: window.__td.gameState.wallMeshes.length,
    cover: window.__td.gameState.coverPoints.length,
    fog: window.__td.gameState.scene.fog ? window.__td.gameState.scene.fog.type : null,
    body: document.body.className,
    intro: window.__td.gameState._introActive,
  }))()`);
  console.log(`PRE ${JSON.stringify(pre)}`);
  await evalExpr(`
    window.__tdPreProgramKeys = new Set(
      (window.__td.gameState.renderer.info.programs || []).map((p) => p.cacheKey)
    );
  `);

  await evalExpr(`window.__td.perf.enable(); window.__longTasks.length = 0`);

  const setup = await evalExpr(`(() => {
    const gs = window.__td.gameState;
    const center = { x: gs.player.position.x, z: gs.player.position.z };
    const blue = gs.agents.filter((a) => a.team === 0 && a !== gs.player && !a.isDead).slice(0, 5);
    const red = gs.agents.filter((a) => a.team === 1 && !a.isDead).slice(0, 5);
    const place = (a, x, z, target) => {
      a.active = true;
      a.isDead = false;
      a.position.set(x, 0, z);
      a.velocity.set(0, 0, 0);
      if (a.renderComponent) a.renderComponent.position.set(x, 0, z);
      a.currentTarget = target;
      a.hasTarget = true;
      a.reactionTimer = 0;
      a.shootTimer = 0;
      a.burstTimer = 0;
      a.decisionTimer = 0;
      a.visionRange = 999;
      a.visionFOV = Math.PI * 2;
      a.ammo = Math.max(a.ammo || 0, a.magSize || 30);
      a.isReloading = false;
    };
    for (let i = 0; i < blue.length; i++) place(blue[i], center.x - 4, center.z - 3 + i * 1.5, red[i % red.length]);
    for (let i = 0; i < red.length; i++) place(red[i], center.x + 4, center.z - 3 + i * 1.5, blue[i % blue.length]);
    gs.paused = false;
    return { center, agents: gs.agents.length, blue: blue.length, red: red.length, coverPoints: gs.coverPoints.length, walls: gs.wallMeshes.length };
  })()`);
  console.log(`SETUP ${JSON.stringify(setup)}`);

  await sleep(22000);
  const snap = await evalExpr(`(() => ({
    snap: window.__td.perf.snapshot(),
    render: window.__td.renderInfo(),
    particles: window.__td.gameState.particles.length,
    bullets: window.__td.gameState.bullets.length,
    scores: window.__td.gameState.teamScores,
    fog: window.__td.gameState.scene.fog ? window.__td.gameState.scene.fog.type : null,
    newPrograms: (window.__td.gameState.renderer.info.programs || [])
      .filter((p) => !window.__tdPreProgramKeys?.has(p.cacheKey))
      .map((p) => ({
        usedTimes: p.usedTimes,
        key: String(p.cacheKey).split(',').filter(Boolean).slice(0, 80).join('|'),
      })),
    longTasks: (window.__longTasks || []).slice(-30),
  }))()`);
  console.log(`SNAPSHOT ${JSON.stringify(snap, null, 2)}`);
}

let chrome;
try {
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  chrome = startChrome();
  await waitForChrome();
  const page = await getPageTarget();
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.opened;
  await runProfile(cdp);
  cdp.ws.close();
} finally {
  if (chrome && !chrome.killed) chrome.kill('SIGKILL');
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
