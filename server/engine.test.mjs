import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeContent, analyzeItem, localizeAnalysis } from './engine.mjs';

test('stable complete schema for empty and absent input', () => {
  for (const input of [undefined, {}, { text: '' }, { text: null }]) {
    const result = analyzeContent(input);
    assert.equal(result.score, 0);
    assert.equal(result.level, 'low');
    assert.equal(result.category, 'none');
    assert.equal(result.categories.length, 4);
    assert.ok(Array.isArray(result.signals));
    assert.deepEqual(result.entities, { urls: [], domains: [], handles: [], phones: [], emails: [], wallets: [], cards: [], promoCodes: [], inviteLinks: [], shortLinks: [], referralLinks: [] });
    assert.deepEqual(result.elements, []);
    assert.equal(result.track, null);
    assert.ok(result.summary && result.limitations.length);
  }
});

test('track 1: paid numbers, random draw and organizer income form the lottery elements', () => {
  const text = 'РОЗЫГРЫШ iPhone 🔥 1 номер = 1000 тг, всего 150 номеров. Оплата на Kaspi Gold, чек в директ. Крутим колесо в прямом эфире!';
  const result = analyzeContent({ text });
  assert.equal(result.category, 'lottery');
  assert.equal(result.track, 1);
  assert.equal(result.level, 'high');
  const present = Object.fromEntries(result.elements.map(item => [item.id, item.present]));
  assert.deepEqual(present, { paid_entry: true, random_selection: true, organizer_income: true, repetition: false });
  for (const signal of result.signals) assert.ok(text.includes(signal.quote), signal.quote);
});

test('track 1: free contest with randomizer stays low and explains why', () => {
  for (const text of [
    'РОЗЫГРЫШ 🎁 Условия: подпишись, поставь лайк и отметь двух друзей. Участие бесплатное. Победителя выберем рандомайзером.',
    'Ұтыс! Шарттары: парақшаға жазылу, лайк басу. Қатысу тегін. Жеңімпазды дөңгелек арқылы кездейсоқ таңдаймыз.',
    'Лотерея в нашем приложении бесплатная: покупать билет не требуется.',
  ]) {
    const result = analyzeContent({ text });
    assert.equal(result.level, 'low', text);
    assert.ok(!result.signals.some(item => item.id === 'entry_payment'), text);
  }
  assert.ok(analyzeContent({ text: 'Розыгрыш! Подпишись и поставь лайк, участие бесплатное.' }).signals.some(item => item.id === 'free_entry_context'));
  assert.equal(analyzeContent({ text: 'Номер на двоих — 15 000 тг/сутки, оплата на Kaspi.' }).level, 'low', 'hotel rooms are not lottery numbers');
});

test('track 2: hidden promotion without the word casino is found through wins plus a route', () => {
  for (const text of [
    'Поднял 380к за вечер 💰 Промокод AZ777 даёт +150% к первому депу, ссылка в шапке профиля.',
    'Вывел 250 000 на Kaspi за 5 минут 🤑 Как я поднял — пишите в лс за ссылкой.',
    'Рабочее зеркало на сегодня: https://az777-mirror.example — старый сайт заблокирован.',
  ]) {
    const result = analyzeContent({ text });
    assert.equal(result.category, 'casino', text);
    assert.ok(result.score >= 30, text);
  }
  assert.equal(analyzeContent({ text: 'Мой выигрыш на школьной олимпиаде — первое место!' }).level, 'low');
  assert.equal(analyzeContent({ text: 'Промокод SALE20 даёт скидку 20% на всю обувь.' }).level, 'low');
});

test('track 2: masking, referral and shortened links are explained', () => {
  const masked = analyzeContent({ text: 'Играй в к4з1н0! Бонус тут bit.ly/az7bonus' });
  assert.equal(masked.category, 'casino');
  assert.ok(masked.signals.some(item => item.id === 'obfuscation'));
  assert.ok(masked.signals.some(item => item.id === 'short_link'));
  const referral = analyzeContent({ text: 'Заносы недели: x500 на слоте. Регистрация https://spingold.example/?ref=blogger12' });
  assert.ok(referral.signals.some(item => item.id === 'referral_link' && item.quote.includes('ref=')));
  assert.deepEqual(referral.entities.referralLinks, ['https://spingold.example/?ref=blogger12']);
  const spaced = analyzeContent({ text: 'k a z i n o с моментальным выводом, депни 2000. Все ссылки в закрепе.' });
  assert.equal(spaced.category, 'casino');
  assert.equal(analyzeContent({ text: 'Стрим по Dota 2! Крутим колесо фортуны, донат-ссылка в описании. Без ставок и казино.' }).level, 'low');
});

