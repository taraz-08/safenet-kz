"""Bounded, deterministic SafeNet AI MVP; no I/O, model, or legacy corpus.

The score is clamp(sum(evidence weights), 0, 100), not a probability.
Combinations are local to a paragraph and a 600-character window. Each rule
contributes once; warning/free-entry reductions are visible negative weights.
This independent Python ruleset does NOT inherit the legacy JS accuracy.
"""

from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass
import re
import unicodedata
from urllib.parse import urlsplit

MAX_TEXT = 20_000
MAX_URL = 2_048
MAX_LINKS = 50
WINDOW = 600


def _rx(pattern: str) -> re.Pattern:
    return re.compile(pattern, re.IGNORECASE)


# Word boundaries are Unicode aware. Amounts/account numbers are not required:
# upstream may redact personal/payment data before invoking this module.
_PATTERNS = {
    "investment": r"\b(?:инвест\w*|вложи\w*|вложен\w*|вступительн\w*\s+взнос\w*|кіру\s+жарна\w*|қаражат\s+сал\w*|ақша\s+сал\w*|invest\w*|joining\s+fee|entry\s+fee)\b",
    "recruitment": r"\b(?:приглас\w*\s+(?:\w+\s+){0,3}(?:участник\w*|друз\w*|людей|человек)|приведи\s+\w+|адам\s+шақыр\w*|дос\w*\s+шақыр\w*|recruit\s+(?:\w+\s+){0,2}(?:members?|people)|invite\s+(?:\w+\s+){0,2}(?:friends?|members?|people))\b",
    "recruit_reward": r"\b(?:за\s+кажд\w*\s+(?:нович\w*|участник\w*|приглаш\w*)|әр\s+адам\s+үшін\s+сыйақы|commission\s+for\s+each\s+recruit|per\s+(?:recruit|new\s+member))\b",
    "returns": r"\b(?:гарантир\w*\s+(?:\w+\s+){0,2}(?:доход\w*|прибыл\w*)|доход\w*\s+гарантир\w*|без\s+риска|удво\w*\s+(?:\w+\s+){0,2}(?:деньг\w*|вклад\w*)|табыс\w*\s+кепілдік\s+бер\w*|тәуекелсіз\s+табыс|guaranteed\s+(?:returns?|profits?|income)|risk[- ]free\s+(?:returns?|profits?)|double\s+your\s+money)\b|\b\d{1,3}\s*%\s*(?:в\s+день|күн\w*|daily|per\s+day)\b|\bкүніне\s+\d{1,3}\s*%",
    "secret_request": r"\b(?:отправ\w*|пришл\w*|сообщ\w*|назов\w*|переда\w*)\s+(?:\w+\s+){0,5}(?:парол\w*|пин[- ]?код\w*|cvv|код\w*\s+(?:из\s+)?(?:смс|sms)|(?:смс|sms)[- ]?код\w*)\b|\b(?:смс|sms)[- ]?код\w*\s+(?:\w+\s+){0,3}(?:жібер\w*|айт\w*)\b|\b(?:құпиясөз\w*|пин[- ]?код\w*)\s+(?:\w+\s+){0,3}жібер\w*\b|\b(?:send|share|tell|give)\s+(?:\w+\s+){0,5}(?:password|otp|pin|cvv|sms\s+code|one[- ]time\s+(?:password|code)|recovery\s+phrase|seed\s+phrase)\b",
    "credential_entry": r"\b(?:введите|введи|enter|submit)\s+(?:\w+\s+){0,3}(?:парол\w*|password|cvv|seed\s+phrase|код\s+из\s+смс)\b|\b(?:құпиясөз\w*|sms\s+код\w*)\s+енгіз\w*\b",
    "account_threat": r"\b(?:аккаунт\w*\s+(?:\w+\s+){0,2}заблокир\w*|сч[её]т\w*\s+заблокир\w*|бұғаттал\w*|account\s+(?:\w+\s+){0,2}(?:suspended|blocked|locked)|avoid\s+(?:account\s+)?suspension)\b",
    "lottery": r"\b(?:розыгрыш\w*|лотере\w*|ұтыс\w*|raffle|lottery|giveaway|prize\s+draw)\b",
    "entry_payment": r"\b(?:купи\w*\s+(?:\w+\s+){0,2}(?:билет\w*|номер\w*|слот\w*)|билет\w*\s+(?:за|стоит|по)\s*\d+|участи\w*\s*(?:стоит|[-—:=])\s*\d+|платн\w*\s+участи\w*|билет\w*\s+сатып\s+ал\w*|қатысу\s+ақы\w*|ақылы\s+ұтыс|buy\s+(?:a\s+)?(?:ticket|slot|number)|paid\s+entry|entry\s+fee|ticket\s+(?:costs?|price))\b",
    "random": r"\b(?:рандом\w*|случайн\w*|жереб\w*|кездейсоқ\w*|random\w*|drawn\s+winner)\b",
    "shop": r"\b(?:магазин\w*|заказ\w*|прода[её]м|дүкен\w*|тапсырыс\w*|shop|store|order\s+(?:now|a|your))\b",
    "prepayment": r"\b(?:предоплат\w*|аванс\w*|алдын\s+ала\s+төлем\w*|prepayment|prepay\w*|pay\s+(?:in\s+advance|upfront)|advance\s+payment)\b",
    "private_payment": r"\b(?:на\s+личн\w*\s+карт\w*|жеке\s+карта\w*|personal\s+(?:card|account)|crypto\s+only|только\s+криптовалют\w*)\b",
    "shop_pressure": r"\b(?:скидк\w*\s+(?:[7-9]\d|100)\s*%|(?:[7-9]\d|100)\s*%\s*(?:скидк\w*|жеңілдік|discount|off)|возврата\s+нет|без\s+возврата|қайтару\s+жоқ|no\s+refunds|no\s+cash\s+on\s+delivery)\b",
    "job": r"\b(?:ваканси\w*|трудоустрой\w*|удал[её]нн\w*\s+работ\w*|бос\s+жұмыс\s+ор\w*|жұмысқа\s+тұру|үйден\s+жұмыс|job|vacancy|hiring|work\s+from\s+home)\b",
    "job_fee": r"\b(?:оплат\w*\s+(?:\w+\s+){0,3}(?:взнос\w*|обучени\w*|доступ\w*|регистраци\w*)|внес\w*\s+(?:\w+\s+){0,2}(?:взнос\w*|залог\w*)|(?:тіркелу|оқу)\s+ақы\w*\s+төле\w*|pay\s+(?:\w+\s+){0,3}(?:registration|training|security|starter)\s+(?:fee|deposit|kit))\b",
    "authority": r"\b(?:я\s+(?:\w+\s+){0,2}(?:сотрудник|представитель)|служб\w*\s+безопасности\s+банк\w*|мен\s+банк\s+қызметкер\w*|банк\s+қолдау\s+қызмет\w*|i\s+am\s+(?:a\s+)?(?:bank\s+employee|police\s+officer|support\s+agent)|bank\s+security\s+(?:team|department))\b",
    "transfer": r"\b(?:перевед\w*\s+(?:\w+\s+){0,3}(?:деньг\w*|средств\w*)|безопасн\w*\s+сч[её]т\w*|қауіпсіз\s+шот\w*|ақша\w*\s+(?:\w+\s+){0,3}аудар\w*|transfer\s+(?:\w+\s+){0,3}(?:funds|money)|safe\s+account)\b",
    "secrecy": r"\b(?:никому\s+не\s+говор\w*|ешкімге\s+айтпа\w*|do\s+not\s+tell\s+anyone|keep\s+(?:this|it)\s+secret)\b",
    "gambling": r"\b(?:казино\w*|к[аa]з[иi]н[оo]|к4з1н0|casino\w*|kazino|pokerdom|standbattle|покердом\w*|слот\w*|фриспин\w*|free\s*spins?|slot\s+machines?|betting)\b",
    "promotion": r"\b(?:промокод\w*|промо[- ]код\w*|promo\s*code|бонус\w*|bonus|ссылк\w*\s+в\s+(?:био|профил\w*|закреп\w*)|link\s+in\s+(?:bio|profile)|сілтеме\s+арқылы\s+өт\w*)\b",
    "deposit": r"\b(?:пополн\w*\s+(?:\w+\s+){0,2}депозит\w*|пополнени(?:е|я|ю|и|ем)|додеп\w*|депозит\w*\s+толтыр\w*|make\s+a\s+deposit|deposit\s+now)\b",
    "casino_win": r"\bзанос(?:ы|ов|а|ом|ами|ах|е)?\b",
    "redeposit": r"\bдодеп\w*\b",
    # FS is ambiguous alone (file systems, units, product codes). Counted offers
    # need both a promotional invitation and deposit context in the same window.
    "free_spins_offer": r"(?<![\w.])\d{1,4}\s*(?:fs|фс)(?![\w.])|(?<![\w.])(?:fs|фс)\s*[:×x]\s*\d{1,4}(?![\w.])",
    "deposit_reference": r"\b(?:депозит\w*|deposits?)\b",
    "slot_symbol": r"🎰",
    "deposit_bonus": r"(?<![\w.])\+?\d{1,3}\s*%\s*(?:к|на)\s+депозит\w*|\b\d{1,3}\s*%\s*deposit\s+bonus\b",
    "urgency": r"\b(?:только\s+сегодня|срочно|осталось\s+\d+\s+мест\w*|бүгін\s+ғана|тезірек|today\s+only|act\s+now|urgent\w*|limited\s+spots)\b",
}
_FEATURES = {name: _rx(pattern) for name, pattern in _PATTERNS.items()}
_WARNING = _rx(r"\b(?:осторожно|предупреждени[ея]\s+о\s+мошенничеств\w*|предупреждение(?=\s*:)|полици\w*\s+предупрежд\w*|афм\s+предупрежд\w*|новост\w*|журналист\w*\s+расслед\w*|не\s+попадитесь|не\s+ведитесь|алаяқтар\w*|сақ\s+бол\w*|полиция\s+ескерт\w*|жаңалық\w*|police\s+warn\w*|scam\s+alert|beware|news\s+report|fraud\s+awareness|warning\s*:)\b")
_FREE = _rx(r"\b(?:бесплатн\w*\s+(?:розыгрыш\w*|участи\w*|конкурс\w*)|(?:розыгрыш\w*|участи\w*|конкурс\w*)\s+(?:\w+\s+)?бесплатн\w*|платить\s+не\s+нужно|тегін\s+(?:ұтыс\w*|қатысу)|(?:ұтыс\w*|қатысу)\s+тегін|төлем\s+қажет\s+емес|free\s+(?:raffle|entry|giveaway)|raffle\s+is\s+free|no\s+purchase\s+necessary)\b")
_NEGATED = _rx(r"\b(?:не|никогда|без|нет|никаких|not|never|don't|do\s+not|no|without)\s+(?:[\w,]+\s+){0,7}$")
_KK_NEGATED = _rx(r"(?:жіберм\w*|айтпа\w*|сұрамай\w*|төлем\s+талап\s+етілмейді|кепілдік\s+берілмейді)")
_DENIED_RETURN = _rx(r"(?:не\s+гарантир\w*|not\s+guaranteed|no\s+guarantee|кепілдік\s+берілмейді)")


