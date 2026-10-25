# Видео для защиты (v5, русская озвучка)

Готовый ролик: `output/safenet-kz-defense-ru.mp4` (1920×1080, 30 к/с, ≈ 2:22), субтитры `output/safenet-kz-defense-ru.srt`.

## Из чего собран

| Часть | Источник |
|---|---|
| Экраны программы | Настоящая работающая SafeNet KZ 5.0 на `127.0.0.1:4310`. Headless Chrome записывает её через DevTools (`record.py`). Интерфейс на русском. |
| Озвучка | ElevenLabs, модель Eleven v4, голос Nurlan, язык русский. Текст — `voice-text.txt`, он же `scenes.json` с подсказками произношения. |
| Тайминг | `align.py` — faster-whisper (small) размечает слова и делит озвучку по 8 сценам. |
| Вступление | Два 8-секундных клипа из Google Flow (Omni 1.1 Flash). На экране есть подпись «Вступление сгенерировано в Google Flow». Это иллюстрация, а не данные. |
| Монтаж | `render.py`: PyAV + Pillow, без ffmpeg. |

Каждая сцена программы помечена в левом нижнем углу: демо-поток с синтетическими аккаунтами, реальные публичные каналы Telegram или слепая синтетическая выборка. Записи ускорены не более чем в 1,45 раза, чтобы совпасть с озвучкой; скорость каждой сцены указана в `output/*.render.json`.

## Пересборка

```bash
npm start                                   # сервер на 127.0.0.1:4310 (из корня проекта)
python artifacts/video-project/v5/record.py # запись 6 экранов; сбрасывает демо-поток
python artifacts/video-project/v5/align.py artifacts/video-project/v5/voice/gen1.mp3
python artifacts/video-project/v5/render.py --preview   # контактный лист и SRT
python artifacts/video-project/v5/render.py             # MP4
```

Если меняется текст в `scenes.json`, озвучку нужно сгенерировать заново в ElevenLabs и снова запустить `align.py`.