test('track 3: Kaspi, curators, proofs and translit returns form pyramid elements', () => {
  const text = 'Вложи 5000 тг — получи 10 000 тг через 3 дня! Переводи на Kaspi куратору, осталось 3 места. Приведи друга и получи бонус.';
  const result = analyzeContent({ text });
  assert.equal(result.category, 'pyramid');
  assert.equal(result.track, 3);
  const present = Object.fromEntries(result.elements.map(item => [item.id, item.present]));
  assert.equal(present.unrealistic_return, true);
  assert.equal(present.pressure, true);
  assert.equal(present.referral, true);
  assert.equal(present.payment_channel, true);
  assert.equal(present.structure, true);
  assert.equal(analyzeContent({ text: 'Vlozhi 10 000 tg, cherez nedelyu poluchish 30 000 tg. Garantiya 100%, perevod na kaspi.' }).category, 'pyramid');
  assert.equal(analyzeContent({ text: 'Vlozhi 10 000 tg, cherez nedelyu poluchish 30 000 tg.' }).language, 'translit');
  assert.equal(analyzeContent({ text: 'Салым 10 000 ₸ → 3 күннен кейін 25 000 ₸ аласыз! Kaspi-ге аударыңыз, кураторға скрин жіберіңіз.' }).category, 'pyramid');
});

test('charity, class collections and law-enforcement news with scheme words stay low', () => {
  for (const text of [
    'Сбор на операцию для Алии: Kaspi Gold 4400 **** **** 5521, получатель — мама.',
    'Родительский чат: собираем по 3000 тг на подарок учителю, переводите на Kaspi до пятницы.',
    'АФМ пресекла деятельность финансовой пирамиды. По данным следствия, организаторы обещали доход 30% в месяц и бонусы за приглашение друзей.',
    'В Шымкенте задержаны организаторы незаконного онлайн-казино. Через блогеров они распространяли промокоды и ссылки на зеркала сайта.',
    'Как распознать пирамиду: x2 за неделю, «осталось 3 места», бонусы за приглашённых. Будьте бдительны!',
  ]) assert.equal(analyzeContent({ text }).level, 'low', text);
});

test('false positives seen on live public Telegram posts stay low', () => {
  for (const text of [
    '​Базалық мөлшерлеме. Комитет базалық мөлшерлемені жылдық 15,75% деңгейінде белгіледі. Базовая ставка на уровне 15,75% годовых.',
    '⚡️Подработка с телефона! 💯 БЕЗ ВЛОЖЕНИЙ! Писать отзывы, задания на лайки. 💯Никаких вложений нет! 💰Выплаты на карту. Все честно',
    'Удалённая работа: свободный график, стабильный доход, своевременные выплаты. Контакт @hr_contact',
    'Концерт в Кремле. Гостей ждут игры, конкурсы, розыгрыши призов. Кремлевский дворец 30 августа, 18:00 Билет от 1 500Р',
    'Патент: лимит снижается с 4–6 млн дохода. Самозанятым выплаты каждый месяц.',
    'Мастер-класс «Достучаться до hh»: краш-тест резюме. Переходите по ссылке, бонус участникам. Мест мало',
  ]) assert.equal(analyzeContent({ text }).level, 'low', text);
  assert.equal(analyzeContent({ text: 'Стабильный доход 30% в месяц, вложи от 10 000 тг' }).category, 'pyramid');
  assert.equal(analyzeContent({ text: 'Играй в ка​зино! Бонус 100%' }).signals.some(item => item.id === 'obfuscation'), true);
});

