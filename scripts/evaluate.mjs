import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { analyzeContent, screenContent } from '../server/engine.mjs';

// Dev set: written together with the rules (tuning only). Test set: authored blind by a separate agent from the
// hackathon brief, without access to the rules. The test set is split deterministically: "validation" may be
// inspected for error analysis, "holdout" is only ever reported in aggregate.
const THRESHOLD = 30;
const labels = ['none', 'lottery', 'casino', 'pyramid', 'phishing'];
const divide = (numerator, denominator) => denominator ? Number((numerator / denominator).toFixed(6)) : null;
const splitOf = id => (createHash('sha256').update(id).digest()[0] % 2 === 0 ? 'holdout' : 'validation');

async function load(name) {
  const url = new URL(`../data/${name}`, import.meta.url);
  if (!existsSync(url)) return null;
  const raw = await readFile(url, 'utf8');
  return { raw, dataset: JSON.parse(raw) };
}

function binaryOf(rows) {
  const confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const row of rows) confusion[row.expectedRisk ? (row.predictedRisk ? 'tp' : 'fn') : (row.predictedRisk ? 'fp' : 'tn')]++;
  const precision = divide(confusion.tp, confusion.tp + confusion.fp);
  const recall = divide(confusion.tp, confusion.tp + confusion.fn);
  return {
    total: rows.length, confusionMatrix: confusion, precision, recall,
    f1: divide(2 * confusion.tp, 2 * confusion.tp + confusion.fp + confusion.fn),
    falsePositiveRate: divide(confusion.fp, confusion.fp + confusion.tn),
    accuracy: divide(confusion.tp + confusion.tn, rows.length),
    categoryAccuracy: divide(rows.filter(row => row.expectedCategory === row.predictedCategory).length, rows.length),
  };
}

function evaluate(dataset, analyze = screenContent) {
  const ids = new Set();
  const rows = dataset.cases.map(example => {
    if (ids.has(example.id) || !labels.includes(example.expectedCategory) || typeof example.expectedRisk !== 'boolean') throw new Error(`Invalid or duplicate case: ${example.id}`);
    ids.add(example.id);
    const actual = analyze(example);
    return {
      id: example.id, expectedCategory: example.expectedCategory, predictedCategory: actual.score >= THRESHOLD ? actual.category : 'none',
      expectedRisk: example.expectedRisk, predictedRisk: actual.score >= THRESHOLD, score: actual.score, level: actual.level,
      band: actual.signals.some(signal => signal.id === 'ml_model') ? 'model' : 'rules',
      language: example.language ?? null, modality: example.modality ?? null, hardNegative: example.hardNegative ?? null, difficulty: example.difficulty ?? null,
      split: splitOf(example.id),
    };
  });
  return { ...breakdown(rows), splits: { validation: binaryOf(rows.filter(row => row.split === 'validation')), holdout: binaryOf(rows.filter(row => row.split === 'holdout')) },
    // The model was trained on the validation half, so per-track/language/negative breakdowns are reported on holdout.
    holdoutBreakdown: (({ perCategory, byLanguage, byModality, hardNegatives, thresholdCurve }) => ({ perCategory, byLanguage, byModality, hardNegatives, thresholdCurve }))(breakdown(rows.filter(row => row.split === 'holdout'))), rows };
}

function breakdown(rows) {
  const matrix = Object.fromEntries(labels.map(label => [label, Object.fromEntries(labels.map(prediction => [prediction, 0]))]));
  for (const row of rows) matrix[row.expectedCategory][row.predictedCategory]++;
  const perCategory = Object.fromEntries(labels.filter(label => rows.some(row => row.expectedCategory === label || row.predictedCategory === label)).map(label => {
    const tp = matrix[label][label];
    const fp = labels.filter(other => other !== label).reduce((sum, other) => sum + matrix[other][label], 0);
    const fn = labels.filter(other => other !== label).reduce((sum, other) => sum + matrix[label][other], 0);
    return [label, { support: tp + fn, precision: divide(tp, tp + fp), recall: divide(tp, tp + fn), f1: divide(2 * tp, 2 * tp + fp + fn) }];
  }));
  const groupBy = key => Object.fromEntries([...new Set(rows.map(row => row[key]).filter(Boolean))].sort().map(value => [value, binaryOf(rows.filter(row => row[key] === value))]));
  const hardNegatives = Object.fromEntries([...new Set(rows.map(row => row.hardNegative).filter(Boolean))].sort().map(type => {
    const group = rows.filter(row => row.hardNegative === type);
    return [type, { total: group.length, falsePositives: group.filter(row => row.predictedRisk).length, falsePositiveRate: divide(group.filter(row => row.predictedRisk).length, group.length) }];
  }));
  const thresholdCurve = [10, 20, 25, 30, 40, 50, 60, 70].map(threshold => {
    const curve = binaryOf(rows.map(row => ({ ...row, predictedRisk: row.score >= threshold })));
    return { threshold, precision: curve.precision, recall: curve.recall, falsePositiveRate: curve.falsePositiveRate, f1: curve.f1 };
  });
  const levels = Object.fromEntries(['low', 'medium', 'high'].map(level => {
    const group = rows.filter(row => row.level === level);
    return [level, { total: group.length, risky: group.filter(row => row.expectedRisk).length, share: divide(group.filter(row => row.expectedRisk).length, group.length) }];
  }));
  return {
    ...binaryOf(rows), categoryConfusionMatrix: matrix, perCategory, levels,
    byLanguage: groupBy('language'), byModality: groupBy('modality'), byDifficulty: groupBy('difficulty'), hardNegatives, thresholdCurve,
    // Precision of what reaches the queue, by who raised it: rule-backed cases vs cases raised only by the model.
    bands: Object.fromEntries(['rules', 'model'].map(band => { const flagged = rows.filter(row => row.predictedRisk && row.band === band); const holdout = flagged.filter(row => row.split === 'holdout'); return [band, { flagged: flagged.length, precision: divide(flagged.filter(row => row.expectedRisk).length, flagged.length), holdoutFlagged: holdout.length, holdoutPrecision: divide(holdout.filter(row => row.expectedRisk).length, holdout.length) }]; })),
  };
}

