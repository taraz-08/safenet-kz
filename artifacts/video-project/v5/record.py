"""Record genuine SafeNet KZ screens for the defense video.

Headless Chrome at 1920x1080 is driven through the DevTools protocol; frames come from Page.startScreencast,
so every pixel is the real running app. A drawn cursor and smooth scrolling make the walkthrough readable.
Usage (from the project root, with the server running on 127.0.0.1:4310):  python artifacts/video-project/v5/record.py
"""
from __future__ import annotations

import asyncio
import base64
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent
FRAMES = ROOT / 'frames'
APP = 'http://127.0.0.1:4310'
CHROME = Path('C:/Program Files/Google/Chrome/Application/chrome.exe')
PORT = 9333

CURSOR_JS = r"""
(() => {
  if (window.__demo) return true;
  const style = document.createElement('style');
  style.textContent = `#demo-cursor{position:fixed;left:960px;top:540px;width:26px;height:26px;z-index:2147483647;pointer-events:none;transition:left .7s cubic-bezier(.3,.7,.2,1),top .7s cubic-bezier(.3,.7,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
  #demo-cursor svg{width:26px;height:26px}
  .demo-ripple{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid rgba(8,125,120,.75);z-index:2147483646;pointer-events:none;animation:demo-ripple .6s ease-out forwards}
  @keyframes demo-ripple{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}`;
  document.head.appendChild(style);
  const cursor = document.createElement('div');
  cursor.id = 'demo-cursor';
  cursor.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 2l16 9.5-7 1.6-3.6 6.9z" fill="#fff" stroke="#18343d" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.body.appendChild(cursor);
  const find = target => typeof target === 'string' ? [...document.querySelectorAll(target.split('::')[0])].find(el => !target.includes('::') || el.textContent.includes(target.split('::')[1])) : null;
  window.__demo = {
    move(target) {
      const el = find(target); let x = 960, y = 540;
      if (el) { const r = el.getBoundingClientRect(); x = r.left + Math.min(r.width / 2, 120); y = r.top + Math.min(r.height / 2, 30); }
      else if (Array.isArray(target)) [x, y] = target;
      cursor.style.left = `${x}px`; cursor.style.top = `${y}px`;
      return Boolean(el) || Array.isArray(target);
    },
    click(target) {
      const el = find(target); if (!el) return false;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      this.move(target);
      setTimeout(() => {
        const r = cursor.getBoundingClientRect(); const ripple = document.createElement('div'); ripple.className = 'demo-ripple';
        ripple.style.left = `${r.left + 4}px`; ripple.style.top = `${r.top + 4}px`; document.body.appendChild(ripple); setTimeout(() => ripple.remove(), 700);
        el.click();
      }, 750);
      return true;
    },
    hover(target) { const el = find(target); if (!el) return false; this.move(target); el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true; },
    scroll(y, ms) {
      const start = window.scrollY, delta = y - start, t0 = performance.now();
      const step = now => { const k = Math.min(1, (now - t0) / ms); const e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; window.scrollTo(0, start + delta * e); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step); return true;
    },
    scrollTo(target, ms, offset = 140) { const el = find(target); if (!el) return false; this.scroll(window.scrollY + el.getBoundingClientRect().top - offset, ms); return true; },
  };
  return true;
})()
"""

# Each step: (action, argument, seconds to wait afterwards).
SCENES = {
    'overview': [('hash', 'overview', 2.0), ('move', '.wb-funnel li.queued', 3.0), ('move', '.wb-funnel li.cleared', 3.0), ('scroll', 640, 3.5), ('move', '.wb-track-card.casino', 2.5), ('move', '.wb-mini-queue li', 3.0), ('scroll', 0, 2.5), ('move', '.wb-hero .wb-button.primary', 3.0)],
    'pipeline': [('hash', 'pipeline', 2.5), ('move', '.wb-pipe-head h2', 2.5), ('move', '.wb-stages li:nth-child(2)', 2.0), ('move', '.wb-stages li:nth-child(4)', 2.0), ('move', '.wb-stages li:nth-child(5)', 2.0), ('scroll', 560, 3.0), ('move', '.wb-log tbody tr', 4.0), ('move', '.wb-sources li', 3.0)],
    'review': [('hash', 'review', 3.0), ('move', '.wb-queue button.active', 3.0), ('move', '.wb-elements li.on', 3.5), ('scrollTo', '.wb-elements', 1.5), ('click', '.wb-tabs.small button::Эфир', 4.0), ('scrollTo', '.wb-signals', 2.5), ('move', '.wb-signals li', 4.0), ('scroll', '+520', 3.0), ('move', '.wb-decision .wb-button.confirm', 2.5), ('click', '.wb-decision .wb-button.ghost', 3.5), ('move', '.wb-reasons .wb-button', 2.5), ('click', '.wb-reasons .wb-link', 2.0)],
    'networks': [('hash', 'networks', 2.5), ('move', '.wb-cluster.casino .wb-graph', 3.5), ('move', '.wb-cluster.casino .wb-chip', 3.0), ('move', '.wb-cluster.pyramid .wb-graph', 3.5), ('move', '.wb-cluster.pyramid .wb-chip', 3.0), ('scroll', 620, 3.5), ('move', '.wb-log tbody tr', 3.0)],
    'discovery': [('hash', 'discovery', 2.5), ('move', '.wb-pipe-head h2', 3.0), ('move', '.wb-seed-form input', 2.5), ('scrollTo', '.wb-found', 3.0), ('move', '.wb-found-head a', 3.0), ('move', '.wb-found-sample', 3.5), ('scroll', '+700', 4.0), ('move', '.wb-found-head strong', 3.0)],
    'quality': [('hash', 'quality', 2.5), ('move', '.wb-table tr.main', 4.0), ('move', '.wb-table tbody tr:first-child', 2.5), ('scroll', 620, 3.0), ('move', '.wb-bars li', 3.0), ('scroll', 1180, 3.0), ('hover', '.wb-hit', 2.0), ('hover', '.wb-hit:nth-of-type(4)', 3.0), ('move', '.wb-kpis', 3.0)],
}