@dataclass(frozen=True)
class _Rule:
    category: str
    required: tuple[str, ...]
    weights: tuple[tuple[str, int], ...]
    labels: tuple[str, str, str]
    required_any: tuple[str, ...] = ()


_RULES = (
    _Rule("pyramid", ("investment", "recruitment"), (("investment", 35), ("recruitment", 30), ("recruit_reward", 20), ("returns", 10), ("urgency", 5)), ("Вложения и привлечение участников", "Қаражат салу және адам шақыру", "Investment and member recruitment"), ("recruit_reward", "returns")),
    _Rule("phishing", ("secret_request",), (("secret_request", 60), ("account_threat", 20), ("authority", 10), ("urgency", 10)), ("Запрос секретных данных", "Құпия деректерді сұрау", "Request to disclose credentials")),
    _Rule("phishing", ("credential_entry", "account_threat"), (("credential_entry", 45), ("account_threat", 20), ("urgency", 10)), ("Ввод секретных данных под угрозой блокировки", "Бұғаттау қаупімен құпия деректерді енгізу", "Credential entry under account threat")),
    _Rule("fake_investment", ("investment", "returns"), (("investment", 30), ("returns", 40), ("private_payment", 10), ("urgency", 10)), ("Вложения с обещанием высокой или гарантированной прибыли", "Жоғары не кепілді табыс уәдесімен қаражат салу", "Investment with high or guaranteed returns")),
    _Rule("paid_lottery", ("lottery", "entry_payment"), (("lottery", 20), ("entry_payment", 35), ("random", 15), ("urgency", 10)), ("Розыгрыш с платным участием", "Ақылы ұтысқа қатысу", "Draw with paid entry")),
    _Rule("fake_shop", ("shop", "prepayment", "shop_pressure"), (("shop", 15), ("prepayment", 25), ("shop_pressure", 25), ("private_payment", 15), ("urgency", 10)), ("Предоплата и сомнительные условия магазина", "Алдын ала төлем және күмәнді дүкен шарттары", "Shop prepayment and concerning sales terms")),
    _Rule("job_scam", ("job", "job_fee"), (("job", 15), ("job_fee", 45), ("urgency", 10)), ("Плата за трудоустройство", "Жұмысқа тұру үшін ақы төлеу", "Upfront payment for a job")),
    _Rule("impersonation", ("authority", "transfer"), (("authority", 25), ("transfer", 30), ("secrecy", 25), ("urgency", 10)), ("Представление сотрудником и просьба перевести деньги", "Қызметкер ретінде танысып, ақша аударуды сұрау", "Claimed authority asking for a money transfer")),
    # A brand is contextual only: it cannot activate a rule without promotion
    # or the combination of claimed winnings and a deposit. Ambiguous "занос"
    # and ordinary top-ups never activate a gambling rule on their own.
    _Rule("casino", ("gambling", "promotion"), (("gambling", 25), ("promotion", 35), ("deposit", 20), ("casino_win", 10), ("urgency", 10)), ("Признаки продвижения азартных игр", "Құмар ойындарды жарнамалау белгілері", "Gambling promotion indicators")),
    _Rule("casino", ("gambling", "casino_win", "deposit"), (("gambling", 25), ("casino_win", 20), ("deposit", 30), ("urgency", 10)), ("Выигрыши и пополнение в игровом контексте", "Ойын мәнмәтініндегі ұтыс пен депозит толтыру", "Claimed winnings and funding in a gambling context")),
    _Rule("casino", ("casino_win", "redeposit", "promotion"), (("casino_win", 20), ("redeposit", 25), ("promotion", 25), ("urgency", 10)), ("Игровой сленг в сочетании с рекламой", "Жарнамамен бірге ойын сленгі", "Gambling slang combined with promotion")),
    _Rule("casino", ("free_spins_offer", "promotion", "deposit_reference"), (("free_spins_offer", 25), ("promotion", 35), ("deposit_reference", 20)), ("Фриспины, промокод и депозит", "Фриспин, промокод және депозит", "Free-spin offer, promotion and deposit")),
    _Rule("casino", ("slot_symbol", "deposit_bonus", "promotion"), (("slot_symbol", 25), ("deposit_bonus", 20), ("promotion", 25)), ("Игровой символ и реклама бонуса к депозиту", "Ойын белгісі және депозит бонусының жарнамасы", "Slot symbol and deposit bonus promotion")),
)

