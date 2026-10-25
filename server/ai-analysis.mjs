import { localizeAnalysis } from './engine.mjs';

const CATEGORY_MAP = { gambling: 'casino', betting: 'casino', phishing: 'phishing', investment_scam: 'pyramid' };
const COPY = {
  ru: {
    label: 'Предварительное наблюдение локальной ИИ-модели',
    description: 'Модель оценила переданный кадр или расшифровку. Это вывод модели, а не дословная цитата и не доказательство нарушения. Описание наблюдений сохранено отдельно.',
    summary: 'Локальная ИИ-модель обнаружила признаки, требующие проверки. Сверьте её наблюдения с исходным кадром или словами; это не доказательство мошенничества.',
    note: 'Проверены распознанные слова и выбранный кадр или расшифровка локальной ИИ-моделью. Остальные части видео не проверены; распознавание и выводы модели могут быть ошибочными.',
    initial: 'Результат объединяет объяснимые правила и предварительные наблюдения локальной модели. Балл — эвристика, а не вероятность мошенничества.',
  },
  kk: {
    label: 'Жергілікті ЖИ моделінің бастапқы байқауы',
    description: 'Модель берілген кадрды немесе дыбыс мәтінін бағалады. Бұл — модель тұжырымы, сөзбе-сөз дәйексөз не заң бұзудың дәлелі емес. Байқаулар сипаттамасы бөлек сақталған.',
    summary: 'Жергілікті ЖИ моделі тексеруді қажет ететін белгілерді тапты. Оның байқауын бастапқы кадрмен немесе сөздермен салыстырыңыз; бұл алаяқтықтың дәлелі емес.',
    note: 'Танылған сөздер және таңдалған кадр немесе дыбыс мәтіні жергілікті ЖИ моделімен тексерілді. Видеоның қалған бөлігі тексерілген жоқ; тану мен модель қорытындысы қате болуы мүмкін.',
    initial: 'Нәтиже түсіндірілетін ережелер мен жергілікті модельдің бастапқы байқауын біріктіреді. Балл — эвристикалық баға, алаяқтық ықтималдығы емес.',
  },
};

/** Never re-run text rules on generated descriptions: model output is not source evidence. */
export function mergeAiAnalysis(original, ai, locale = 'kk') {
  const analysis = structuredClone(original);
  analysis.ai = structuredClone(ai);
  if (!ai?.ok || ai.status !== 'completed' || !Number.isFinite(ai.risk?.score) || ai.risk.score < 0 || ai.risk.score > 100) return analysis;
  const priorScore = analysis.score;
  const category = CATEGORY_MAP[ai.category];
  analysis.score = Math.max(priorScore, ai.risk.score);
  analysis.level = analysis.score >= 60 ? 'high' : analysis.score >= 30 ? 'medium' : 'low';
  analysis.method = 'rules_and_local_model';
  if (category && ai.risk.score > priorScore && ai.risk.score >= 25) analysis.category = category;
  if (category) {
    analysis.categories = analysis.categories.map(item => item.id === category ? { ...item, score: Math.max(item.score, ai.risk.score) } : item).sort((a, b) => b.score - a.score);
  }
  const modelSignal = ai.risk.score > 0 && ai.observations.length > 0 ? {
    id: 'local_model_observation', category: ai.context === 'news_or_warning' ? 'context' : category || 'context',
    weight: Math.max(0, ai.risk.score - priorScore), quote: '', method: 'model_inference', model: ai.model,
    label: COPY.kk.label, description: COPY.kk.description,
  } : null;
  if (modelSignal) analysis.signals.push(modelSignal);
  if (analysis.riskContext === 'warning_or_news' && ai.context === 'promotion') analysis.riskContext = 'mixed_requires_review';
  else if (priorScore < 25 && ai.context === 'news_or_warning') analysis.riskContext = 'warning_or_news';
  else if (ai.risk.score > priorScore && ai.promotional) analysis.riskContext = 'requires_review';
  analysis.riskContextMethod = 'rules_and_local_model';
  for (const language of ['ru', 'kk']) {
    const copy = COPY[language];
    const translated = analysis.translations[language];
    translated.limitations[0] = copy.initial;
    translated.limitations[2] = copy.note;
    if (ai.risk.score > priorScore && ai.risk.score >= 30) translated.summary = copy.summary;
    if (modelSignal) translated.signals.push({ id: modelSignal.id, label: copy.label, description: copy.description });
  }
  return localizeAnalysis(analysis, locale);
}
