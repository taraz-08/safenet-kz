import { writeFileSync } from 'node:fs';
import { createAiService } from '../server/ai.mjs';

const ai = createAiService();
const fixtures = [
  { name: 'provided-kazakh-promotion', locale: 'kk', transcript: 'Казиноға тіркеліңіз. Промокодты енгізіп, депозит салыңыз және бонус алыңыз.', expectedContext: 'promotion' },
  { name: 'provided-russian-warning', locale: 'ru', transcript: 'Полиция предупреждает: не переводите деньги в онлайн-казино. Обещания бонусов и легкого заработка — признаки обмана.', expectedContext: 'news_or_warning' },
];
const report = { createdAt: new Date().toISOString(), scope: 'Provided synthetic text; not recorded audio and not live Instagram content', results: [] };
try {
  for (const fixture of fixtures) {
    const result = await ai.analyze({ transcript: fixture.transcript, locale: fixture.locale });
    const passed = result.ok && result.context === fixture.expectedContext && result.promotional === (fixture.expectedContext === 'promotion');
    report.results.push({ ...fixture, result, passed });
    console.log(JSON.stringify({ name: fixture.name, result, passed }));
  }
  report.passed = report.results.every(item => item.passed);
  writeFileSync('qa/ai-language-context-verification.json', JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally { ai.close(); }