_LABELS = {
    "investment": ("Вложение или вступительный взнос", "Қаражат салу не кіру жарнасы", "Investment or joining fee"),
    "recruitment": ("Привлечение новых участников", "Жаңа қатысушыларды шақыру", "Recruiting new members"),
    "recruit_reward": ("Вознаграждение за новых участников", "Жаңа қатысушылар үшін сыйақы", "Reward for recruiting"),
    "returns": ("Обещание высокой или гарантированной доходности", "Жоғары не кепілді табыс уәдесі", "High or guaranteed return promise"),
    "secret_request": ("Просьба сообщить секретные данные", "Құпия деректерді жіберуді сұрау", "Request to send credentials"),
    "credential_entry": ("Требование ввода секретных данных", "Құпия деректерді енгізу талабы", "Request to enter credentials"),
    "account_threat": ("Угроза блокировки", "Бұғаттау қаупі", "Account suspension threat"),
    "lottery": ("Объявление розыгрыша", "Ұтыс туралы хабарландыру", "Prize draw announcement"),
    "entry_payment": ("Плата за билет или участие", "Билет не қатысу ақысы", "Ticket or entry payment"),
    "random": ("Случайный выбор победителя", "Жеңімпазды кездейсоқ таңдау", "Random winner selection"),
    "shop": ("Предложение магазина", "Дүкен ұсынысы", "Shop offer"),
    "prepayment": ("Требование предоплаты", "Алдын ала төлем талабы", "Prepayment requirement"),
    "shop_pressure": ("Чрезмерная скидка или отказ от возврата", "Тым үлкен жеңілдік не қайтарудан бас тарту", "Extreme discount or no refunds"),
    "private_payment": ("Оплата на личную карту или только криптовалютой", "Жеке картаға не тек криптовалютамен төлеу", "Personal account or crypto-only payment"),
    "job": ("Предложение работы", "Жұмыс ұсынысы", "Job offer"),
    "job_fee": ("Требование заплатить за трудоустройство", "Жұмысқа тұру үшін төлем талабы", "Fee required for employment"),
    "authority": ("Заявление о полномочиях", "Өкілеттігін мәлімдеу", "Claim of authority"),
    "transfer": ("Просьба перевести средства", "Қаражат аударуды сұрау", "Money transfer request"),
    "secrecy": ("Требование скрыть разговор", "Әңгімені құпия сақтау талабы", "Demand for secrecy"),
    "gambling": ("Игра или бренд в сочетании с игровым продвижением", "Ойын не брендтің ойын жарнамасымен бірге аталуы", "Game or brand reference combined with gambling promotion"),
    "promotion": ("Промокод, бонус или рекламный переход", "Промокод, бонус не жарнамалық сілтеме", "Promo code, bonus or promotional route"),
    "deposit": ("Пополнение в сочетании с игровыми признаками", "Ойын белгілерімен бірге шот толтыру", "Top-up combined with gambling indicators"),
    "casino_win": ("«Заносы» в сочетании с игровыми признаками", "Ойын белгілерімен бірге «занос» сөзі", "Claimed winnings slang combined with gambling indicators"),
    "redeposit": ("«Додеп» в сочетании с выигрышами и рекламой", "Ұтыс пен жарнамамен бірге «додеп» сөзі", "Redeposit slang combined with winnings and promotion"),
    "free_spins_offer": ("Количество FS/ФС в сочетании с рекламой и депозитом", "Жарнама және депозитпен бірге FS/ФС саны", "Counted FS offer with promotion and deposit"),
    "deposit_reference": ("Депозит в сочетании с предложением фриспинов", "Фриспин ұсынысымен бірге депозит", "Deposit combined with a free-spin offer"),
    "slot_symbol": ("Символ игрового автомата рядом с рекламным предложением", "Жарнамалық ұсыныстың жанындағы ойын автоматы белгісі", "Slot-machine symbol beside a promotional offer"),
    "deposit_bonus": ("Процентный бонус к депозиту в игровом контексте", "Ойын мәнмәтініндегі депозитке пайыздық бонус", "Percentage deposit bonus in a gambling context"),
    "urgency": ("Давление срочностью", "Асықтыру", "Urgency pressure"),
}


