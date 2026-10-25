/** SafeNet KZ — a single headless Chrome driven over the DevTools protocol.
 *  Opens only public pages on an allow-list of hosts, never signs in and never fills forms.
 *  Pages are opened one at a time; the caller decides the pace. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const coded = (message, code) => Object.assign(new Error(message), { code });

export function findChrome() { return CANDIDATES.find(path => path && existsSync(path)) ?? null; }

export function createBrowser({ chromePath = findChrome(), profileDir, allowHosts = [], timeoutMs = 40000 } = {}) {
  let child = null, socket = null, nextId = 0, starting = null, queue = Promise.resolve(), closed = false;
  const pending = new Map();

  function failPending(error) { for (const { reject } of pending.values()) reject(error); pending.clear(); }

  function send(method, params = {}) {
    if (!socket || socket.readyState !== 1) return Promise.reject(coded('Нет связи с браузером.', 'BROWSER_GONE'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(coded(`Браузер не ответил: ${method}`, 'BROWSER_TIMEOUT')); }, timeoutMs);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function launch() {
    if (!chromePath) throw coded('Chrome или Edge не найден. Укажите путь в переменной CHROME_PATH.', 'BROWSER_MISSING');
    mkdirSync(profileDir, { recursive: true });
    const portFile = join(profileDir, 'DevToolsActivePort');
    rmSync(portFile, { force: true });
    // Chromium in the isolated Linux container has a small /dev/shm and runs as root.
    // Desktop installs retain Chromium's sandbox; the container opts in explicitly.
    const containerFlags = process.platform === 'linux' ? ['--disable-dev-shm-usage', ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])] : [];
    child = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
      ...containerFlags, '--disk-cache-size=10485760', '--disable-extensions', '--disable-sync', '--mute-audio', '--window-size=1366,900', '--lang=ru-RU', 'about:blank'], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => { child = null; socket = null; failPending(coded('Не удалось запустить браузер.', 'BROWSER_START')); });
    child.on('exit', () => { child = null; socket = null; failPending(coded('Браузер закрылся.', 'BROWSER_GONE')); });
    let port = null;
    for (const deadline = Date.now() + 20000; !port; await sleep(150)) {
      if (Date.now() > deadline || !child) throw coded('Браузер не запустился.', 'BROWSER_START');
      // Chrome writes "<port>\n<path>" once the DevTools endpoint is listening.
      try { port = Number(readFileSync(portFile, 'utf8').split('\n')[0]) || null; } catch { /* not written yet */ }
    }
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find(target => target.type === 'page');
    if (!page) throw coded('В браузере нет вкладки.', 'BROWSER_START');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(coded('Нет связи с браузером.', 'BROWSER_START')); });
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      const waiter = message.id && pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(coded(message.error.message, 'BROWSER_PROTOCOL')); else waiter.resolve(message.result ?? {});
    };
    socket.onclose = () => { socket = null; failPending(coded('Нет связи с браузером.', 'BROWSER_GONE')); };
    await send('Page.enable');
    await send('Network.enable');
    // The browser keeps its own headless user agent: no disguise as a person; a platform that refuses it is left alone.
    await send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'ru-RU,ru;q=0.9,kk;q=0.8,en;q=0.5' } });
    await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  }

  async function ready() {
    if (closed) throw coded('Браузер остановлен.', 'BROWSER_CLOSED');
    if (socket && socket.readyState === 1) return;
    starting ??= launch().finally(() => { starting = null; });
    await starting;
  }

  /** Opens a public page and returns what `expression` (a page script returning JSON text) extracted. */
  async function visit(url, { expression, settleMs = 2500, scrolls = 0 }) {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (!allowHosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`))) throw coded(`Адрес вне списка разрешённых: ${host}`, 'HOST_NOT_ALLOWED');
    await ready();
    const navigation = await send('Page.navigate', { url });
    if (navigation.errorText) throw coded(`Страница не открылась: ${navigation.errorText}`, 'NAVIGATION');
    await sleep(settleMs);
    for (let i = 0; i < scrolls; i++) { await send('Runtime.evaluate', { expression: 'window.scrollBy(0, 1400)' }); await sleep(1500); }
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw coded('Не удалось прочитать страницу.', 'EXTRACT');
    return JSON.parse(result.result?.value ?? 'null');
  }

  return {
    open(url, options) { const run = queue.then(() => visit(url, options)); queue = run.catch(() => {}); return run; },
    available: () => Boolean(chromePath),
    close() {
      closed = true;
      try { socket?.close(); } catch { /* already closed */ }
      try { child?.kill(); } catch { /* already gone */ }
      socket = null; child = null;
    },
  };
}
