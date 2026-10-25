"""Record the live SafeNet KZ site for the jury video.

Headless Chrome at 1920x1080 is driven over the DevTools protocol; frames come from Page.startScreencast, so every
pixel is the running site. Telegram scenes come from the public deployment, the Instagram/TikTok scene from the
same app on the team's computer (Railway's IP gets Instagram's login wall).
Usage:  python artifacts/video-project/v6/record.py [scene ...]
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
BASES = {'hosted': 'https://safenet-kz.up.railway.app/', 'local': 'http://127.0.0.1:4310/'}
CHROME = Path('C:/Program Files/Google/Chrome/Application/chrome.exe')
PORT = 9334

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
  const ease = k => (k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
  const animate = (from, to, ms, apply) => { const t0 = performance.now(); const step = now => { const k = Math.min(1, (now - t0) / ms); apply(from + (to - from) * ease(k)); if (k < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); };
  window.__demo = {
    move(target) {
      const el = find(target); let x = 960, y = 540;
      if (el) { const r = el.getBoundingClientRect(); x = r.left + Math.min(r.width / 2, 120); y = r.top + Math.min(r.height / 2, 30); }
      cursor.style.left = `${x}px`; cursor.style.top = `${y}px`;
      return Boolean(el);
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
    type(target, text, ms) {
      // Types into a React-controlled field letter by letter, the way a person would.
      const el = find(target); if (!el) return false;
      el.focus(); this.move(target);
      const setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
      let i = 0; const step = Math.max(8, ms / Math.max(1, text.length));
      const tick = () => { i++; setter.call(el, text.slice(0, i)); el.dispatchEvent(new Event('input', { bubbles: true })); if (i < text.length) setTimeout(tick, step); };
      tick(); return true;
    },
    scroll(y, ms) { animate(window.scrollY, y, ms, value => window.scrollTo(0, value)); return true; },
    scrollBy(dy, ms) { return this.scroll(window.scrollY + dy, ms); },
    scrollTo(target, ms) { const el = find(target); if (!el) return false; return this.scroll(window.scrollY + el.getBoundingClientRect().top - 140, ms); },
    scrollIn(container, dy, ms) { const el = find(container); if (!el) return false; animate(el.scrollTop, el.scrollTop + dy, ms, value => { el.scrollTop = value; }); return true; },
  };
  return true;
})()
"""

CHECK_TEXT = 'Салымсыз табыс! 5000 теңге сал, ертең 15 000 ал. Каспиге аудар, тек бүгін 3 орын қалды. Досыңды шақыр — бонус аласың.'

# Each step: (method of window.__demo, arguments, seconds to wait afterwards). Animated steps last ~65% of the wait.
SCENES = {
    'live': ('hosted', '#/overview', [('move', ['.wb-pipe-head h2'], 3.0), ('move', ['.wb-pipe-head'], 2.5), ('scrollTo', ['.wb-split'], 3.0), ('move', ['.wb-split h3'], 3.0), ('scrollTo', ['section.wb-panel::Находки, ожидающие решения'], 3.5), ('move', ['main .wb button::@olimp_casino'], 3.5)]),
    'telegram': ('hosted', '#/discovery', [('move', ['.wb-pipe-head h2'], 3.0), ('move', ['.wb-kpis'], 2.5), ('scrollTo', ['.wb-found'], 3.0), ('move', ['.wb-found-head a'], 3.0), ('move', ['.wb-found-meta'], 3.0), ('move', ['.wb-found-sample'], 3.5), ('scrollBy', [600], 3.5), ('move', ['.wb-found li:nth-child(3) .wb-found-head a'], 3.0)]),
    'case': ('hosted', '#/review?case=808398f8-a2ac-41be-a139-fa3d586e6563', [('move', ['.wb-queue button.active'], 3.0), ('move', ['.wb-dossier h2'], 2.5), ('move', ['.wb-elements'], 3.0), ('scrollIn', ['.wb-dossier', 420], 3.0), ('move', ['.wb-signals li'], 3.5), ('move', ['.wb-signals li:nth-child(2)'], 3.0), ('move', ['.wb-signals li:nth-child(4)'], 3.0), ('scrollIn', ['.wb-dossier', 480], 3.0)]),
    'check': ('hosted', '#/analyze', [('move', ['#post-text'], 1.5), ('type', ['#post-text', CHECK_TEXT], 5.5), ('click', ['.analyze-form button.primary'], 4.5), ('move', ['#case-detail-title'], 3.0), ('scrollIn', ['.case-drawer', 500], 3.5), ('scrollIn', ['.case-drawer', 500], 3.0)]),
    'social': ('local', '#/social', [('move', ['.wb-pipe-head h2'], 3.0), ('move', ['.wb-kpis'], 3.0), ('scrollTo', ['.wb-found'], 3.0), ('move', ['.wb-found-head a'], 3.0), ('move', ['.wb-found-sample'], 3.0), ('scrollBy', [520], 3.5), ('move', ['.wb-found li:nth-child(4) .wb-found-head a'], 3.0)]),
    'strength': ('hosted', '#/quality', [('move', ['.wb-table tr.main'], 4.0), ('scroll', [600], 3.5), ('move', ['.wb-bars li'], 3.5), ('scroll', [0], 2.5)]),
}
ANIMATED = {'scroll', 'scrollBy', 'scrollTo', 'scrollIn', 'type'}


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
                    path = self.recording / f'{len(self.frames):05d}.jpg'
                    path.write_bytes(base64.b64decode(params['data']))
                    self.frames.append({'file': path.name, 't': params['metadata'].get('timestamp', time.time())})

    async def send(self, method, params=None):
        self.next_id += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[self.next_id] = future
        await self.ws.send(json.dumps({'id': self.next_id, 'method': method, 'params': params or {}}))
        return await asyncio.wait_for(future, 60)

    async def js(self, expression):
        result = await self.send('Runtime.evaluate', {'expression': expression, 'awaitPromise': True, 'returnByValue': True})
        return result.get('result', {}).get('value')


