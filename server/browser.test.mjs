import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowser } from './browser.mjs';

// A browser process that starts but never opens its DevTools endpoint, like Chrome handing off to a stale instance.
function fakeSpawn(spawned) {
  return () => {
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit')); return true; };
    spawned.push(child);
    return child;
  };
}

test('a failed start leaves no browser behind, so the next start gets a fresh one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'safenet-browser-'));
  const spawned = [];
  const browser = createBrowser({ chromePath: 'chrome', profileDir: dir, allowHosts: ['example.com'], spawnProcess: fakeSpawn(spawned), startMs: 200 });
  try {
    await assert.rejects(browser.open('https://example.com/', { expression: '"null"' }), { code: 'BROWSER_START' });
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].killed, true, 'the browser that never answered is stopped');
    await assert.rejects(browser.open('https://example.com/', { expression: '"null"' }), { code: 'BROWSER_START' });
    assert.equal(spawned.length, 2, 'the next visit launches again instead of giving up');
    assert.equal(spawned[1].killed, true);
  } finally {
    browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
