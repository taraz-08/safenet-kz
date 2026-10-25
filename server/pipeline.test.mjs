import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPipeline, analyzeGroup, buildNetworks, templateClusters, linkKeys, QUEUE_THRESHOLD } from './pipeline.mjs';
import { analyzeContent } from './engine.mjs';
import { trainModel, compileModel, predict } from './model.mjs';
import { createApp } from './app.mjs';

const corpus = {
  name: 'test stream',
  accounts: [
    { id: 'a1', handle: '@spin_one', platform: 'tiktok', followers: 50000 },
    { id: 'a2', handle: '@spin_two', platform: 'instagram', followers: 9000 },
    { id: 'a3', handle: '@spin_bot', platform: 'instagram', followers: 10 },
    { id: 'b1', handle: '@cafe', platform: 'instagram', followers: 3000 },
  ],
  items: [
    { id: 'i1', accountId: 'a1', platform: 'tiktok', type: 'stream', minutesAgo: 300, text: 'вечерний стрим', transcript: 'крутим слоты, занос! промокод AZ777, ссылка в описании, регайтесь', groundTruth: 'casino' },
    { id: 'i2', accountId: 'a2', platform: 'instagram', type: 'post', minutesAgo: 200, text: 'Поднял 300к за вечер 💰 Промокод AZ777, ссылка в шапке профиля', groundTruth: 'casino' },
    { id: 'i3', accountId: 'b1', platform: 'instagram', type: 'post', minutesAgo: 150, text: 'Дарим кофе! Подпишись и поставь лайк, участие бесплатное.', groundTruth: 'none' },
    { id: 'i4', accountId: 'a3', platform: 'instagram', type: 'comment', minutesAgo: 100, text: 'брат, AZ777 не забудь 🤝', groundTruth: 'casino' },
  ],
  groups: [{ id: 'g1', title: 'Табыс', platform: 'whatsapp', groundTruth: 'pyramid', messages: [
    { author: 'Айгерим', authorId: 'u1', minutesAgo: 90, text: 'Я основатель клуба. Вкладываете от 5 000 ₸, через 72 часа получаете x2. Вопросы — кураторам.' },
    { author: 'Ерлан', authorId: 'u2', minutesAgo: 80, text: '🔥 Друзья, сегодня ещё 5 мест! Вклад 5 000 ₸ → через 3 дня 10 000 ₸ 💰 Kaspi: +7 700 000 55 01 Чек мне в личку ✅' },
    { author: 'Мадина', authorId: 'u3', minutesAgo: 70, text: '🔥 Друзья, сегодня ещё 4 места! Вклад 5 000 ₸ → через 3 дня 10 000 ₸ 💰 Kaspi: +7 700 000 55 01 Чек мне в личку ✅' },
    { author: 'Ерлан', authorId: 'u2', minutesAgo: 60, text: '🔥 Друзья, сегодня ещё 3 места! Вклад 5 000 ₸ → через 3 дня 10 000 ₸ 💰 Kaspi: +7 700 000 55 01 Чек мне в личку ✅' },
    { author: 'Динара', authorId: 'u4', minutesAgo: 50, text: 'Вот мои выплаты, всё честно! Спасибо организатору' },
    { author: 'Самат', authorId: 'u5', minutesAgo: 40, text: 'Осторожно, это признаки финансовой пирамиды. Не переводите деньги!' },
  ] }],
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'safenet-pipeline-'));
  const corpusPath = join(dir, 'corpus.json');
  writeFileSync(corpusPath, JSON.stringify(corpus));
  return { dir, corpusPath, statePath: join(dir, 'pipeline.json') };
}

