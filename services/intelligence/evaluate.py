"""Evaluate SafeNet AI on independently authored DEVELOPMENT regression examples.

Run from services/intelligence: python evaluate.py
Writes runtime/evaluation.json. No legacy corpus, model, network, or holdout is
read. These fixtures were developed alongside the Python rules and MUST NOT be
reported as blind validation, production accuracy, or legacy JS engine metrics.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile

from safenet.analysis import analyze


POSITIVES = [
    ("ru", "pyramid", "Вступительный взнос 15000 тенге. Пригласи двух участников и получай бонус за каждого новичка."),
    ("kk", "pyramid", "Кіру жарнасы 12000 теңге. Екі адам шақыр, әр адам үшін сыйақы ал."),
    ("en", "pyramid", "Pay a joining fee of 80 dollars. Recruit two members and earn commission for each recruit."),
    ("ru", "phishing", "Ваш аккаунт заблокирован. Отправьте нам код из СМС для восстановления доступа."),
    ("kk", "phishing", "Есептік жазбаңыз бұғатталды. SMS кодын бізге жіберіңіз."),
    ("en", "phishing", "Your account is suspended. Send us your one-time password to restore access."),
    ("ru", "fake_investment", "Инвестируй 7000 тенге в наш фонд. Гарантируем доход 40% в день. Только сегодня!"),
    ("kk", "fake_investment", "Біздің қорға инвестиция сал. Күніне 30% табысқа кепілдік береміз."),
    ("en", "fake_investment", "Invest in our trading fund. Guaranteed returns of 25% daily with no risk."),
    ("ru", "paid_lottery", "Розыгрыш ноутбука! Купи билет за 3000 тенге. Победителя выберет рандомайзер."),
    ("kk", "paid_lottery", "Телефон ұтысы! Билет сатып ал, бағасы 2000 теңге. Жеңімпаз кездейсоқ таңдалады."),
    ("en", "paid_lottery", "Laptop raffle! Buy a ticket for 15 dollars. Winner chosen at random."),
    ("ru", "fake_shop", "Магазин телефонов: скидка 90%. Нужна полная предоплата на личную карту. Возврата нет."),
    ("kk", "fake_shop", "Телефон дүкені: 90% жеңілдік. Толық алдын ала төлем жеке картаға. Қайтару жоқ."),
    ("en", "fake_shop", "Phone shop with 90% discount. Full prepayment to a personal card. No refunds."),
    ("ru", "job_scam", "Вакансия: наборщик текста, удалённая работа. Для трудоустройства оплатите страховой взнос."),
    ("kk", "job_scam", "Бос жұмыс орны: үйден жұмыс. Жұмысқа тұру үшін тіркелу ақысын төлеңіз."),
    ("en", "job_scam", "Remote job vacancy. Pay a registration fee before starting work."),
    ("ru", "impersonation", "Я сотрудник службы безопасности банка. Переведите деньги на безопасный счёт. Никому не говорите."),
    ("kk", "impersonation", "Мен банк қызметкерімін. Ақшаны қауіпсіз шотқа аударыңыз. Ешкімге айтпаңыз."),
    ("en", "impersonation", "I am a bank employee. Transfer your funds to a safe account. Do not tell anyone."),
    ("ru", "casino", "Онлайн казино: активируй промокод PLAY, пополни депозит и забери бонус."),
    ("kk", "casino", "Онлайн казино! Промокодты қолдан, депозитті толтыр, бонусты ал."),
    ("en", "casino", "Online casino: use promo code PLAY and make a deposit for a bonus."),
    ("ru", "pyramid", "Вложи деньги в клуб. Пригласи друзей: гарантируем прибыль каждый день."),
    ("kk", "phishing", "Құпиясөзіңізді бізге жіберіңіз, есептік жазба бұғатталды."),
    ("en", "phishing", "To avoid account suspension, enter your password on this page."),
    ("ru", "paid_lottery", "Розыгрыш машины: участие — 5000 тенге, победитель случайный."),
    ("en", "job_scam", "We are hiring. Pay a training fee before starting work. Act now!"),
    ("ru", "casino", "Кaзинo: промокод LUCK и бонус. Только сегодня!"),
    ("en", "casino", "CASINO: use a promo code, make a deposit, act now!"),
    ("kk", "fake_shop", "Телефон дүкені. Толық алдын ала төлем. Тауарды қайтару жоқ."),
    ("ru", "paid_lottery", "Розыгрыш телефона: купи билет за 1000 тенге. Бесплатная доставка приза."),
    ("kk", "paid_lottery", "Телефон ұтысы! Билет сатып ал. Жеңімпазға жеткізу тегін."),
    ("en", "fake_investment", "No risk at all, invest in our fund for guaranteed returns of 30% daily."),
    ("ru", "casino", "Pokerdom: бонус 100% при пополнении. Активируй промокод PLAY."),
    ("ru", "casino", "Standbattle: пополнение по промокоду PLAY, забирай бонус."),
    ("ru", "casino", "Покердом: пополнение депозита с бонусом, промокод START."),
    ("ru", "casino", "Standbattle: заносы каждый вечер, делай додеп и играй с нами."),
    ("ru", "casino", "Pokerdom: мои заносы, ссылка в био. Додепай и играй!"),
    ("ru", "casino", "Заносы каждый вечер! Додепай по промокоду LUCK, забирай бонус."),
    ("ru", "casino", "Казино: бонус при пополнении, промокод PLAY."),
    ("kk", "casino", "Standbattle: промокодты қолдан, депозитті толтыр, бонусты ал."),
    ("en", "casino", "Pokerdom: use promo code PLAY and make a deposit for a bonus."),
    ("ru", "casino", "🎁+500% К ДЕПОЗИТУ И 70FS⚡️\n🚀ПО ПРОМОКОДУ: ADPT500🔥\n🎰ЗДЕСЬ⬇️🔞"),
    ("ru", "casino", "+200% к депозиту и 50 FS по промокоду START."),
    ("ru", "casino", "Получай 100фс за депозит по промокоду NEW."),
    ("ru", "casino", "FS: 80 и бонус за депозит по промокоду START."),
    ("ru", "casino", "🎰 +300% к депозиту по промокоду START, ссылка в профиле."),
    ("kk", "casino", "Депозитті толтыр, 70FS ал, промокодты қолдан."),
    ("en", "casino", "Get 50 FS with your deposit using promo code START."),
    ("en", "casino", "🎰 Get a 200% deposit bonus using promo code START."),
]

NEGATIVES = [
    ("ru", "Банк: открой депозит, бонус по промокоду SAVE, ставка 15% годовых."),
    ("ru", "Бонус +500% к депозиту по промокоду SAVE."),
    ("ru", "🎰 Обзор оформления эмодзи. Бонус по промокоду на доставку еды."),
    ("ru", "Скидка на модель камеры 70FS по промокоду PHOTO."),
    ("ru", "Камера 70FS: депозит за аренду оборудования."),
    ("ru", "70FS"),
    ("en", "FS module: deposit records and bonus codes in a file system."),
    ("en", "Download deposit70FS.js with promo code DEV."),
    ("en", "50fs.json stores deposit and promo code test fixtures."),
    ("kk", "Банк депозиті: жылдық 15%, промокод бойынша бонус."),
    ("en", "Bank deposit bonus with promo code SAVE, 4% annually."),
    ("ru", "Новости: мошенники обещают +500% к депозиту и 70FS по промокоду."),
    ("ru", "Предупреждение: 🎰 +300% к депозиту по промокоду — пример рекламы."),
    ("ru", "70FS.\n\nБанковский депозит и бонус по промокоду."),
    ("ru", "🎰\n\n+500% к депозиту по промокоду SAVE."),
    ("ru", "Предупреждение: реклама казино предлагает бонус по промокоду."),
    ("ru", "Это предупреждение о мошенничестве. Реклама казино предлагает бонус по промокоду."),
    ("ru", "Kaspi, Halyk, Telegram и Binance упомянуты в обзоре приложений."),
    ("kk", "Kaspi қосымшасы туралы ақпарат. Бүгін ауа райы жақсы."),
    ("en", "Kaspi, Halyk, Apple and Binance are brands mentioned in this article."),
    ("ru", "Бесплатный розыгрыш: подпишись на страницу. Победитель случайный. Платить не нужно."),
    ("kk", "Тегін ұтыс! Жазылыңыз, жеңімпаз кездейсоқ таңдалады. Төлем қажет емес."),
    ("en", "Free raffle, no purchase necessary. Follow us; winner chosen at random."),
    ("ru", "Банковский вклад: 14% годовых. Доходность инвестиций не гарантирована."),
    ("kk", "Банк салымы: жылдық мөлшерлеме 14%. Инвестиция тәуекелі бар."),
    ("en", "A savings account pays 4% annually. Investment returns are not guaranteed."),
    ("ru", "Вакансия разработчика. Официальный договор, никаких взносов и предоплаты."),
    ("kk", "Бос жұмыс орны: бағдарламашы. Жұмысқа тұру тегін, төлем талап етілмейді."),
    ("en", "Software engineer vacancy. No registration fee is required. Salaried employment."),
    ("ru", "Магазин мебели. Предоплата по договору на счёт компании, возможен возврат."),
    ("kk", "Жиһаз дүкені. Шарт бойынша алдын ала төлем, тауарды қайтаруға болады."),
    ("en", "Furniture shop: prepayment under contract to the company account, refunds available."),
    ("ru", "Никогда не отправляйте код из СМС. Сотрудник банка не просит переводить деньги."),
    ("kk", "SMS кодын ешкімге жібермеңіз. Банк қызметкері ақша аударуды сұрамайды."),
    ("en", "Never send anyone your one-time password. A bank employee will not request a transfer."),
    ("ru", "Новости: полиция предупреждает о схеме: инвестируй деньги, гарантируем 50% в день."),
    ("kk", "Полиция ескертеді: алаяқтар инвестиция сал, күніне 40% табыс деп уәде береді."),
    ("en", "Police warn about a scam: invest in our fund for guaranteed returns of 20% daily."),
    ("ru", "Журналист расследует рекламу казино: «активируй промокод и пополни депозит»."),
    ("kk", "Жаңалықтар: онлайн казино жарнамасындағы «промокодты қолдан» сөзін талқылаймыз."),
    ("en", "News report: casino ads say 'use promo code PLAY and make a deposit'."),
    ("ru", "Промокод на доставку еды. Бонус за приглашение друга, покупать ничего не нужно."),
    ("kk", "Досыңды шақыр, тамақ жеткізуге жеңілдік ал. Қатысу тегін."),
    ("en", "Invite a friend for a grocery discount. No investment or joining fee."),
    ("ru", "Купи билет на концерт. Розыгрыш призов бесплатный среди гостей."),
    ("en", "Buy a ticket to the concert. Our raffle is free for attendees."),
    ("ru", "Казино как сюжетная локация в компьютерной игре. Разбор дизайна уровня."),
    ("en", "Enter the SMS code in the official app you opened yourself."),
    ("ru", "Оплата на Kaspi за доставленный обед. Спасибо за заказ!"),
    ("en", "Invest in your skills: invite friends to a free programming workshop."),
    ("ru", "Курс инвестирования: пригласи друзей на бесплатный семинар."),
    ("en", "Free entry to a raffle. No paid entry or ticket purchase is required."),
    ("en", "We do not ask you to send us your password."),
    ("ru", "Никогда не следует сообщать пароль и код из СМС."),
    ("kk", "Құпиясөзді жібермеңіз. SMS кодын ешкімге айтпаңыз."),
    ("en", "Casino museum exhibition, no promo code or deposit bonus is offered."),
    ("ru", "Реклама казино не содержит промокод, бонус или призыв пополнить депозит."),
    ("en", "A news report explains why scammers say: 'Pay a joining fee. Recruit two members for commission for each recruit.'"),
    ("ru", "Осторожно! Мошенники говорят: «Вакансия. Оплатите страховой взнос»."),
    ("kk", "Сақ болыңыз! Алаяқтар: «Мен банк қызметкерімін. Қауіпсіз шотқа аударыңыз» дейді."),
    ("ru", "Pokerdom"),
    ("ru", "standbattle"),
    ("ru", "Покердом и Standbattle упомянуты в списке названий."),
    ("kk", "Pokerdom және Standbattle атаулары туралы сұрақ."),
    ("en", "Pokerdom and Standbattle are names mentioned in the article."),
    ("ru", "Бонус оператора при пополнении баланса телефона. Пополнение мобильного доступно в приложении."),
    ("ru", "Бухгалтерия: пополнение резервного фонда и заносы сумм бонусов в расчётную ведомость."),
    ("ru", "Бухгалтер заносит операции по пополнению счёта в журнал; бонусы сотрудникам учтены."),
    ("ru", "Объясните термины «заносы» и «додеп» в словаре сленга."),
    ("ru", "Зимой на дорогах возможны заносы. Бонус на замену зимних шин."),
    ("ru", "Pokerdom упомянут в письме.\n\nБонус оператора при пополнении баланса телефона."),
    ("ru", "Полиция предупреждает о рекламе казино: «Pokerdom, бонус при пополнении, промокод PLAY»."),
    ("ru", "Осторожно! Реклама Standbattle обещает заносы и предлагает делать додеп по промокоду."),
    ("kk", "Жаңалықтар: Standbattle жарнамасындағы «промокодты қолдан, депозитті толтыр» сөзін талқылаймыз."),
    ("en", "News report: Pokerdom ads say 'use promo code PLAY and make a deposit'."),
]

def development_metrics():
    """Recomputed development metrics, entirely separate from legacy metrics."""
    tp = sum(analyze(t, locale=lang)["score"] >= 30 for lang, _, t in POSITIVES)
    fp = sum(analyze(t, locale=lang)["score"] >= 30 for lang, t in NEGATIVES)
    correct = sum(analyze(t, locale=lang)["category"] == cat for lang, cat, t in POSITIVES)
    return {"dataset": "independent-authored-development-v1", "blind": False,
            "method": "rules", "ruleset": "python-rules-mvp-2", "positive_threshold": 30,
            "production_accuracy_estimate": False,
            "legacy_holdout_used": False, "positive": len(POSITIVES), "negative": len(NEGATIVES),
            "tp": tp, "fn": len(POSITIVES) - tp, "fp": fp, "tn": len(NEGATIVES) - fp,
            "precision": tp / (tp + fp) if tp + fp else 0,
            "recall": tp / len(POSITIVES),
            "false_positive_rate": fp / len(NEGATIVES),
            "category_accuracy_on_positives": correct / len(POSITIVES),
            "by_category": {category: {"positive": sum(c == category for _, c, _ in POSITIVES),
                                       "tp": sum(analyze(t, locale=l)["score"] >= 30 for l, c, t in POSITIVES if c == category)}
                            for category in sorted({item[1] for item in POSITIVES})},
            "by_language": {lang: {"positive": sum(item[0] == lang for item in POSITIVES),
                                   "negative": sum(item[0] == lang for item in NEGATIVES),
                                   "tp": sum(analyze(t, locale=l)["score"] >= 30 for l, _, t in POSITIVES if l == lang),
                                   "fp": sum(analyze(t, locale=l)["score"] >= 30 for l, t in NEGATIVES if l == lang)}
                            for lang in ("ru", "kk", "en")},
            "limitation": "Regression fixtures developed alongside Python rules; not blind or production accuracy."}


def main() -> None:
    report = development_metrics()
    destination = Path(__file__).resolve().parent / "runtime" / "evaluation.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Same-directory replace leaves readers either the old or the complete JSON.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=destination.parent,
                                         prefix="evaluation-", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(report, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, destination)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