class Cdp:
    def __init__(self, ws):
        self.ws, self.next_id, self.pending, self.frames, self.recording = ws, 0, {}, [], None

    async def reader(self):
        async for raw in self.ws:
            message = json.loads(raw)
            if 'id' in message and message['id'] in self.pending:
                self.pending.pop(message['id']).set_result(message.get('result', {}))
            elif message.get('method') == 'Page.screencastFrame':
                params = message['params']
                asyncio.ensure_future(self.send('Page.screencastFrameAck', {'sessionId': params['sessionId']}))
                if self.recording is not None:
                    index = len(self.frames)
                    path = self.recording / f'{index:05d}.jpg'
                    path.write_bytes(base64.b64decode(params['data']))
                    self.frames.append({'file': path.name, 't': params['metadata'].get('timestamp', time.time())})

    async def send(self, method, params=None):
        self.next_id += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[self.next_id] = future
        await self.ws.send(json.dumps({'id': self.next_id, 'method': method, 'params': params or {}}))
        return await asyncio.wait_for(future, 30)

    async def js(self, expression):
        result = await self.send('Runtime.evaluate', {'expression': expression, 'awaitPromise': True, 'returnByValue': True})
        return result.get('result', {}).get('value')


def api(path, method='GET', body=None):
    request = urllib.request.Request(APP + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode())


async def run_scene(cdp, name, steps):
    folder = FRAMES / name
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    cdp.frames, cdp.recording = [], folder
    await cdp.send('Page.startScreencast', {'format': 'jpeg', 'quality': 88, 'maxWidth': 1920, 'maxHeight': 1080, 'everyNthFrame': 1})
    started = time.time()
    for action, argument, wait in steps:
        if action == 'hash':
            await cdp.js(f"location.hash = '#/{argument}'; window.scrollTo(0, 0); true")
            await asyncio.sleep(1.2)
            await cdp.js(CURSOR_JS)
        elif action == 'scroll':
            target = f"window.scrollY + {argument[1:]}" if isinstance(argument, str) else str(argument)
            await cdp.js(f"window.__demo.scroll({target}, {int(wait * 650)})")
        else:
            ok = await cdp.js(f"window.__demo.{action}({json.dumps(argument)}{', ' + str(int(wait * 650)) if action == 'scrollTo' else ''})")
            if not ok:
                print(f'  ! {name}: {action} {argument} not found', file=sys.stderr)
        await asyncio.sleep(wait)
    await cdp.send('Page.stopScreencast')
    await asyncio.sleep(0.3)
    cdp.recording = None
    (folder / 'timestamps.json').write_text(json.dumps({'scene': name, 'seconds': round(time.time() - started, 2), 'frames': cdp.frames}, ensure_ascii=False), encoding='utf-8')
    print(f'{name}: {len(cdp.frames)} frames, {time.time() - started:.1f}s')


async def main(only):
    profile = Path(tempfile.mkdtemp(prefix='safenet-rec-'))
    chrome = subprocess.Popen([str(CHROME), '--headless=new', f'--remote-debugging-port={PORT}', '--window-size=1920,1080', '--force-device-scale-factor=1',
                               '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', f'--user-data-dir={profile}', 'about:blank'])
    try:
        for _ in range(50):
            try:
                targets = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list', timeout=2).read())
                page = next(item for item in targets if item.get('type') == 'page')
                break
            except Exception:
                await asyncio.sleep(0.2)
        async with websockets.connect(page['webSocketDebuggerUrl'], max_size=None) as ws:
            cdp = Cdp(ws)
            reader = asyncio.ensure_future(cdp.reader())
            await cdp.send('Page.enable')
            await cdp.send('Runtime.enable')
            await cdp.send('Emulation.setDeviceMetricsOverride', {'width': 1920, 'height': 1080, 'deviceScaleFactor': 1, 'mobile': False})
            await cdp.send('Page.navigate', {'url': APP + '/'})
            await asyncio.sleep(2.5)
            await cdp.js("localStorage.setItem('safenet-language','ru'); true")
            if 'overview' in only:
                # The demo stream replays live so the funnel and the pipeline log move on camera.
                api('/api/pipeline/reset', 'POST', {})
                api('/api/pipeline', 'PUT', {'rate': 5})
            await cdp.send('Page.navigate', {'url': APP + '/#/overview'})
            # The UI reads its language once at load; a hash-only navigation keeps the old one, so reload.
            await cdp.send('Page.reload', {'ignoreCache': True})
            await asyncio.sleep(3)
            await cdp.js(CURSOR_JS)
            for name, steps in SCENES.items():
                if name in only:
                    await run_scene(cdp, name, steps)
            reader.cancel()
    finally:
        chrome.terminate()
        try:
            chrome.wait(5)
        except Exception:
            chrome.kill()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == '__main__':
    asyncio.run(main(set(sys.argv[1:]) or set(SCENES)))