test('masked card numbers are stored masked and promo codes are normalized', () => {
  const result = analyzeContent({ text: 'Оплата на карту 4400 1234 5678 9012 или 4400 **** **** 1234. Промокод: spin50 / Промокод AZ777' });
  assert.deepEqual(result.entities.cards, ['4400 **** **** 9012', '4400 **** **** 1234']);
  assert.deepEqual(result.entities.promoCodes, ['AZ777']);
});

test('multimodal item keeps the source of each quote: caption, screenshot OCR or stream transcript', () => {
  const result = analyzeItem({ text: 'Вечерний эфир 🔥', ocrText: 'Промокод AZ777\nВывод 120 000 ₸', transcript: 'крутим слоты, занос! ссылка в описании, регайтесь' });
  assert.equal(result.category, 'casino');
  assert.deepEqual(result.modalities, ['text', 'ocrText', 'transcript']);
  assert.ok(result.signals.some(item => item.modality === 'transcript'));
  assert.ok(result.signals.some(item => item.modality === 'ocrText'));
});

test('paid lottery requires both giveaway and paid entry', () => {
  assert.equal(analyzeContent({ text: 'Розыгрыш машины! Купи билет за 1000 тг. Только сегодня!' }).category, 'lottery');
  assert.equal(analyzeContent({ text: 'Бесплатный розыгрыш книги. Подпишись и оставь комментарий, покупка не нужна.' }).level, 'low');
  assert.equal(analyzeContent({ text: 'Купи билет на концерт за 1000 тенге.' }).level, 'low');
});

test('Kazakh paid entry and original exact evidence', () => {
  const text = 'ҰТЫС! Қатысу үшін 2000 теңге аудар. Тек бүгін.';
  const result = analyzeContent({ text });
  assert.equal(result.category, 'lottery');
  assert.equal(result.level, 'high');
  assert.equal(result.language, 'kk');
  for (const signal of result.signals) assert.ok(text.includes(signal.quote), signal.quote);
});

test('casino promotion and mixed script evasion are recognized', () => {
  for (const text of ['Играй в казино, бонус 200% на депозит!', 'Играй в кaзинo! Промокод VIP.', 'Играй в ка\u200bзино! Бонус 100%']) {
    const result = analyzeContent({ text });
    assert.equal(result.category, 'casino', text);
    assert.equal(result.level, 'high', text);
    for (const signal of result.signals) assert.ok(text.includes(signal.quote), signal.quote);
  }
});

test('public entity candidates retain exact wallets and do not confuse email with a handle', () => {
  const wallet = '0x1234567890abcdef1234567890abcdef12345678';
  const result = analyzeContent({ text: `Контакт team@example.com, @public_account. Адрес ${wallet}. ${wallet}` });
  assert.deepEqual(result.entities.wallets, [wallet]);
  assert.deepEqual(result.entities.emails, ['team@example.com']);
  assert.ok(!result.entities.handles.includes('@example.com'));
  assert.equal(result.score, 0, 'An address or contact is not itself evidence of fraud');
  assert.deepEqual(analyzeContent({text: `${wallet}a`}).entities.wallets, []);
});

test('gambling news and anti-fraud education are not promotion', () => {
  for (const text of ['Полиция выявила незаконное казино. Бонусы привлекали людей.', 'Не играйте в казино: бонус на депозит не гарантирует выигрыш.', 'Мошенники обещают гарантированный доход 10% в день. Не переводите деньги!']) {
    const result = analyzeContent({ text });
    assert.equal(result.level, 'low', text);
    assert.ok(result.signals.some(item => item.id === 'prevention_context'));
    assert.equal(result.riskContext, 'warning_or_news');
  }
});