function benchmark(dataset) {
  const texts = dataset.cases.map(item => item.text);
  const runs = Math.max(1, Math.ceil(5000 / texts.length));
  const start = performance.now();
  for (let i = 0; i < runs; i++) for (const text of texts) screenContent({ text });
  const elapsed = performance.now() - start;
  const count = runs * texts.length;
  return { items: count, seconds: Number((elapsed / 1000).toFixed(2)), itemsPerSecond: Math.round(count / (elapsed / 1000)), msPerItem: Number((elapsed / count).toFixed(3)), note: 'Один поток Node.js на локальном компьютере: правила + n-граммная модель (без OCR/ASR/ИИ).' };
}

const dev = await load('evaluation.json');
const test = await load('test-set.json');
const engineSource = await readFile(new URL('../server/engine.mjs', import.meta.url));
const devResult = evaluate(dev.dataset);
const testResult = test ? evaluate(test.dataset) : null;
// Rules alone, for comparison: shows what the statistical layer adds on data it never saw (holdout).
const rulesOnly = result => result && { ...Object.fromEntries(['total', 'precision', 'recall', 'f1', 'falsePositiveRate', 'categoryAccuracy', 'confusionMatrix'].map(key => [key, result[key]])), splits: result.splits };
const devRules = evaluate(dev.dataset, analyzeContent);
const testRules = test ? evaluate(test.dataset, analyzeContent) : null;
const metrics = {
  name: 'SafeNet KZ evaluation',
  generatedAt: new Date().toISOString(),
  threshold: THRESHOLD,
  engineSha256: createHash('sha256').update(engineSource).digest('hex'),
  disclaimer: 'Синтетические данные. Метрики описывают поведение правил на этих наборах и не равны точности на реальном потоке соцсетей.',
  dev: { name: dev.dataset.name, provenance: dev.dataset.provenance, sha256: createHash('sha256').update(dev.raw).digest('hex'), ...devResult, errors: devResult.rows.filter(row => row.expectedRisk !== row.predictedRisk || row.expectedCategory !== row.predictedCategory) },
  test: testResult ? { name: test.dataset.name, provenance: test.dataset.provenance, sha256: createHash('sha256').update(test.raw).digest('hex'), ...testResult,
    // Holdout rows are never listed individually; validation errors are available for analysis.
    rows: undefined, validationErrors: testResult.rows.filter(row => row.split === 'validation' && (row.expectedRisk !== row.predictedRisk || row.expectedCategory !== row.predictedCategory)) } : null,
  rulesOnly: { dev: rulesOnly(devRules), test: rulesOnly(testRules) },
  // Snapshot taken before anyone looked at the test set (engine frozen, whole set, rules only).
  blindFirstRun: (() => { try { const first = JSON.parse(readFileSync(new URL('../data/metrics-blind-first-run.json', import.meta.url), 'utf8')).test; return first && { total: first.total, precision: first.precision, recall: first.recall, f1: first.f1, falsePositiveRate: first.falsePositiveRate, engineSha256: first.sha256 ? undefined : undefined }; } catch { return null; } })(),
  model: (() => { try { const raw = JSON.parse(readFileSync(new URL('../data/model.json', import.meta.url), 'utf8')); return { hybridThreshold: raw.hybridThreshold, meta: raw.meta }; } catch { return null; } })(),
  benchmark: benchmark(test?.dataset ?? dev.dataset),
};
// Backward-compatible top-level fields for older UI widgets: they describe the held-out test set when present.
const headline = metrics.test ?? metrics.dev;
Object.assign(metrics, { total: headline.total, accuracy: headline.accuracy, precision: headline.precision, recall: headline.recall, f1: headline.f1, falsePositiveRate: headline.falsePositiveRate, confusionMatrix: headline.confusionMatrix, categoryAccuracy: headline.categoryAccuracy, perCategory: headline.perCategory, provenance: headline.provenance });
delete metrics.dev.rows;
await writeFile(new URL('../data/metrics.json', import.meta.url), `${JSON.stringify(metrics, null, 2)}\n`);
const brief = result => result && ({ total: result.total, precision: result.precision, recall: result.recall, f1: result.f1, falsePositiveRate: result.falsePositiveRate, categoryAccuracy: result.categoryAccuracy, confusion: result.confusionMatrix });
console.log(JSON.stringify({ rulesHoldout: metrics.test && brief(testRules.splits.holdout), dev: brief(metrics.dev), test: brief(metrics.test), holdout: metrics.test && brief(metrics.test.splits.holdout), validation: metrics.test && brief(metrics.test.splits.validation), benchmark: metrics.benchmark }, null, 2));
