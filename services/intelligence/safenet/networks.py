"""Read-only, bounded relationships in saved public captures; never alter risk.

Account identity comes from supported URL shapes, never titles or operator input.
An edge describes an observation, not common ownership or a legal conclusion.
"""
import re
from collections import defaultdict
from itertools import combinations
from typing import Literal
from urllib.parse import parse_qsl, urlsplit

from fastapi import APIRouter
from sqlalchemy import select

from . import store
from .discovery_urls import public_content_url
from .models import RiskAssessment, ScanTask, ScannedContent

router = APIRouter(prefix="/api/v1")
SCAN_LIMIT = 500
EDGE_LIMIT = 1000
PLATFORMS = ("telegram", "instagram", "tiktok", "threads", "youtube")
URL = re.compile(r"https?://[^\s<>\"']+", re.I)
PROMO = re.compile(r"\b(?:промокод(?:ы|ом)?|промо[ -]код|promo[ -]?code)\s*[:=—-]?\s*[«\"']?([a-z0-9_-]{6,32})(?![\w-])", re.I)
GENERIC_CODE = re.compile(r"(?:bonus|welcome|sale|discount|promo|free|test|example|бонус)\d*", re.I)
REF_KEYS = {"ref", "referral", "referral_code", "refcode", "affiliate", "affiliate_id", "aff", "aff_id", "partner_id", "promo", "promocode"}
COMMON_HOSTS = ("t.me", "telegram.me", "telegram.org", "instagram.com", "tiktok.com", "youtube.com", "youtu.be", "threads.net", "threads.com", "facebook.com", "google.com", "google.kz", "wa.me", "whatsapp.com", "vk.com", "x.com", "twitter.com", "gov.kz", "egov.kz", "kaspi.kz")


def account_url(value):
    """A permalink counts as an account only when its URL identifies the author."""
    for platform in PLATFORMS:
        canonical = public_content_url(value, platform)
        if not canonical:
            continue
        parts = urlsplit(canonical)
        segments = parts.path.strip("/").split("/")
        if platform == "telegram":
            return platform, "https://t.me/" + segments[1]
        if platform in {"tiktok", "threads"}:
            return platform, f"https://{parts.hostname}/{segments[0]}"
        if platform == "instagram" and len(segments) == 1:
            return platform, canonical.rstrip("/")
        if platform == "youtube" and (segments[0].startswith("@") or segments[0] == "channel"):
            return platform, canonical
    return None


def public_origin(task, metadata):
    if task.mode != "live" or task.input_text or task.input_media:
        return None
    origin = metadata.get("origin")
    if origin == "legacy_public_capture":
        provenance = metadata.get("legacy_provenance") or {}
        if metadata.get("source") == "telegram_discovery" or provenance.get("publicVisibilityVerified") is True:
            return "historical_public"
        return None
    if origin not in {None, "public_url"} or metadata.get("independently_fetched") is False:
        return None
    if metadata.get("collector") in {"public_http", "youtube_data_api"} and metadata.get("authenticated") is False:
        return "public_capture"
    return None


def specific(value):
    return (bool(re.fullmatch(r"[A-Za-z0-9_-]{6,64}", value))
            and bool(re.search(r"[A-Za-z]", value)) and bool(re.search(r"[0-9]", value))
            and GENERIC_CODE.fullmatch(value) is None)


def referral(value):
    try:
        parts = urlsplit(value)
        host = (parts.hostname or "").lower().removeprefix("www.")
        if (parts.scheme not in {"http", "https"} or parts.username or parts.password or parts.port not in {None, 80, 443}
                or not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,63}", host)
                or any(host == domain or host.endswith("." + domain) for domain in COMMON_HOSTS)):
            return []
        return [(host + "?" + key.lower() + "=" + token) for key, token in parse_qsl(parts.query, max_num_fields=32)
                if key.lower() in REF_KEYS and specific(token)]
    except ValueError:
        return []