test('a warning word cannot hide a separate direct casino or investment solicitation', () => {
  for (const text of [
    'Осторожно! Казино! Пополни депозит, промокод BONUS. Переходи https://casino.example',
    'Не играйте в чужих казино. Пополни депозит в нашем казино и получи бонус!',
    'Сақ болыңыз! Казиноға тіркеліңіз, депозитті толықтырыңыз! Бонус алыңыз!',
    'Осторожно, мошенники! Гарантированный доход. Вложи 10000 тенге, получи 20000 тенге завтра.',
  ]) {
    const result=analyzeContent({text});
    assert.equal(result.riskContext,'mixed_requires_review',text);
    assert.equal(result.riskContextMethod,'rules');
    assert.equal(result.level,'high',text);
    assert.ok(result.signals.some(item=>item.id==='mixed_context'));
    assert.ok(!result.signals.some(item=>item.id==='prevention_context'));
    for(const basis of result.riskContextBasis)assert.ok(text.includes(basis.quote));
    assert.match(localizeAnalysis(result,'ru').summary,/Смешанный контекст/);
    assert.match(localizeAnalysis(result,'ru').signals.find(item=>item.id==='mixed_context').description,/не снижает/);
  }
});

test('reported, quoted and negated calls to act remain informational context', () => {
  for(const text of [
    'Осторожно, мошенники! «Пополни депозит. Играй в казино и получи бонус!» Не переводите деньги.',
    'Полиция выявила казино. "Пополни депозит и введи промокод" — такую рекламу публиковали в соцсети.',
    'Мошенники пишут: пополни депозит, играй в казино и получи бонус. Не переводите деньги!',
    'Не играйте в казино: бонус на депозит не гарантирует выигрыш.',
    'Сақ болыңыз! Алаяқтар жазады: «Казиноға тіркеліңіз! Депозитті толықтырыңыз!» Ақша аудармаңыз.',
    'Казино ойнамаңыз, депозитті толықтырмаңыз. Бонус табысқа кепіл емес.',
    'Алаяқтар ұсынады: казиноға тіркеліңіз, бонус үшін депозитті толықтырыңыз. Ақша аудармаңыз.',
    'Осторожно! Никогда не играйте в казино, не пополните депозит по чужой просьбе.',
  ]) {
    const result=analyzeContent({text});
    assert.equal(result.riskContext,'warning_or_news',text);
    assert.equal(result.level,'low',text);
    assert.ok(!result.signals.some(item=>item.id==='mixed_context'));
  }
});

test('context is classified independently even when no risk rules match',()=>{
  const report=analyzeContent({text:'Полиция предупреждает: проверьте источник сообщения.'});
  assert.equal(report.riskContext,'warning_or_news');assert.equal(report.score,0);
  const neutral=analyzeContent({text:'Сегодня хорошая погода.'});
  assert.equal(neutral.riskContext,'offer_or_unknown');assert.equal(neutral.score,0);
});

test('bank deposit, interest rate and ordinary referral do not imply pyramid', () => {
  for (const text of ['Банк предлагает депозит: 15% годовых. Условия договора на сайте.', 'Пригласи друзей в кофейню и получи бесплатный кофе.', 'Ставка по кредиту 12% годовых.']) {
    assert.equal(analyzeContent({ text }).level, 'low', text);
  }
});

test('pyramid detects promise, recruitment and rapid returns in both languages', () => {
  for (const text of ['Инвестиции без риска! Гарантированный доход 10% в день. Пригласи 3 друзей.', 'Кепілдендірілген табыс! Күніне емес: 20% күніне. Досыңды шақыр. Ақша сал.']) {
    const result = analyzeContent({ text });
    assert.equal(result.category, 'pyramid', text);
    assert.equal(result.level, 'high', text);
  }
});

test('phishing detects code theft and bank impersonation', () => {
  for (const text of ['Служба безопасности Kaspi: срочно пришли код из SMS, карта будет заблокирована.', 'Kaspi қолдау қызметі: SMS кодын маған жіберіңіз.']) {
    const result = analyzeContent({ text });
    assert.equal(result.category, 'phishing', text);
    assert.equal(result.level, 'high', text);
  }
});

test('brand suffix spoofing differs from a real subdomain', () => {
  const suspicious = analyzeContent({ text: 'Подтверди аккаунт', url: 'https://kaspi.kz.attacker.com/login' });
  const normal = analyzeContent({ text: 'Магазин', url: 'https://shop.kaspi.kz/' });
  assert.ok(suspicious.signals.some(item => item.id === 'brand_domain'));
  assert.equal(normal.score, 0);
  assert.ok(!normal.signals.some(item => item.id === 'brand_domain'));
});