test('pipeline routes risky items to the queue and clears benign ones automatically', () => {
  const { dir, corpusPath, statePath } = fixture();
  let cases = [];
  const pipeline = createPipeline({ statePath, corpusPath, getCases: () => cases, persistCases: next => { cases = next; }, analysisVersion: 'rules-v5' });
  pipeline.start();
  pipeline.close();
  const { snapshot } = pipeline.step(100);
  assert.equal(snapshot.processed, 5);
  assert.equal(snapshot.finished, true);
  assert.ok(snapshot.queued >= 3);
  assert.equal(cases.every(record => record.analysis.score >= QUEUE_THRESHOLD), true, 'only queued items become cases');
  assert.ok(!cases.some(record => record.pipeline.itemId === 'i3'), 'free contest is cleared, not queued');
  assert.equal(snapshot.log.find(entry => entry.id === 'i3').decision, 'cleared');
  for (const record of cases) {
    assert.equal(record.source, 'pipeline');
    assert.ok(Number.isFinite(record.priority));
    assert.ok(record.analysis.signals.every(signal => signal.label && signal.description));
  }
  rmSync(dir, { recursive: true, force: true });
});

test('a bare promo code reused by several flagged accounts lifts a comment as a known indicator', () => {
  const { dir, corpusPath, statePath } = fixture();
  let cases = [];
  const pipeline = createPipeline({ statePath, corpusPath, getCases: () => cases, persistCases: next => { cases = next; }, analysisVersion: 'rules-v5' });
  pipeline.start(); pipeline.close(); pipeline.step(100);
  assert.ok(analyzeContent({ text: corpus.items[3].text }).score < QUEUE_THRESHOLD, 'content alone is not enough');
  const comment = cases.find(record => record.pipeline.itemId === 'i4');
  assert.ok(comment, 'comment reaches the queue through the network');
  const signal = comment.analysis.signals.find(item => item.id === 'known_indicator');
  assert.equal(signal.quote, 'AZ777');
  assert.match(comment.analysis.translations.ru.signals.find(item => item.id === 'known_indicator').description, /не доказательство/);
  const networks = pipeline.networks();
  const casino = networks.networks.find(cluster => cluster.size >= 3);
  assert.ok(casino.shared.some(item => item.type === 'promo' && item.value === 'AZ777'));
  rmSync(dir, { recursive: true, force: true });
});

test('group chat analysis finds organizer, curators, template messages and keeps skeptics apart', () => {
  const result = analyzeGroup(corpus.groups[0]);
  assert.equal(result.analysis.category, 'pyramid');
  assert.ok(result.analysis.score >= 60);
  const role = name => result.roles.find(item => item.name === name).role;
  assert.equal(role('Айгерим'), 'organizer');
  assert.equal(role('Ерлан'), 'curator');
  assert.equal(role('Мадина'), 'curator');
  assert.equal(role('Самат'), 'skeptic');
  assert.ok(result.templates.some(cluster => cluster.size >= 3));
  assert.ok(result.analysis.signals.some(signal => signal.id === 'template_messages'));
  assert.equal(result.counterMessages[0].author, 'Самат');
});

test('template clusters and network keys use strong indicators only', () => {
  const clusters = templateClusters([
    { id: '1', author: 'a', text: 'Друзья, сегодня ещё 5 мест! Вклад 5 000 через 3 дня 10 000 Kaspi' },
    { id: '2', author: 'b', text: 'Друзья, сегодня ещё 4 места! Вклад 5 000 через 3 дня 10 000 Kaspi' },
    { id: '3', author: 'c', text: 'Совершенно другой текст про погоду и прогулку в парке сегодня вечером' },
  ]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].authors.sort(), ['a', 'b']);
  const keys = linkKeys(analyzeContent({ text: 'Промокод AZ777 https://www.instagram.com/x https://azart777.example/?ref=1 Kaspi +7 700 000 12 34' }));
  assert.ok(keys.some(([type, value]) => type === 'promo' && value === 'AZ777'));
  assert.ok(keys.some(([type, value]) => type === 'domain' && value === 'azart777.example'));
  assert.ok(!keys.some(([, value]) => value.includes('instagram.com')), 'platform domains never link accounts');
  const networks = buildNetworks([
    { id: 'x', accountKey: 'acc:1', handle: '@1', score: 70, category: 'casino', keys: [['promo', 'AZ777']] },
    { id: 'y', accountKey: 'acc:2', handle: '@2', score: 50, category: 'casino', keys: [['promo', 'AZ777']] },
    { id: 'z', accountKey: 'acc:3', handle: '@3', score: 0, category: 'none', keys: [] },
  ]);
  assert.equal(networks[0].size, 2);
  assert.equal(networks[0].shared[0].value, 'AZ777');
});

