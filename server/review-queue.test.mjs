import test from 'node:test';
import assert from 'node:assert/strict';
import { QUEUE_THRESHOLD, addVia, parseFollowers, queuePriority, ruleBackedRisk } from './review-queue.mjs';

const analysis = (score, extra = {}) => ({ score, riskContext: 'offer_or_unknown', signals: [{ id: 'casino_mention' }], ...extra });

test('a live finding enters the queue only on rule evidence above the threshold, outside warnings', () => {
  assert.equal(QUEUE_THRESHOLD, 30);
  assert.equal(ruleBackedRisk(analysis(45)), true);
  assert.equal(ruleBackedRisk(analysis(29)), false);
  assert.equal(ruleBackedRisk(analysis(80, { riskContext: 'warning_or_news' })), false);
  assert.equal(ruleBackedRisk(analysis(60, { signals: [{ id: 'bonus' }, { id: 'ml_model' }] })), false);
});

test('priority follows the methodology: 0.8 × risk + reach (4 when followers are unknown) + 8 for a network link', () => {
  assert.deepEqual(queuePriority(70), { priority: 60, priorityParts: { risk: 56, reach: 4, network: 0 } });
  assert.deepEqual(queuePriority(70, 1_000_000, true), { priority: 76, priorityParts: { risk: 56, reach: 12, network: 8 } });
  assert.equal(queuePriority(50, 1816).priorityParts.reach, 7);
});

test('follower counts are read as shown by Instagram and TikTok', () => {
  assert.equal(parseFollowers('1 816 подписчиков'), 1816);
  assert.equal(parseFollowers('12,3 тыс.'), 12300);
  assert.equal(parseFollowers('12.3K'), 12300);
  assert.equal(parseFollowers('1,2 млн'), 1_200_000);
  assert.equal(parseFollowers('292'), 292);
  assert.equal(parseFollowers(''), null);
  assert.equal(parseFollowers(undefined), null);
});

test('how-found paths are recorded once each and capped', () => {
  const first = { from: 'telegram:alpha', kind: 'telegram_link' };
  assert.deepEqual(addVia([], first), [first]);
  assert.deepEqual(addVia([first], { ...first }), [first]);
  const many = Array.from({ length: 8 }, (_, i) => ({ from: `x${i}`, kind: 'mention' }));
  assert.equal(addVia(many, { from: 'y', kind: 'mention' }).length, 8);
  assert.deepEqual(addVia([first], null), [first]);
});
