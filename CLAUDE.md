# SafeNet KZ — заметки для агентов

Прототип для хакатона SafeNet KZ: система находит **признаки** платных лотерей, скрытой рекламы онлайн-казино и финансовых пирамид и объясняет каждый балл. Вердикт о законности выносит человек. Спецификация — [docs/BRIEF.md](docs/BRIEF.md), методика — [docs/METHODOLOGY.md](docs/METHODOLOGY.md).

## Команды

- `npm test` — все автотесты (`node --test server/*.test.mjs extension/*.test.mjs`)
- `npm run build` — сборка интерфейса в `dist/`; `npm start` — сервер на `127.0.0.1:4310`
- `npm run evaluate` — пересчёт `data/metrics.json`; `npm run train` — обучение модели

## Правила проекта

- Отложенная половина слепой выборки (`data/test-set.json`, holdout) только для итоговых цифр: строки holdout не читать и правила по ним не настраивать.
- Живые находки (Telegram, Instagram, TikTok) помечаются только по признакам правил, без баллов «только модель».
- Instagram и TikTok: только публичные страницы, без входа в аккаунт, без маскировки браузера и обхода капчи (см. [ADR 0003](docs/adr/0003-instagram-tiktok-without-login.md)).
- Любое изменение правил — с регрессионным тестом на ложные срабатывания и пересчётом метрик.

## Agent skills

### Issue tracker

Задачи и спецификации ведутся в GitHub Issues репозитория `taraz-08/safenet-kz` через `gh`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: один `GLOSSARY.md` и `docs/adr/` в корне. See `docs/agents/domain.md`.
