"""Visual descriptions request human review without becoming scored evidence."""
from copy import deepcopy

import pytest

from safenet.analysis import analyze
from safenet.media import assess_media


def image_media(observations=(), *, text="", visual_status="completed", image=True):
    return {"status": "completed", "has_image": image, "has_video": not image,
            "audio": {"status": "not_present"}, "visual": {"status": visual_status},
            "transcript": [], "limitations": [],
            "frames": [{"at": 0, "text": text, "observations": list(observations),
                        "visual_status": visual_status}]}


@pytest.mark.parametrize("image", [True, False])
@pytest.mark.parametrize("observation", ["Colorful slot reels and buttons", "A green circle on a dark background"])
def test_textless_descriptions_request_review_without_risk_or_quotes(image, observation):
    media = image_media([observation], image=image)
    before = deepcopy(media)
    result, context = assess_media("", media)
    assert result["score"] == 0
    assert result["evidence"] == result["media_evidence"] == []
    assert context == ""
    assert result["visual_review_required"] is True
    assert result["visual_review"]["status"] == "required"
    assert result["visual_review"]["frames"] == [{"frame_index": 0, "at": 0, "observations": [observation]}]
    assert media == before


@pytest.mark.parametrize("visual_status", ["completed", "partial"])
def test_ocr_without_visual_observations_is_limited_not_visual_clear(visual_status):
    result, _ = assess_media("", image_media(visual_status=visual_status))
    assert result["score"] == 0
    assert result["visual_review_required"] is False
    assert result["visual_review"]["status"] == "coverage_limited"
    assert result["visual_review"]["frames"] == []
    assert "OCR" in result["visual_review"]["notice"]


def test_visual_description_does_not_override_existing_rule_risk():
    text = "Казино Pokerdom: бонус по промокоду, пополни депозит и играй в слоты!"
    plain = analyze(text)
    result, context = assess_media(text, image_media(["A harmless green circle"]))
    for field in ("score", "level", "category", "summary"):
        assert result[field] == plain[field]
    assert result["score"] > 0
    assert context == text
    assert [row["quote"] for row in result["evidence"]] == [row["quote"] for row in plain["evidence"]]
    assert all(row["modality"] == "page_text" for row in result["evidence"])
    assert result["visual_review_required"] is True


def test_failed_visual_input_without_text_stays_unscored():
    assert assess_media("", image_media(visual_status="unavailable")) == (None, "")
    assert assess_media("", image_media(["Slot interface"], visual_status="unavailable")) == (None, "")


def test_audio_only_is_not_misrepresented_as_visual_review():
    media = {"status": "completed", "audio": {"status": "no_speech"},
             "visual": {"status": "not_present"}, "frames": [], "transcript": [], "limitations": []}
    result, _ = assess_media("", media)
    assert "visual_review" not in result


@pytest.mark.parametrize("locale, expected", [("ru", "Нужна проверка кадров"), ("kk", "Кадрларды тексеру қажет"), ("en", "Frames need review")])
def test_review_notice_is_localized(locale, expected):
    result, _ = assess_media("", image_media(["A circle"]), locale=locale)
    assert result["visual_review"]["notice"].startswith(expected)


def test_whitespace_and_invalid_observations_do_not_create_a_candidate():
    result, _ = assess_media("", image_media(["  ", None, 12]))
    assert result["visual_review"]["status"] == "coverage_limited"
