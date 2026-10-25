import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const popupSource = readFileSync(new URL('./popup.js', import.meta.url), 'utf8');
function fixture({ tabUrl = 'https://www.instagram.com/p/example/?tracking=private#secret', captured = 'Тест мәтін' } = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', dataset: {}, handlers: {}, disabled: false, addEventListener(name, handler) { this.handlers[name] = handler; }, focus() {} });
    return elements.get(id);
  }
  const radios = ['selection', 'visible'].map(value => ({ ...element(value), value, checked: value === 'selection' }));
  const calls = { capture: [], create: [], query: [] };
  const sandbox = {
    URL, URLSearchParams,
    document: {
      getElementById: element,
      querySelector(selector) { return selector.includes(':checked') ? radios.find(r => r.checked) : radios.find(r => selector.includes(`"${r.value}"`)); },
      querySelectorAll() { return radios; },
    },
    chrome: {
      runtime: { sendMessage: async () => ({ ok: true }) },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      tabs: { query: async options => { calls.query.push(options); return [{ id: 1, url: tabUrl }]; }, create: async options => { calls.create.push(options); } },
      scripting: { executeScript: async options => { calls.capture.push(options); return [{ result: { text: captured, truncated: false } }]; } },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(popupSource + '\nglobalThis.testAPI = { platformFor, captureVisibleText };', sandbox);
  return { element, calls, sandbox };
}

test('manifest limits automatic injection to Instagram/TikTok and network access to local API', () => {
  const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage', 'tabCapture', 'offscreen']);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1:4310/*']);
  assert.equal(manifest.content_scripts.length, 1);
  assert.ok(manifest.content_scripts[0].matches.every(match=>/^https:\/\/(www\.)?(instagram|tiktok)\.com\/\*$/.test(match)));
  assert.equal(manifest.background.service_worker, 'background.js');
});

test('opening popup never reads the current tab or captures its contents', () => {
  const { calls, element } = fixture();
  assert.equal(calls.query.length, 0);
  assert.equal(calls.capture.length, 0);
  assert.equal(calls.create.length, 0);
  assert.equal(element('analyze').disabled, true);
});

test('capture previews editable text; explicit analysis forwards edits and a sanitized source', async () => {
  const { calls, element } = fixture();
  await element('capture').handlers.click();
  assert.equal(calls.capture.length, 1);
  assert.equal(calls.create.length, 0);
  assert.equal(element('text').value, 'Тест мәтін');
  element('text').value = 'Өңделген мәтін & <test>';
  element('text').handlers.input();
  await element('analyze').handlers.click();
  const destination = new URL(calls.create[0].url);
  assert.equal(destination.origin, 'http://127.0.0.1:4310');
  const query = new URLSearchParams(destination.hash.split('?')[1]);
  assert.equal(query.get('text'), 'Өңделген мәтін & <test>');
  assert.equal(query.get('url'), 'https://www.instagram.com/p/example/');
  assert.equal(query.get('platform'), 'instagram');
});

test('restricted pages give a usable error and never invoke script injection', async () => {
  const { calls, element } = fixture({ tabUrl: 'chrome://extensions/' });
  await element('capture').handlers.click();
  assert.equal(calls.capture.length, 0);
  assert.equal(element('status').dataset.error, 'true');
  assert.equal(element('capture').disabled, false);
});

test('clearing removes text and source before the next manual submission', async () => {
  const { calls, element } = fixture();
  await element('capture').handlers.click();
  element('clear').handlers.click();
  assert.equal(element('text').value, '');
  assert.equal(element('analyze').disabled, true);
  element('text').value = 'Manual example';
  await element('analyze').handlers.click();
  const query = new URLSearchParams(new URL(calls.create[0].url).hash.split('?')[1]);
  assert.equal(query.get('url'), '');
  assert.equal(query.get('platform'), 'other');
});

test('platform identification does not trust lookalike domains', () => {
  const { sandbox } = fixture();
  const classify = sandbox.testAPI.platformFor;
  assert.equal(classify('www.tiktok.com'), 'tiktok');
  assert.equal(classify('web.telegram.org'), 'telegram');
  assert.equal(classify('web.whatsapp.com'), 'whatsapp');
  assert.equal(classify('instagram.com.evil.example'), 'other');
  assert.equal(classify('fakeinstagram.com'), 'other');
});

test('viewport capture excludes hidden elements, editable fields and offscreen text', () => {
  const { sandbox } = fixture();
  const makeNode = (text, { forbidden = false, hidden = false, top = 0 } = {}) => ({
    textContent: text,
    top,
    parentElement: { parentElement: null, hidden, closest() { return forbidden ? {} : null; } },
  });
  const nodes = [makeNode('Public post'), makeNode('Hidden secret', { hidden: true }), makeNode('Typed password', { forbidden: true }), makeNode('Offscreen message', { top: 2000 })];
  let index = 0;
  sandbox.document.body = {};
  sandbox.document.createTreeWalker = () => ({ nextNode: () => nodes[index++] });
  sandbox.document.createRange = () => ({ selectNodeContents(node) { this.node = node; }, getClientRects() { return [{ width: 40, height: 10, top: this.node.top, bottom: this.node.top + 10, left: 0, right: 40 }]; } });
  sandbox.getComputedStyle = element => ({ display: element.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1' });
  sandbox.NodeFilter = { SHOW_TEXT: 4 };
  sandbox.innerHeight = 800;
  sandbox.innerWidth = 1000;
  const result = sandbox.testAPI.captureVisibleText('visible', 12000);
  assert.equal(result.text, 'Public post');
  assert.equal(result.truncated, false);
});