test('supplied URL is not fetched and exposes lexical screening limits', () => {
  const result = analyzeContent({ url: 'https://unknown.example/something' });
  assert.equal(result.level, 'low');
  assert.deepEqual(result.entities.domains, ['unknown.example']);
  assert.ok(result.limitations.some(value => value.includes('ашылмайды')));
});

test('publication provenance never adds a caption link signal or score', () => {
  const url = 'https://www.instagram.com/p/real-post/';
  for (const text of [
    'Розыгрыш книги! Купи билет за 1000 тг.',
    'Играй в казино!',
    'Инвестиции. Гарантированный доход.',
    'Пришли код из SMS.',
  ]) {
    const withoutSource = analyzeContent({ text });
    const withSource = analyzeContent({ text, url, platform: 'instagram' });
    assert.equal(withSource.score, withoutSource.score, text);
    assert.deepEqual(withSource.signals, withoutSource.signals, text);
    assert.ok(!withSource.signals.some(signal => signal.id.startsWith('link_')), text);
    assert.deepEqual(withSource.entities.urls, [url], 'retain provenance for consumers');
    assert.deepEqual(withSource.entities.domains, ['www.instagram.com']);
  }
});

test('caption links remain evidence when a different publication URL is supplied', () => {
  const url = 'https://www.instagram.com/p/real-post/';
  const captionUrl = 'https://example.com/join';
  for (const [text, category, weight] of [
    ['Розыгрыш книги! Купи билет за 1000 тг.', 'lottery', 7],
    ['Играй в казино!', 'casino', 7],
    ['Инвестиции. Гарантированный доход.', 'pyramid', 7],
    ['Пришли код из SMS.', 'phishing', 12],
  ]) {
    const baseline = analyzeContent({ text, url });
    const result = analyzeContent({ text: `${text} ${captionUrl}`, url });
    const signal = result.signals.find(item => item.id === `link_${category}`);
    assert.equal(signal?.quote, captionUrl, text);
    assert.equal(result.score, baseline.score + weight, text);
    assert.deepEqual(result.entities.urls, [url, captionUrl]);
  }
});

test('publication URL does not hide a caption link-in-bio explanation', () => {
  const text = 'Играй в казино! Ссылка в био.';
  const result = analyzeContent({ text, url: 'https://www.instagram.com/reels/real-post/' });
  assert.ok(result.signals.some(signal => signal.id === 'bio_link_casino' && signal.quote === 'Ссылка в био'));
  assert.ok(!result.signals.some(signal => signal.id === 'link_casino'));
});

test('entity extraction trims punctuation and deduplicates URLs', () => {
  const result = analyzeContent({ text: 'Жазыңыз @safenet_kz, +7 (701) 123-45-67. https://example.com/test. https://example.com/test.' });
  assert.deepEqual(result.entities.urls, ['https://example.com/test']);
  assert.deepEqual(result.entities.domains, ['example.com']);
  assert.deepEqual(result.entities.handles, ['@safenet_kz']);
  assert.deepEqual(result.entities.phones, ['+7 (701) 123-45-67']);
});

test('scores bounded, duplicate rule instances never inflate score', () => {
  const content = 'Играй в казино! Бонус на депозит! Срочно!';
  const single = analyzeContent({ text: content });
  const repeated = analyzeContent({ text: content.repeat(50) });
  assert.equal(single.score, repeated.score);
  assert.ok(repeated.score >= 0 && repeated.score <= 100);
});

test('all normalized quotes remain literal substrings of original text', () => {
  const text = 'СРОЧНО! ИГРАЙ В КＡЗИНО, БОНУС на ДЕПОЗИТ!';
  const result = analyzeContent({ text });
  assert.ok(result.signals.length >= 3);
  for (const signal of result.signals) assert.ok(text.includes(signal.quote), signal.quote);
});

test('long input is bounded and explained', () => {
  const result = analyzeContent({ text: 'a'.repeat(40000) });
  assert.ok(result.limitations.some(value => value.includes('30 000')));
});