test('explainable model is deterministic and reports the terms behind its prediction', () => {
  const examples = [
    ...Array.from({ length: 6 }, (_, i) => ({ text: `вложи ${i + 5} 000 получи вдвое больше пассивный доход куратор каспи ${i}`, label: 'pyramid' })),
    ...Array.from({ length: 6 }, (_, i) => ({ text: `купи номер розыгрыш рандомайзер слот ${i} оплата каспи`, label: 'lottery' })),
    ...Array.from({ length: 6 }, (_, i) => ({ text: `сегодня хорошая погода гуляем в парке ${i} с семьёй`, label: 'none' })),
  ];
  const a = trainModel(examples, { epochs: 10 });
  const b = trainModel(examples, { epochs: 10 });
  assert.deepEqual(a.bias, b.bias);
  const model = compileModel(a);
  const prediction = predict(model, 'пассивный доход, вложи и получи вдвое больше, пиши куратору');
  assert.equal(prediction.label, 'pyramid');
  assert.ok(prediction.topTerms.length > 0);
  assert.ok(Math.abs(Object.values(prediction.probabilities).reduce((sum, value) => sum + value, 0) - 1) < 0.01);
});

test('queue, review decisions, review stats and batch screening API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'safenet-api-'));
  writeFileSync(join(dir, 'corpus.json'), JSON.stringify(corpus));
  const app = createApp({ storePath: join(dir, 'cases.json'), seed: false, corpusPath: join(dir, 'corpus.json'), autoPipeline: true, aiService: { status: async () => ({}), close() {} }, mediaService: { status: async () => ({}), close: async () => {} } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, options = {}) => { const response = await fetch(base + path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }); return { status: response.status, body: await response.json() }; };
  try {
    app.locals.pipeline.start();
    app.locals.pipeline.close();
    const step = await call('/api/pipeline/step', { method: 'POST', body: JSON.stringify({ count: 50 }) });
    assert.equal(step.status, 200);
    assert.equal(step.body.snapshot.finished, true);
    const queue = await call('/api/queue');
    assert.ok(queue.body.open.length >= 3);
    for (let i = 1; i < queue.body.open.length; i++) assert.ok(queue.body.open[i - 1].priority >= queue.body.open[i].priority, 'queue is ordered by priority');
    const target = queue.body.open[0];
    const reviewed = await call(`/api/cases/${target.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'escalated', reason: 'signs_confirmed', note: 'Передано' }) });
    assert.equal(reviewed.body.review.decision, 'escalated');
    assert.equal(reviewed.body.review.reason, 'signs_confirmed');
    const second = queue.body.open[1];
    await call(`/api/cases/${second.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'dismissed', reason: 'legal_ad' }) });
    const stats = await call('/api/review-stats');
    assert.equal(stats.body.total, 2);
    assert.equal(stats.body.decisions.escalated, 1);
    assert.equal(stats.body.decisions.dismissed, 1);
    assert.ok(stats.body.signals.length > 0);
    const reset = await call('/api/pipeline/reset', { method: 'POST', body: '{}' });
    assert.equal(reset.body.processed, 0);
    const after = (await call('/api/queue')).body;
    assert.equal(after.reviewed.length, 2, 'analyst decisions survive a demo restart');
    const screen = await call('/api/screen', { method: 'POST', body: JSON.stringify({ items: [{ id: 'a', text: 'Вложи 5000 тг — получи 10 000 тг через 3 дня! Kaspi куратору.' }, { id: 'b', text: 'Хорошего дня!' }] }) });
    assert.equal(screen.body.count, 2);
    assert.equal(screen.body.results[0].queue, true);
    assert.equal(screen.body.results[1].queue, false);
    assert.equal((await call('/api/screen', { method: 'POST', body: JSON.stringify({ items: [] }) })).status, 400);
    assert.equal((await call('/api/pipeline', { method: 'PUT', body: JSON.stringify({ rate: 999 }) })).status, 400);
  } finally {
    app.locals.pipeline.close();
    app.locals.watchtower.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