def _normalize(text: str) -> tuple[str, list[int]]:
    chars, positions = [], []
    for index, char in enumerate(text):
        if unicodedata.category(char) == "Cf":
            continue
        for normalized in unicodedata.normalize("NFKC", char).casefold():
            chars.append(normalized)
            positions.append(index)
    return "".join(chars), positions


def _source_url(value: str) -> str:
    if not value or len(value) > MAX_URL or any(ord(c) < 32 for c in value):
        return ""
    try:
        parsed = urlsplit(value)
        if parsed.scheme in {"http", "https"} and parsed.hostname and not parsed.username and not parsed.password:
            return value
    except ValueError:
        pass
    return ""


def _level(score: int) -> str:
    return "critical" if score >= 80 else "high" if score >= 60 else "medium" if score >= 30 else "low"


def _matches(feature: str, normalized: str) -> list[re.Match]:
    found = []
    for match in _FEATURES[feature].finditer(normalized):
        prefix = re.split(r"[.!?;:\n]|\b(?:but|however|но|однако|бірақ)\b", normalized[max(0, match.start() - 100):match.start()])[-1]
        # A promise of "no risk" is not a negation of the subsequent offer.
        prefix = re.sub(r"\b(?:no|without)\s+risk\b|\bбез\s+риска\b", "", prefix)
        excerpt = normalized[match.start():match.end() + 35]
        if feature != "secrecy" and (_NEGATED.search(prefix) or _KK_NEGATED.search(match.group())):
            continue
        if feature == "returns" and _DENIED_RETURN.search(excerpt):
            continue
        found.append(match)
    return found