test('free Kazakh participation instructions and no-entry-fee raffle stay low', () => {
  for (const text of ['Ұтыс! Қатысу үшін парақшаға жазылыңыз. Қатысу тегін.', 'Free raffle, no entry fee! Comment to join.', 'Розыгрыш! Не нужно покупать билет, оставь комментарий.']) {
    assert.equal(analyzeContent({ text }).level, 'low', text);
  }
});

test('a scammers denial does not override high risk financial promises', () => {
  const text = 'Мы не мошенники! Инвестиции без риска. Доход 30% в день. Пригласи 3 друзей.';
  assert.equal(analyzeContent({ text }).level, 'high');
});

test('plain Cyrillic slot words are recognized', () => {
  assert.equal(analyzeContent({ text: 'Играй в слоты. Бонус новым игрокам.' }).category, 'casino');
});

test('paid numbers and randomizer are recognized as a lottery', () => {
  const text = 'Купи номер за 2000 тг, всего 100 слотов. Оплата переводом на Kaspi. Победителя выберет рандомайзер в прямом эфире.';
  const result = analyzeContent({ text });
  assert.equal(result.category, 'lottery');
  assert.equal(result.level, 'high');
});

test('numeric multiplication promise and spelled-out recruitment strengthen pyramid finding', () => {
  const text = 'Вложи 10000 тг и получи 20000 тг завтра. Гарантированный доход без риска. Пригласи двух друзей.';
  const result = analyzeContent({ text });
  assert.equal(result.category, 'pyramid');
  assert.equal(result.level, 'high');
  assert.ok(result.signals.some(item => item.id === 'numeric_return'));
  assert.ok(result.signals.some(item => item.id === 'recruitment'));
  for (const signal of result.signals) assert.ok(text.includes(signal.quote));
});

test('Kazakh numeric returns are detected without inventing evidence', () => {
  const text = '5000 теңге сал да, 10000 теңге ал!';
  const result = analyzeContent({ text });
  assert.equal(result.category, 'pyramid');
  assert.equal(result.level, 'medium');
  assert.equal(result.signals[0].quote, '5000 теңге сал да, 10000 теңге ал');
});

test('ordinary price pairs are not investment multiplication promises', () => {
  assert.equal(analyzeContent({ text: 'Кітап 5000 теңге, жинақ 10000 теңге. Екеуін салыстыр.' }).level, 'low');
});

test('Russian localization preserves scores, source quotes and other signal fields', () => {
  const text = 'Kaspi қолдау қызметі: SMS кодын маған жіберіңіз. Шұғыл!';
  const analysis = analyzeContent({ text, url: 'https://kaspi-help.example/login' });
  const before = structuredClone(analysis);
  const russian = localizeAnalysis(analysis, 'ru');
  assert.equal(russian.score, analysis.score);
  assert.equal(russian.level, analysis.level);
  assert.equal(russian.category, analysis.category);
  assert.deepEqual(russian.categories, analysis.categories);
  assert.deepEqual(russian.entities, analysis.entities);
  assert.equal(russian.language, analysis.language);
  assert.match(russian.summary, /признаков риска/);
  assert.match(russian.limitations[1], /Ссылки не открываются/);
  for (const [index, signal] of russian.signals.entries()) {
    assert.equal(signal.quote, analysis.signals[index].quote);
    assert.equal(signal.weight, analysis.signals[index].weight);
    assert.equal(signal.category, analysis.signals[index].category);
    assert.equal(signal.id, analysis.signals[index].id);
    assert.ok(signal.label && signal.description);
    assert.notEqual(signal.label, analysis.signals[index].label);
  }
  assert.deepEqual(analysis, before, 'localization must not mutate original analysis');
  assert.deepEqual(localizeAnalysis(russian, 'kk'), analysis, 'language switch must be reversible');
});

