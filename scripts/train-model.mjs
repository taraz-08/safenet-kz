// Trains the explainable n-gram model on development data only: the dev set, the validation half of the blind
// test set and the labelled demo stream. The holdout half is never used here. The hybrid threshold is chosen by
// 5-fold cross-validation on the training pool (precision first), then written to data/model.json.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { analyzeContent } from '../server/engine.mjs';
import { trainModel, compileModel, predict, CLASSES } from '../server/model.mjs';

const read = async name => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), 'utf8'));
const splitOf = id => (createHash('sha256').update(id).digest()[0] % 2 === 0 ? 'holdout' : 'validation');
const label = category => (CLASSES.includes(category) ? category : 'none');

const dev = await read('evaluation.json');
const test = await read('test-set.json');
const corpus = await read('stream/corpus.json');
const pool = [
  ...dev.cases.filter(item => item.expectedCategory !== 'phishing').map(item => ({ id: `dev:${item.id}`, text: item.text, label: label(item.expectedCategory) })),
  ...test.cases.filter(item => splitOf(item.id) === 'validation').map(item => ({ id: `val:${item.id}`, text: item.text, label: label(item.expectedCategory) })),
  ...corpus.items.map(item => ({ id: `stream:${item.id}`, text: [item.text, item.ocrText, item.transcript].filter(Boolean).join('\n'), label: label(item.groundTruth) })),
];

const THRESHOLD = 30;
const hybridRisk = (text, model, tau) => {
  const rules = analyzeContent({ text });
  if (rules.score >= THRESHOLD) return true;
  const prediction = predict(model, text);
  return prediction.label !== 'none' && prediction.probability >= tau && rules.riskContext !== 'warning_or_news';
};
const score = rows => {
  const c = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const row of rows) c[row.truth ? (row.pred ? 'tp' : 'fn') : (row.pred ? 'fp' : 'tn')]++;
  const precision = c.tp / (c.tp + c.fp || 1), recall = c.tp / (c.tp + c.fn || 1);
  return { ...c, precision, recall, f1: 2 * precision * recall / (precision + recall || 1) };
};

// 5-fold CV: out-of-fold predictions for every pool item. The rules were tuned on this pool, so the hybrid curve is
// optimistic; the threshold is therefore chosen on the model's OWN out-of-fold precision (≥ 0.9 for scheme labels).
const folds = 5;
const taus = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];
const outOfFold = new Map(taus.map(tau => [tau, []]));
const modelOnly = new Map(taus.map(tau => [tau, []]));
let categoryHits = 0;
for (let fold = 0; fold < folds; fold++) {
  const inFold = item => createHash('sha256').update(item.id).digest()[1] % folds === fold;
  const model = compileModel(trainModel(pool.filter(item => !inFold(item))));
  for (const item of pool.filter(inFold)) {
    const prediction = predict(model, item.text);
    if (prediction.label === item.label) categoryHits++;
    for (const tau of taus) {
      outOfFold.get(tau).push({ truth: item.label !== 'none', pred: hybridRisk(item.text, model, tau) });
      modelOnly.get(tau).push({ truth: item.label !== 'none', pred: prediction.label !== 'none' && prediction.probability >= tau });
    }
  }
}
const rulesOnly = score(pool.map(item => ({ truth: item.label !== 'none', pred: analyzeContent({ text: item.text }).score >= THRESHOLD })));
const curve = taus.map(tau => ({ tau, hybrid: score(outOfFold.get(tau)), model: score(modelOnly.get(tau)) }));
const chosen = curve.find(row => row.model.precision >= 0.9) ?? curve.at(-1);

const model = trainModel(pool);
await writeFile(new URL('../data/model.json', import.meta.url), JSON.stringify({
  ...model,
  hybridThreshold: chosen.tau,
  meta: {
    trainedAt: new Date().toISOString(), examples: pool.length,
    perClass: Object.fromEntries(CLASSES.map(name => [name, pool.filter(item => item.label === name).length])),
    sources: ['data/evaluation.json (dev, без фишинга)', 'data/test-set.json — только половина validation', 'data/stream/corpus.json (демо-поток)'],
    excluded: 'Половина holdout слепой выборки в обучение не входит и используется только для итоговой оценки.',
    crossValidation: { folds, rulesOnly, modelOutOfFoldCategoryAccuracy: Number((categoryHits / pool.length).toFixed(4)), curve, chosenThreshold: chosen.tau },
  },
}));
console.log(JSON.stringify({ examples: pool.length, categoryAccuracyOOF: (categoryHits / pool.length).toFixed(3), chosen: chosen.tau, curve: curve.map(row => `tau=${row.tau} model P=${row.model.precision.toFixed(3)} R=${row.model.recall.toFixed(3)} | hybrid P=${row.hybrid.precision.toFixed(3)} R=${row.hybrid.recall.toFixed(3)}`) }, null, 1));
