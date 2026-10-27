"""Regression checks for independently authored development fixtures in evaluate.py.

Run from services/intelligence: python -m pytest tests/test_analysis.py
Recompute and publish metrics from that directory: python evaluate.py
These examples are regression checks, not an estimate of real-world accuracy.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from safenet.analysis import analyze
from safenet.analysis import _level
from evaluate import POSITIVES, NEGATIVES, development_metrics


@pytest.mark.parametrize("locale,category,text", POSITIVES)
def test_representative_categories(locale, category, text):
    result = analyze(text, url="https://source.example/post/1", locale=locale)
    assert result["score"] >= 30, result
    assert result["category"] == category, result
    assert result["method"] == "rules"
    assert result["language"] == locale
    assert result["score"] == min(100, max(0, sum(e["weight"] for e in result["evidence"])))
    for evidence in result["evidence"]:
        assert evidence["quote"] and evidence["quote"] in text
        assert evidence["source_url"] == "https://source.example/post/1"


@pytest.mark.parametrize("locale,text", NEGATIVES)
def test_false_positive_regressions(locale, text):
    result = analyze(text, locale=locale)
    assert result["score"] < 30, result


def test_contract_empty_manual_input():
    result = analyze("")
    assert set(result) == {"score", "level", "category", "summary", "evidence",
                           "recommendations", "method", "limitations", "language"}
    assert result["score"] == 0
    assert result["level"] == "low"
    assert result["evidence"] == []
    assert result["limitations"]


def test_unrelated_paragraphs_do_not_form_a_scheme():
    assert analyze("Join our free raffle.\n\nBuy a ticket to the train.")["score"] == 0


def test_repetition_does_not_inflate_score():
    text = POSITIVES[23][2]
    assert analyze(text)["score"] == analyze((text + "\n\n") * 15)["score"]


def test_warning_does_not_erase_separate_advertisement():
    text = "Police warn: never send passwords.\n\n" + POSITIVES[23][2]
    assert analyze(text)["score"] >= 60


def test_source_and_links_are_not_brand_risk_or_fabricated_quotes():
    result = analyze("Kaspi", url="https://kaspi.example/", links=["https://example.org/?ref=casino"])
    assert result["score"] == 0


@pytest.mark.parametrize("score,expected", [(0, "low"), (29, "low"), (30, "medium"),
                                           (59, "medium"), (60, "high"), (79, "high"),
                                           (80, "critical"), (100, "critical")])
def test_exact_level_thresholds(score, expected):
    assert _level(score) == expected


@pytest.mark.parametrize("text", ["КАЗИНО: ПРОМОКОД И БОНУС", "Ка\u200bзино: промокод и бонус", "Ｃａｓｉｎｏ: use promo code PLAY"])
def test_normalization_preserves_original_quotes(text):
    result = analyze(text)
    assert result["score"] >= 60
    assert all(e["quote"] in text for e in result["evidence"])
    assert all(e["source_url"] == "" for e in result["evidence"])


def test_distant_words_in_one_paragraph_do_not_form_combination():
    result = analyze("Casino architecture. " + "Neutral words. " * 100 + "Use our promo code for groceries.")
    assert result["score"] == 0


def test_self_claimed_legitimacy_does_not_cancel_signals():
    result = analyze("We are not scammers. " + POSITIVES[8][2])
    assert result["score"] >= 60


def test_contrast_after_warning_keeps_promotion():
    result = analyze("Beware of scammers. However, online casino: use promo code PLAY and make a deposit.")
    assert result["score"] >= 60


def test_warning_reduction_has_verbatim_quote_and_reconciles_score():
    text = "News report: " + POSITIVES[23][2]
    result = analyze(text)
    assert result["level"] == "low"
    assert any(e["weight"] < 0 for e in result["evidence"])
    assert result["score"] == sum(e["weight"] for e in result["evidence"])
    assert all(e["quote"] in text for e in result["evidence"])


def test_long_input_has_explicit_limit_and_no_tail_evidence():
    text = "hello " * 4000 + POSITIVES[23][2]
    result = analyze(text, locale="en")
    assert result["score"] == 0
    assert any("20000" in item for item in result["limitations"])


@pytest.mark.parametrize("value", [None, 5, [], {}])
def test_invalid_input_type(value):
    with pytest.raises(TypeError):
        analyze(value)


@pytest.mark.parametrize("url", ["javascript:alert(1)", "https://user:password@example.com/", "https://example.com/\nattack", "https://[bad"])
def test_invalid_source_is_not_a_citation(url):
    result = analyze(POSITIVES[23][2], url=url)
    assert all(e["source_url"] == "" for e in result["evidence"])


def test_invalid_optional_inputs_and_locale_fallback():
    with pytest.raises(TypeError):
        analyze("text", url=None)
    with pytest.raises(TypeError):
        analyze("text", links="https://example.com")
    with pytest.raises(TypeError):
        analyze("text", links=[1])
    assert analyze("text", locale="fr")["language"] == "ru"


def test_redacted_payment_values_are_not_required():
    result = analyze("Вступительный взнос [REDACTED]. Пригласи двух участников и получай бонус за каждого новичка.")
    assert result["category"] == "pyramid"
    assert result["score"] >= 60


def test_both_schemes_use_the_strongest_explained_combination():
    result = analyze(POSITIVES[23][2] + "\n\n" + POSITIVES[0][2])
    assert result["category"] == "pyramid"
    assert result["score"] == sum(e["weight"] for e in result["evidence"])


def test_evaluation_provenance_and_counts():
    report = development_metrics()
    assert report["legacy_holdout_used"] is False
    assert report["blind"] is False
    assert report["production_accuracy_estimate"] is False
    assert report["positive_threshold"] == 30
    assert report["tp"] + report["fn"] == report["positive"] == len(POSITIVES)
    assert report["tn"] + report["fp"] == report["negative"] == len(NEGATIVES)
    assert sum(v["positive"] for v in report["by_language"].values()) == len(POSITIVES)
    assert sum(v["negative"] for v in report["by_language"].values()) == len(NEGATIVES)
    assert len(report["by_category"]) == 8


@pytest.mark.parametrize("prefix", ["Предупреждение:", "Это предупреждение о мошенничестве."])
def test_spoken_warning_about_casino_is_not_promotional(prefix):
    text = prefix + " Реклама казино предлагает бонус по промокоду."
    result = analyze(text)
    assert result["score"] < 30
    assert any(row["code"].endswith("warning_context") for row in result["evidence"])
    # A later separate promotion must still be considered independently.
    assert analyze(text + "\n\nКазино: бонус по промокоду, пополнение депозита.")["score"] >= 60


if __name__ == "__main__":
    print(json.dumps(development_metrics(), indent=2))
