# Ролик для жюри (v6)

Готовый ролик: `output/safenet-kz-jury-ru.mp4` (1:48, 1920×1080, 30 к/с, русская озвучка), субтитры `output/safenet-kz-jury-ru.srt`.

## Что показано

Только работающий сайт и реальные находки (данные сверены с API 25.10.2026):

| Сцена | Источник | Что видно |
|---|---|---|
| Пульт | https://safenet-kz.up.railway.app | реальные находки и очередь проверки |
| Поиск в Telegram | сайт на Railway | 35 проверенных каналов, 4 канала с рекламой онлайн-казино |
| Разбор случая | сайт на Railway | пост «150 FS за регистрацию, промокод, короткая ссылка» с признаками, цитатами и весами |
| Ручная проверка | сайт на Railway | казахский текст о «салымсыз табыс»: 91/100, финансовая пирамида |
| Instagram и TikTok | тот же сайт на компьютере команды | 94 проверенных аккаунта, 14 с промокодами казино; с IP Railway Instagram требует вход |
| Качество | сайт на Railway | precision 85,5% на отложенной части слепой выборки |

На сценах с сайта на Railway внизу кадра показан его адрес.

## Из чего собран

- `jury-scenes.json` — сценарий по сценам; `voice-text.txt` — текст для озвучки с подсказками произношения.
- `voice/gen1.mp3` — озвучка ElevenLabs (Eleven v4, голос Serik, русский); `voice/gen1.align.json` — разметка слов faster-whisper и границы сцен (`align.py`, границы уточнены по первым словам абзацев).
- `intro/start.png`, `intro/end.png` — два ключевых кадра Google Flow (Nano Banana): сначала изображения, потом видео. `intro/clip.mp4` — Veo 3.1 Fast «кадры → видео» ровно между ними. В монтаже до и после клипа показываются его собственные первый и последний кадры, поэтому шва нет. `intro/keyframes.jpg` — оба кадра рядом.
- `record.py` — запись экранов в headless Chrome через DevTools (кадры в `frames/`, в репозиторий не входят).
- `render_jury.py` — монтаж: PyAV + Pillow, плавные переходы 0,5 с, субтитры, адрес сайта, финальная карточка.

Остальные файлы (`scenes.json`, `narration-ru.txt`, `render.py`, `keyframes/`, `claim-evidence.md`, `PRODUCTION-STATUS.md`) — более ранний вариант плана из предыдущей сессии.

## Пересборка

```bash
npm start                                              # для сцены Instagram/TikTok (из корня проекта)
python artifacts/video-project/v6/record.py            # запись экранов
python artifacts/video-project/v6/align.py artifacts/video-project/v6/voice/gen1.mp3
python artifacts/video-project/v6/render_jury.py --preview   # контактный лист и SRT
python artifacts/video-project/v6/render_jury.py             # MP4
```

После `align.py` границы сцен нужно уточнить по первым словам абзацев: числа («сто пятьдесят») распознаются одним словом («150»).