@router.get("/networks")
def networks(mode: Literal["live", "demo"] = "live"):
    # One joined query, no per-node reads, no scheduler/collector or writes.
    with store.Session() as db:
        rows = db.execute(select(ScanTask, ScannedContent, RiskAssessment)
                          .join(ScannedContent, ScannedContent.task_id == ScanTask.id)
                          .join(RiskAssessment, RiskAssessment.task_id == ScanTask.id)
                          .where(ScanTask.mode == mode, ScanTask.status == "completed")
                          .order_by(ScanTask.created_at.desc(), ScanTask.id.desc()).limit(SCAN_LIMIT)).all()
    nodes, captures = {}, []
    for task, content, risk in rows:
        metadata = content.source_metadata or {}
        provenance = public_origin(task, metadata)
        source_url = metadata.get("source_url")
        identity = account_url(source_url) if provenance and isinstance(source_url, str) else None
        if not identity:
            continue
        platform, account = identity
        evidence = (risk.analysis or {}).get("evidence", [])
        rule_flagged = risk.score >= 30 and any(isinstance(item, dict) and item.get("weight", 0) > 0 and item.get("quote") for item in evidence)
        if account not in nodes:
            nodes[account] = {"id": account, "url": account, "label": "@" + account.rsplit("/", 1)[-1].lstrip("@"),
                              "platform": platform, "scan_id": task.id, "score": risk.score, "level": risk.level,
                              "scan_count": 0, "rule_flagged": False, "provenance": provenance}
        nodes[account]["scan_count"] += 1
        nodes[account]["rule_flagged"] |= rule_flagged
        citation = {"scan_id": task.id, "account_id": account, "source_url": source_url,
                    "captured_at": metadata.get("captured_at") or metadata.get("collected_at") or store.iso(task.completed_at),
                    "provenance": provenance}
        captures.append((account, content, rule_flagged, citation))

    edges, shared = {}, defaultdict(dict)
    truncated = False

    def connect(source, target, kind, value, citations):
        nonlocal truncated
        if source == target:
            return
        if kind != "citation":
            source, target = sorted((source, target))
        key = (source, target, kind, value)
        if key in edges:
            return
        if len(edges) >= EDGE_LIMIT:
            truncated = True
            return
        edges[key] = {"id": str(len(edges) + 1), "source": source, "target": target, "kind": kind,
                      "value": value, "citations": citations}

    for account, content, flagged, citation in captures:
        text = (content.text or "")[:20000]
        links = list(dict.fromkeys([value for value in (content.links or [])[:100] if isinstance(value, str)]
                                   + [match.group(0).rstrip(".,;!?)»") for match in URL.finditer(text)]))[:150]
        for link in links:
            identity = account_url(link)
            if identity and identity[1] in nodes and flagged:
                connect(account, identity[1], "citation", identity[1], [{**citation, "quote": link[:2048]}])
            if flagged:
                for value in referral(link):
                    shared[("referral", value)].setdefault(account, {**citation, "quote": link[:2048]})
        if flagged:
            for match in PROMO.finditer(text):
                token = match.group(1).upper()
                if specific(token):
                    shared[("promo", token)].setdefault(account, {**citation, "quote": match.group(0)})
    for (kind, value), accounts in shared.items():
        for source, target in combinations(sorted(accounts), 2):
            connect(source, target, kind, value, [accounts[source], accounts[target]])
            if len(edges) >= EDGE_LIMIT:
                truncated = True
                break
        if truncated:
            break
    linked = {edge[end] for edge in edges.values() for end in ("source", "target")}
    return {"mode": mode, "nodes": list(nodes.values()), "edges": list(edges.values()),
            "summary": {"accounts": len(nodes), "connections": len(edges), "connected_accounts": len(linked),
                        "scans_considered": len(rows), "scans_included": len(captures), "scan_limit": SCAN_LIMIT,
                        "window_full": len(rows) == SCAN_LIMIT, "edges_truncated": truncated}}