def analyze(text: str, *, url: str = "", links: list[str] | None = None, locale: str = "ru") -> dict:
    """Return the exact contract schema; no URL fetching or factual verification.

    `language` is the output locale (not a language-classifier result). Manual
    input has an empty source_url. Links are bounded but never treated as proof
    of fraud or independently verified destinations. Oversized text is truncated
    with a declared limitation, preserving verbatim evidence offsets.
    """
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    if not isinstance(url, str):
        raise TypeError("url must be a string")
    if links is not None and (not isinstance(links, list) or any(not isinstance(item, str) for item in links[:MAX_LINKS])):
        raise TypeError("links must be a list of strings or None")
    lang = locale if locale in ("ru", "kk", "en") else "ru"
    li = ("ru", "kk", "en").index(lang)
    truncated = len(text) > MAX_TEXT
    original = text[:MAX_TEXT]
    source = _source_url(url)
    best: dict[str, tuple[int, list[dict], str]] = {}
    # Empty lines separate posts. Contrast clauses start a new context so a
    # warning cannot automatically neutralize a subsequent sales pitch.
    blocks = re.split(r"\n\s*\n|(?<=[.!?])\s+(?=(?:Но\b|Однако\b|But\b|However\b|Бірақ\b))", original, flags=re.I)
    for block in blocks:
        normalized, positions = _normalize(block)
        hits = {name: _matches(name, normalized) for name in _FEATURES}
        hit_starts = {name: [match.start() for match in matches] for name, matches in hits.items()}
        for rule in _RULES:
            if not all(hits[name] for name in rule.required):
                continue
            for anchor in hits[rule.required[0]]:
                selected = {}
                # Prefer nearby hits; reject combinations spanning > WINDOW.
                for feature, _ in rule.weights:
                    insertion = bisect_left(hit_starts[feature], anchor.start())
                    candidates = hits[feature][max(0, insertion - 1):insertion + 1]
                    if candidates:
                        nearest = min(candidates, key=lambda m: abs(m.start() - anchor.start()))
                        if abs(nearest.start() - anchor.start()) <= WINDOW:
                            selected[feature] = nearest
                if not all(name in selected for name in rule.required):
                    continue
                left = min(selected[name].start() for name in rule.required)
                right = max(selected[name].end() for name in rule.required)
                if right - left > WINDOW:
                    continue
                selected = {key: m for key, m in selected.items() if max(right, m.end()) - min(left, m.start()) <= WINDOW}
                if rule.required_any and not any(name in selected for name in rule.required_any):
                    continue
                evidence = [{"code": rule.category + "." + feature, "label": _LABELS[feature][li],
                             "quote": block[positions[selected[feature].start()]:positions[selected[feature].end() - 1] + 1],
                             "weight": weight, "source_url": source}
                            for feature, weight in rule.weights if feature in selected]
                total = sum(item["weight"] for item in evidence)
                context = _WARNING.search(normalized)
                free = _FREE.search(normalized) if rule.category == "paid_lottery" else None
                if context or free:
                    negative = free or context
                    reduction = total if free else max(0, total - 20)
                    evidence.append({"code": rule.category + (".free_context" if free else ".warning_context"),
                                     "label": (("Бесплатное участие: снижение веса", "Тегін қатысу: салмақ азайтылды", "Free entry: weight reduction") if free else
                                               ("Контекст новости или предупреждения: снижение веса", "Жаңалық не ескерту мәнмәтіні: салмақ азайтылды", "News or warning context: weight reduction"))[li],
                                     "quote": block[positions[negative.start()]:positions[negative.end() - 1] + 1],
                                     "weight": -reduction, "source_url": source})
                    total -= reduction
                if total > best.get(rule.category, (-1, [], ""))[0]:
                    best[rule.category] = (total, evidence, rule.labels[li])
    # Closely related categories can share words. Choose the strongest observed
    # combination, rather than double charging the same investment or request.
    category, (score, evidence, title) = max(best.items(), key=lambda item: item[1][0], default=("unknown", (0, [], "")))
    score = min(100, max(0, score))
    if score == 0:
        category = "unknown"
    summary = (
        f"Найдены признаки: {title}. Балл риска {score}/100; нужна проверка человеком." if score >= 30 else "Достаточное сочетание признаков не найдено. Низкий балл не подтверждает безопасность.",
        f"Белгілер анықталды: {title}. Тәуекел балы {score}/100; адам тексеруі қажет." if score >= 30 else "Жеткілікті белгілер жиынтығы табылмады. Төмен балл қауіпсіздікті растамайды.",
        f"Indicators found: {title}. Risk score {score}/100; human review is needed." if score >= 30 else "No sufficient combination of indicators found. A low score does not establish safety.",
    )[li]
    recommendations = (
        ["Проверьте полный контекст и условия предложения по независимому официальному каналу.", "Не передавайте пароли и коды и не переводите деньги до проверки.", "Сохраните исходный материал для проверки человеком."],
        ["Толық мәнмәтін мен ұсыныс шарттарын тәуелсіз ресми арнадан тексеріңіз.", "Тексергенше құпиясөз бен кодтарды жібермеңіз және ақша аудармаңыз.", "Бастапқы материалды адам тексеруі үшін сақтаңыз."],
        ["Check the full context and terms through an independent official channel.", "Do not share passwords or codes or transfer money before checking.", "Preserve the original material for human review."],
    )[li]
    limitations = [
        ("Балл — сумма весов правил (ограниченная 0–100), не вероятность и не юридический вывод. Показана самая сильная комбинация; повторы не добавляют баллов.",
         "Балл — ереже салмақтарының қосындысы (0–100 шегінде), ықтималдық не құқықтық қорытынды емес. Ең күшті жиынтық көрсетіледі; қайталау балл қоспайды.",
         "Score is the sum of rule weights clamped to 0–100, not a probability or legal verdict. Only the strongest combination is shown; repetition adds no points.")[li],
        ("Самостоятельный Python MVP: метрики JavaScript-движка к нему не относятся. Скрытые формулировки, изображения и ирония могут быть пропущены.",
         "Дербес Python MVP: JavaScript қозғалтқышының метрикалары бұған қолданылмайды. Жасырын сөздер, суреттер және әжуа танылмауы мүмкін.",
         "Independent Python MVP: legacy JavaScript metrics do not apply. Obfuscation, images and irony may be missed.")[li],
        ("Анализируется только переданный текст. Источник, ссылки, лицензии и личности независимо не проверялись.",
         "Тек берілген мәтін талданады. Дереккөз, сілтеме, лицензия және тұлға тәуелсіз тексерілмеді.",
         "Only supplied text is analyzed. Sources, links, licenses and identities were not independently verified.")[li],
    ]
    if not source:
        limitations.append(("Источник не подтверждён: ручной ввод или отсутствует допустимый URL.", "Дереккөз расталмаған: қолмен енгізілген не жарамды URL жоқ.", "Unverified source: manual input or no valid source URL.")[li])
    if truncated:
        limitations.append(("Проанализированы только первые 20000 символов.", "Тек алғашқы 20000 таңба талданды.", "Only the first 20000 characters were analyzed.")[li])
    return {"score": score, "level": _level(score), "category": category, "summary": summary,
            "evidence": evidence, "recommendations": recommendations, "method": "rules",
            "limitations": limitations, "language": lang}
