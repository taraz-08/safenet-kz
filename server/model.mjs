/** SafeNet KZ — explainable statistical layer: softmax regression over hashed character and word n-grams.
 *  It only adds a bounded, explained signal next to the rules; it never decides on its own. */
import { readFileSync, existsSync } from 'node:fs';

export const CLASSES = ['none', 'lottery', 'casino', 'pyramid'];
const DIMENSIONS = 1 << 17;

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash >>> 0;
}

export function normalizeText(text) {
  return String(text ?? '').slice(0, 6000).normalize('NFKC').toLowerCase().replace(/[​-‍⁠﻿]/gu, '')
    .replace(/https?:\/\/\S+/gu, ' urltoken ').replace(/\d[\d\s]{2,}/gu, ' numtoken ').replace(/\d+/gu, '0');
}

/** Character 3–5-grams inside words + word unigrams/bigrams. Returns Map(featureString → count). */
export function featuresOf(text) {
  const normalized = normalizeText(text);
  const words = normalized.match(/[\p{L}\p{N}%₸@#]+|[\u{1F300}-\u{1FAFF}☀-➿]/gu) ?? [];
  const features = new Map();
  const bump = key => features.set(key, (features.get(key) ?? 0) + 1);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    bump(`w:${word}`);
    if (i + 1 < words.length) bump(`b:${word} ${words[i + 1]}`);
    const padded = `<${word}>`;
    for (let n = 3; n <= 5; n++) for (let j = 0; j + n <= padded.length; j++) bump(`c:${padded.slice(j, j + n)}`);
  }
  return features;
}

function vectorize(features) {
  const vector = new Map();
  let norm = 0;
  for (const [key, count] of features) {
    const value = 1 + Math.log(count);
    const index = fnv1a(key) % DIMENSIONS;
    vector.set(index, (vector.get(index) ?? 0) + value);
  }
  for (const value of vector.values()) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (const [index, value] of vector) vector.set(index, value / norm);
  return vector;
}

function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map(value => Math.exp(value - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(value => value / sum);
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return state / 4294967296; };
}

/** Deterministic SGD training with L2 regularization and class weighting. */
export function trainModel(examples, { epochs = 40, learningRate = 0.5, l2 = 1e-5, seed = 7 } = {}) {
  const weights = CLASSES.map(() => new Float64Array(DIMENSIONS));
  const bias = new Float64Array(CLASSES.length);
  const data = examples.map(example => ({ vector: vectorize(featuresOf(example.text)), label: CLASSES.indexOf(example.label) })).filter(item => item.label >= 0);
  const counts = CLASSES.map((_, index) => data.filter(item => item.label === index).length || 1);
  const classWeight = counts.map(count => data.length / (CLASSES.length * count));
  const random = seededRandom(seed);
  for (let epoch = 0; epoch < epochs; epoch++) {
    const order = data.map((_, index) => index);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const rate = learningRate / (1 + epoch * 0.15);
    for (const index of order) {
      const { vector, label } = data[index];
      const logits = CLASSES.map((_, c) => { let sum = bias[c]; for (const [f, v] of vector) sum += weights[c][f] * v; return sum; });
      const probabilities = softmax(logits);
      for (let c = 0; c < CLASSES.length; c++) {
        const gradient = (probabilities[c] - (c === label ? 1 : 0)) * classWeight[label];
        bias[c] -= rate * gradient;
        for (const [f, v] of vector) weights[c][f] -= rate * (gradient * v + l2 * weights[c][f]);
      }
    }
  }
  return { classes: CLASSES, dimensions: DIMENSIONS, bias: [...bias], weights: weights.map(row => {
    const sparse = {};
    for (let f = 0; f < row.length; f++) if (Math.abs(row[f]) > 1e-4) sparse[f] = Number(row[f].toFixed(5));
    return sparse;
  }) };
}

export function compileModel(raw) {
  const weights = raw.weights.map(row => { const map = new Map(); for (const [key, value] of Object.entries(row)) map.set(Number(key), value); return map; });
  return { ...raw, weights };
}

/** Class probabilities plus the n-grams that pushed the winning class up (for the explanation). */
export function predict(model, text) {
  const features = featuresOf(text);
  const vector = vectorize(features);
  const logits = model.classes.map((_, c) => { let sum = model.bias[c]; for (const [f, v] of vector) sum += (model.weights[c].get(f) ?? 0) * v; return sum; });
  const probabilities = softmax(logits);
  const best = probabilities.indexOf(Math.max(...probabilities));
  const contributions = [];
  for (const [key] of features) {
    if (!key.startsWith('w:') && !key.startsWith('b:')) continue;
    const f = fnv1a(key) % model.dimensions;
    const value = (model.weights[best].get(f) ?? 0) - (model.weights[0].get(f) ?? 0);
    if (value > 0) contributions.push([key.slice(2), value]);
  }
  contributions.sort((a, b) => b[1] - a[1]);
  return { label: model.classes[best], probability: probabilities[best], probabilities: Object.fromEntries(model.classes.map((name, index) => [name, Number(probabilities[index].toFixed(4))])), topTerms: contributions.slice(0, 6).map(([term]) => term) };
}

let cached;
export function loadModel(path = new URL('../data/model.json', import.meta.url)) {
  if (cached !== undefined) return cached;
  try { cached = existsSync(path) ? compileModel(JSON.parse(readFileSync(path, 'utf8'))) : null; } catch { cached = null; }
  return cached;
}
export function resetModelCache() { cached = undefined; }