test('all static and dynamic signals have complete Russian translations', () => {
  const inputs = [
    { text: 'Ұтыс! Қатысу үшін 2000 теңге аудар. Шұғыл! https://example.com', url: 'https://www.instagram.com/p/real-post/' },
    { text: 'Играй в казино, бонус на депозит. Срочно! Ссылка в био.' },
    { text: 'Инвестиции без риска. Гарантированный доход 10% в день. Пригласи двух друзей в матрицу. Вложи 10000 тг и получи 20000 тг завтра. Переведи деньги. Срочно! https://example.com', url: 'https://www.instagram.com/p/real-post/' },
    { text: 'Kaspi служба поддержки. Срочно пришли код из SMS. Аккаунт будет заблокирован. Подтверди аккаунт. https://kaspi-help.example/', url: 'https://www.instagram.com/p/real-post/' },
    { text: 'Мошенники пишут: пришли пароль и отправь деньги. Никому не сообщайте код.' },
  ];
  const expectedIds = ['giveaway', 'entry_payment', 'casino_mention', 'gambling_action', 'bonus', 'deposit', 'investment', 'guaranteed_profit', 'fast_returns', 'numeric_return', 'recruitment', 'structure', 'sensitive_request', 'account_threat', 'login_request', 'impersonation', 'urgency', 'payment', 'brand_domain', 'link_lottery', 'link_pyramid', 'link_phishing', 'bio_link_casino', 'prevention_context'];
  const seen = new Set();
  for (const input of inputs) {
    const result = analyzeContent(input);
    assert.ok(result.translations.kk && result.translations.ru);
    assert.equal(result.translations.kk.signals.length, result.signals.length);
    assert.equal(result.translations.ru.signals.length, result.signals.length);
    for (const signal of result.translations.ru.signals) {
      seen.add(signal.id);
      assert.ok(signal.label.length > 5 && signal.description.length > 20, signal.id);
      assert.notEqual(signal.label, signal.id, signal.id);
      assert.notEqual(signal.label, 'Дополнительный признак риска', `Missing specific translation: ${signal.id}`);
      assert.doesNotMatch(`${signal.label} ${signal.description}`, /[әіңғүұқөһ]/iu, signal.id);
    }
  }
  for (const id of expectedIds) assert.ok(seen.has(id), `Fixture must exercise ${id}`);
});

test('Russian summaries cover medium, low, warning context and truncation', () => {
  assert.match(localizeAnalysis(analyzeContent({ text: '5000 теңге сал да, 10000 теңге ал!' }), 'ru').summary, /подозрительные признаки/);
  assert.match(localizeAnalysis(analyzeContent({ text: 'Қайырлы күн' }), 'ru').summary, /не гарантирует безопасность/);
  assert.match(localizeAnalysis(analyzeContent({ text: 'Не играйте в казино, бонус на депозит не принесет счастья.' }), 'ru').summary, /балл риска снижен/);
  assert.match(localizeAnalysis(analyzeContent({ text: 'a'.repeat(31000) }), 'ru').limitations.at(-1), /30 000 символами/);
});

test('Kazakh default and unknown locales retain original explanations', () => {
  const analysis = analyzeContent({ text: 'Играй в казино, бонус на депозит!' });
  assert.deepEqual(localizeAnalysis(analysis), analysis);
  assert.deepEqual(localizeAnalysis(analysis, 'unexpected'), analysis);
});

test('deposit top-ups, casino brands and gambling slang from live profiles; everyday "пополнение" and "заносы" stay clean', () => {
  const bio = analyzeContent({ text: '👇STANDBATTLE👇 stndbtl.gg/lord1 промо - LORD, даст при пополнении +5 %', platform: 'tiktok' });
  assert.equal(bio.category, 'casino');
  assert.ok(bio.score >= 30);
  assert.ok(['casino_mention', 'deposit', 'bonus'].every(id => bio.signals.some(signal => signal.id === id)));
  assert.ok(analyzeContent({ text: 'Pokerdom дарит бонус 100% на депозит, промокод в профиле' }).score >= 30);
  assert.ok(analyzeContent({ text: 'Заносы недели со стримерами, додеп и промокод на бонус в шапке' }).signals.some(signal => signal.id === 'casino_mention'));
  for (const text of ['Снежные заносы на трассе Астана — Караганда, движение ограничено', 'Пополнение вклада онлайн без комиссии, ставка 15% годовых',
    'Промокод на пополнение баланса +10% для абонентов, подробности на сайте оператора', 'Занос мебели на этаж, грузчики, недорого']) {
    assert.equal(analyzeContent({ text }).score, 0, text);
  }
});
