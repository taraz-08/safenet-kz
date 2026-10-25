/** SafeNet KZ — when a material enters the review queue and in what order (see docs/METHODOLOGY.md, priority). */

export const QUEUE_THRESHOLD = 30;

/** Live public sources (Telegram, Instagram, TikTok) queue a material only on rule evidence outside a warning context. */
export function ruleBackedRisk(analysis) {
  return analysis.score >= QUEUE_THRESHOLD && analysis.riskContext !== 'warning_or_news' && !analysis.signals.some(signal => signal.id === 'ml_model');
}

/** "1 816", "12,3 тыс.", "12.3K", "1,2 млн" → a number of followers; null when the page did not show it. */
export function parseFollowers(text) {
  const match = /(\d[\d\s]*(?:[.,]\d+)?)\s*(k|к|тыс\.?|m|м|млн)?/iu.exec(String(text ?? ''));
  if (!match) return null;
  const value = Number(match[1].replace(/\s/g, '').replace(',', '.'));
  const unit = (match[2] ?? '').toLowerCase();
  const scale = /^(?:k|к|тыс)/u.test(unit) ? 1e3 : /^(?:m|м|млн)/u.test(unit) ? 1e6 : 1;
  return Number.isFinite(value) ? Math.round(value * scale) : null;
}

/** Risk first; audience reach (4 of 12 when unknown) and a network link only order cases of similar risk. */
export function queuePriority(score, followers = null, network = false) {
  const reach = followers ? Math.min(1, Math.log10(Math.max(10, followers)) / 6) : 0.3;
  const priorityParts = { risk: Math.round(score * 0.8), reach: Math.round(reach * 12), network: network ? 8 : 0 };
  return { priority: priorityParts.risk + priorityParts.reach + priorityParts.network, priorityParts };
}

/** Adds one "how it was found" step, once per source and kind. */
export function addVia(list, via, limit = 8) {
  if (!via || list.some(item => item.from === via.from && item.kind === via.kind)) return list;
  return [...list, via].slice(0, limit);
}
