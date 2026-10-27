"""Explicit, idempotent import of previously collected REAL SafeNet KZ records.

No network requests. Never presents historical records as a fresh collection.
Usage: python -m safenet.import_legacy /absolute/path/data/cases.json
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid5, NAMESPACE_URL
from .analysis import analyze
from .models import ScanTask, ScannedContent, RiskAssessment, Evidence, utcnow
from .store import initialize, Session, audit
from .runner import redact, platform_for
from .safe_fetch import normalize_url


def import_records(path):
    records = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if not isinstance(records, list):
        raise ValueError("Expected a SafeNet KZ cases array")
    imported, skipped = 0, 0
    initialize()
    with Session.begin() as db:
        for record in records:
            if record.get("demo") is not False or record.get("source") not in {"telegram_discovery", "social_discovery", "public_telegram"}:
                skipped += 1
                continue
            url = record.get("url", "")
            source_text = redact(record.get("originalText") or record.get("text", ""))
            try:
                normalize_url(url)
            except ValueError:
                skipped += 1
                continue
            if not source_text.strip():
                skipped += 1
                continue
            scan_id = str(uuid5(NAMESPACE_URL, "safenet-legacy:" + url))
            if db.get(ScanTask, scan_id):
                skipped += 1
                continue
            captured = record.get("capturedAt") or record.get("createdAt")
            try:
                created = datetime.fromisoformat(str(captured).replace("Z", "+00:00"))
                if created.tzinfo is None:
                    created = created.replace(tzinfo=timezone.utc)
            except (ValueError, TypeError):
                # Preserve uncertainty instead of inventing a historical capture date.
                created, captured = utcnow(), None
            links = record.get("links", [])
            links = [value for value in links if isinstance(value, str)][:40]
            result = analyze(source_text, url=url, links=links, locale="ru")
            task = ScanTask(id=scan_id, url=url, platform=platform_for(url), mode="live", status="completed", stage="imported_history", created_at=created, completed_at=utcnow())
            db.add(task)
            db.flush()
            provenance = record.get("provenance") if isinstance(record.get("provenance"), dict) else {}
            provenance = {key: value for key, value in provenance.items() if key in {"method", "scope", "publicVisibilityVerified", "termsNotice"} and isinstance(value, (str, bool))}
            db.add(ScannedContent(task_id=scan_id, title="Previously collected public source", text=source_text, links=links, source_metadata={"origin": "legacy_public_capture", "source_url": url, "captured_at": captured, "imported_at": utcnow().isoformat(), "independently_fetched_this_run": False, "source": record["source"], "legacy_provenance": provenance, "content_scope": "historical saved public text; availability not rechecked", "screenshot_available": False}))
            risk = RiskAssessment(task_id=scan_id, score=result["score"], level=result["level"], category=result["category"], analysis=result)
            db.add(risk)
            db.flush()
            for item in result["evidence"]:
                db.add(Evidence(assessment_id=risk.id, code=item["code"], label=item["label"], quote=item.get("quote", ""), weight=item["weight"], source_url=item.get("source_url") or url))
            imported += 1
    audit("legacy_import", f"Imported {imported} historical public captures; skipped {skipped}. No live fetch performed.")
    return {"imported": imported, "skipped": skipped, "fresh_collection": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path")
    print(json.dumps(import_records(parser.parse_args().path)))
