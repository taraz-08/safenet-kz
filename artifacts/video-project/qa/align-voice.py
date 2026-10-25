"""Align original script cues to reviewed ASR phrase spans; preserves every script word."""
import difflib
import json
import re
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
asr = json.loads((PROJECT / 'qa/voice-kk-asr.json').read_text(encoding='utf-8'))
script = (PROJECT / 'narration-kk.txt').read_text(encoding='utf-8').strip()
spec = json.loads((PROJECT / 'subtitle-cues.json').read_text(encoding='utf-8'))
config = json.loads((PROJECT / 'render-config.json').read_text(encoding='utf-8'))
offset = float(config.get('narration_start', 0.6))
spans = [(0,0),(1,1),(2,2),(3,3),(4,4),(5,5),(6,6),(7,8),(9,9),
         (10,10),(11,11),(12,12),(13,13),(14,15),(16,17),(18,18),(19,20)]
assert len(spans) == len(spec['cues']) == 17
assert re.sub(r'\s+', ' ', script) == ' '.join(cue['text'] for cue in spec['cues'])
cues, checks = [], []
def normalized(value):
    # Comparison normalization only. Never apply this to subtitle/source text.
    return re.sub(r'[^\w]+', '', value.casefold().replace('instagram', 'инстаграм'))
for index, (cue, (first, last)) in enumerate(zip(spec['cues'], spans)):
    pieces = asr['segments'][first:last + 1]
    start, end = pieces[0]['start'], pieces[-1]['end']
    recognized = ' '.join(piece['text'] for piece in pieces)
    match = difflib.SequenceMatcher(None, normalized(cue['text']), normalized(recognized)).ratio()
    cues.append({'start': round(offset + start, 3), 'end': round(offset + end, 3), 'text': cue['text']})
    checks.append({'cue': index + 1, 'audio_start': start, 'audio_end': end,
                   'original': cue['text'], 'asr': recognized,
                   'character_similarity': round(match, 3),
                   'review': 'phrase present; ASR phonetic variation possible'})
assert all(cue['end'] > cue['start'] for cue in cues)
assert all(left['end'] <= right['start'] for left, right in zip(cues, cues[1:]))
assert cues[-1]['end'] <= offset + asr['duration']
output = {'timing': 'absolute', 'method': 'reviewed_local_asr_phrase_alignment',
          'source': 'assets/voice-kk.mp3', 'source_duration': asr['duration'],
          'narration_offset_included': offset,
          'note': 'Final-video seconds; narration_start offset is already included. Original script words preserved. Phrase boundaries are reviewed from local Whisper ASR, not human-listening-certified word timestamps.',
          'cues': cues}
(PROJECT / 'subtitle-aligned.json').write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
report = {'source': asr['source'], 'duration': asr['duration'], 'processing_seconds': asr['elapsed_seconds'],
          'engine': asr['engine'], 'model': asr['model'], 'local_only': True, 'external_uploads': False,
          'language': 'kk', 'script_supplied_as_prompt': False,
          'script_cues': 17, 'matched_cues': 17, 'obvious_missing_phrases': [],
          'pronunciation_verdict': 'not_certified_by_ASR; local small Kazakh transcription has phonetic errors',
          'score_51': {'expected': 'жүзден елу бір ұпай', 'asr': 'жүздін елюбір өпай',
                       'audio_start': 21.94, 'audio_end': 24.30,
                       'verdict': 'phonetic match to 51 out of 100; no contradictory score recognized'},
          'review_word': {'expected': 'фриспинов', 'asr': 'фриспи үніф',
                          'audio_start': 28.40, 'audio_end': 30.54,
                          'verdict': 'speech present at expected place; exact pronunciation needs listening'},
          'subtitle_status': 'phrase-aligned, exact script, offset already included; suitable for render QA',
          'checks': checks}
(PROJECT / 'qa/voice-kk-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
rows = '\n'.join(f"| {c['cue']} | {c['audio_start']:.2f}–{c['audio_end']:.2f} | {c['original']} | {c['asr']} |" for c in checks)
markdown = f'''# Қазақша дауыс тексеруі / Проверка казахской озвучки

Аудио: `assets/voice-kk.mp3`, **{asr['duration']:.3f} секунд**. Тек жергілікті Whisper small CPU int8, `language=kk`, сөз уақыттары қосылды. Мәтін модельге prompt ретінде берілген жоқ, сыртқы сервиске аудио жіберілген жоқ. Өңдеу: **{asr['elapsed_seconds']:.2f} секунд**.

## Нәтиже

Бастапқы мәтіннің **17/17 сөйлем тобы** дыбыста сол ретпен сәйкес келеді. Толық түсіп қалған абзац немесе соңғы сөйлемнің кесіліп қалуы ASR-ден байқалмады. Алайда Whisper small қазақша сөздерді жиі дыбысталуына жақын қате жазды: бұл есеп диктордың әр сөзді дұрыс айтқанын куәландырмайды. ASR қатесін дыбыстың қатесі деп бірден санауға болмайды.

- **51 ұпай:** 21.94–24.30 с аралығында ASR «жүздін елюбір өпай» деп таныды. Бұл «жүзден елу бір ұпай» тіркесіне дыбыстық сәйкестік береді; басқа сан анықталмады.
- **«фриспинов»:** 28.40–30.54 с аралығында «фриспи үніф» деп бөлінді. Терминнің нақты айтылуын тыңдап тексеру қажет; ASR бойынша сөзді жоғалған деп белгілеуге негіз жоқ.
- SafeNet KZ атауы басында және соңында танылды; «пайызы емес» мағынасы тиісті сөйлемде дыбыстық ұқсастықпен бар. Бұл кәсіби айтылым сараптамасы емес.

## Субтитр уақыты

`subtitle-aligned.json` бастапқы мәтінді сөзбе-сөз сақтайды. `timing=absolute`, әр cue `start/end/text` өрістерінен тұрады. **{offset:.1f} секунд narration_start ығысуы енгізілген**; render кезінде қайта қоспау керек. Алғашқы cue {cues[0]['start']:.2f} с, соңғысы {cues[-1]['end']:.2f} с аяқталады. Уақыттар ASR-дің сөйлем шекараларына байланған және мағыналық ретімен тексерілген; адам тыңдап растаған сөздік синхрон деп жариялауға болмайды. Дайын видеоның preview QA-сына жарамды.

## Сәйкестік кестесі / Таблица соответствия

Уақыт — бастапқы аудиодағы секунд, видеоның +{offset:.1f} с ығысуынсыз.

| № | Аудио уақыты | Бастапқы мәтін | ASR нәтижесі |
|---|---|---|---|
{rows}
'''
(PROJECT / 'qa/voice-kk-report.md').write_text(markdown, encoding='utf-8')
print(json.dumps({'aligned_cues': len(cues), 'offset_included': offset,
                  'end': cues[-1]['end'], 'min_phrase_similarity': round(min(c['character_similarity'] for c in checks),3)}))