async def open_page(cdp, base, path):
    # The UI reads its language once at load, so set it on the origin first and then load the page itself.
    await cdp.send('Page.navigate', {'url': base})
    await asyncio.sleep(3)
    await cdp.js("localStorage.setItem('safenet-language','ru'); true")
    await cdp.send('Page.navigate', {'url': base + path})
    await asyncio.sleep(6)
    await cdp.js(CURSOR_JS)


async def run_scene(cdp, name, source, path, steps):
    await open_page(cdp, BASES[source], path)
    folder = FRAMES / name
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    cdp.frames, cdp.recording = [], folder
    await cdp.send('Page.startScreencast', {'format': 'jpeg', 'quality': 90, 'maxWidth': 1920, 'maxHeight': 1080, 'everyNthFrame': 1})
    started = time.time()
    await asyncio.sleep(0.8)
    for method, args, wait in steps:
        call_args = [*args, int(wait * 650)] if method in ANIMATED else args
        ok = await cdp.js(f"window.__demo.{method}({', '.join(json.dumps(a, ensure_ascii=False) for a in call_args)})")
        if not ok:
            print(f'  ! {name}: {method} {args[0]} not found', file=sys.stderr)
        await asyncio.sleep(wait)
    await cdp.send('Page.stopScreencast')
    await asyncio.sleep(0.3)
    cdp.recording = None
    (folder / 'timestamps.json').write_text(json.dumps({'scene': name, 'seconds': round(time.time() - started, 2), 'frames': cdp.frames}, ensure_ascii=False), encoding='utf-8')
    print(f'{name}: {len(cdp.frames)} frames, {time.time() - started:.1f}s')


async def main(only):
    profile = Path(tempfile.mkdtemp(prefix='safenet-rec6-'))
    chrome = subprocess.Popen([str(CHROME), '--headless=new', f'--remote-debugging-port={PORT}', '--window-size=1920,1080', '--force-device-scale-factor=1',
                               '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', f'--user-data-dir={profile}', 'about:blank'])
    try:
        for _ in range(60):
            try:
                targets = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list', timeout=2).read())
                page = next(item for item in targets if item.get('type') == 'page')
                break
            except Exception:
                await asyncio.sleep(0.25)
        async with websockets.connect(page['webSocketDebuggerUrl'], max_size=None) as ws:
            cdp = Cdp(ws)
            reader = asyncio.ensure_future(cdp.reader())
            await cdp.send('Page.enable')
            await cdp.send('Runtime.enable')
            # Russian interface from the very first page load on every origin.
            await cdp.send('Page.addScriptToEvaluateOnNewDocument', {'source': "try{localStorage.setItem('safenet-language','ru')}catch(e){}"})
            await cdp.send('Emulation.setDeviceMetricsOverride', {'width': 1920, 'height': 1080, 'deviceScaleFactor': 1, 'mobile': False})
            for name, (source, path, steps) in SCENES.items():
                if name in only:
                    await run_scene(cdp, name, source, path, steps)
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
