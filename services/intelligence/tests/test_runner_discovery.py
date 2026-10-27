"""Exercise persisted seeds through the real scheduler and worker, with no I/O."""

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from safenet import collectors, llm, runner, store
from safenet.models import Agent, AuditLog, Base, RiskAssessment, ScanTask, utcnow


@pytest.fixture
def discovery(monkeypatch):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(runner, "Session", sessions)
    monkeypatch.setattr(store, "Session", sessions)
    monkeypatch.setattr(runner.settings, "max_tasks", 100)
    dispatch = Mock()
    collect = AsyncMock(side_effect=AssertionError("Unexpected collection"))
    monkeypatch.setattr(runner, "dispatch", dispatch)
    monkeypatch.setattr(collectors, "collect", collect)
    monkeypatch.setattr(llm, "explain_with_llm", AsyncMock(return_value={"status": "disabled"}))
    yield SimpleNamespace(Session=sessions, dispatch=dispatch, collect=collect)
    engine.dispose()


def add_agent(discovery, seeds, platform="instagram", **kwargs):
    with discovery.Session.begin() as db:
        db.add(Agent(id=platform, name="Offline monitor", platform=platform,
                     enabled=True, seeds=seeds, interval_seconds=60, **kwargs))


def test_scheduler_cleans_contaminated_seeds_before_rotation(discovery):
    add_agent(discovery, [
        "https://www.instagram.com/", "https://www.instagram.com/accounts/login/",
        "https://l.instagram.com/?u=https://instagram.com/public/", None,
        "http://instagram.com/Public/?igsh=tracking", "https://m.instagram.com/public/",
        "https://instagram.com/p/AbC123/?img_index=2", "https://www.tiktok.com/@other",
    ])
    expected = ["https://www.instagram.com/public/", "https://www.instagram.com/p/AbC123/"]
    # Repeated due runs rotate only through public content, never the old nav URLs.
    for index in range(4):
        runner.schedule()
        task_id = discovery.dispatch.call_args.args[0]
        with discovery.Session.begin() as db:
            agent = db.get(Agent, "instagram")
            assert agent.seeds == expected
            task = db.get(ScanTask, task_id)
            assert task.url == expected[index % len(expected)]
            task.status = "completed"
            agent.next_run_at = utcnow() - timedelta(seconds=1)
    assert discovery.dispatch.call_count == 4
    discovery.collect.assert_not_awaited()


@pytest.mark.parametrize("seeds", [
    ["https://www.instagram.com/", "https://instagram.com/signup/", "https://l.instagram.com/?u=public"],
    [None, 12, {}, "https://[broken/"], "https://www.instagram.com/public/",
])
def test_only_invalid_seeds_wait_without_queued_work(discovery, seeds):
    add_agent(discovery, seeds)
    runner.schedule()
    runner.schedule()
    with discovery.Session() as db:
        agent = db.get(Agent, "instagram")
        assert agent.seeds == []
        assert (agent.status, agent.stage) == ("idle", "waiting_for_seed")
        assert list(db.scalars(select(ScanTask))) == []
    discovery.dispatch.assert_not_called()


def test_seed_cleanup_preserves_platform_cooldown(discovery):
    next_run = utcnow() + timedelta(minutes=15)
    add_agent(discovery, ["https://instagram.com/login/", "https://instagram.com/Public/?igsh=1"],
              status="blocked", stage="blocked", next_run_at=next_run)
    runner.schedule()
    with discovery.Session() as db:
        agent = db.get(Agent, "instagram")
        assert agent.seeds == ["https://www.instagram.com/public/"]
        assert (agent.status, agent.stage) == ("blocked", "blocked")
        assert agent.next_run_at.replace(tzinfo=next_run.tzinfo) == next_run
    discovery.dispatch.assert_not_called()


def test_source_cursor_survives_retention_and_new_session(discovery, monkeypatch):
    from safenet import media
    monkeypatch.setattr(media, "remove_media", Mock())
    urls = [f"https://www.instagram.com/source_{i}/" for i in range(3)]
    add_agent(discovery, urls)
    for index in range(7):
        runner.schedule()
        task_id = discovery.dispatch.call_args.args[0]
        with discovery.Session.begin() as db:
            task = db.get(ScanTask, task_id)
            agent = db.get(Agent, "instagram")
            assert task.url == urls[index % 3]
            assert agent.source_cursor == index + 1
            task.status = "completed"
            task.created_at = utcnow() - timedelta(days=365)
            agent.next_run_at = utcnow() - timedelta(seconds=1)
        runner.cleanup()
        with discovery.Session() as db:
            assert list(db.scalars(select(ScanTask))) == []
            assert db.get(Agent, "instagram").source_cursor == index + 1


def test_full_queue_does_not_skip_persisting_seed_cleanup(discovery, monkeypatch):
    monkeypatch.setattr(runner.settings, "max_tasks", 1)
    add_agent(discovery, ["https://instagram.com/login/", "https://instagram.com/Public/?igsh=1"])
    add_agent(discovery, ["https://t.me/share/", "https://t.me/PublicChannel/123"], platform="telegram")
    with discovery.Session.begin() as db:
        db.add(ScanTask(url="https://example.com/public", status="queued"))
    runner.schedule()
    with discovery.Session() as db:
        assert db.get(Agent, "instagram").seeds == ["https://www.instagram.com/public/"]
        assert db.get(Agent, "telegram").seeds == ["https://t.me/s/publicchannel/123"]
        assert len(list(db.scalars(select(ScanTask)))) == 1
    discovery.dispatch.assert_not_called()


@pytest.mark.parametrize("outcome", ["blocked", "failure"])
def test_legacy_worker_persists_cleanup_even_without_a_successful_collection(discovery, outcome):
    add_agent(discovery, ["https://instagram.com/login/", "https://instagram.com/Public/?igsh=1"])
    with discovery.Session.begin() as db:
        task = ScanTask(url="https://www.instagram.com/public/", platform="instagram", agent_id="instagram")
        db.add(task)
        db.flush()
        task_id = task.id

    async def unavailable(*args, **kwargs):
        # Cleanup has committed before the collector starts or raises.
        with discovery.Session() as db:
            assert db.get(Agent, "instagram").seeds == ["https://www.instagram.com/public/"]
        if outcome == "failure":
            raise RuntimeError("Offline collector failure")
        return {"status": "blocked", "reason": "Login required"}

    discovery.collect.side_effect = unavailable
    runner.execute(task_id)
    with discovery.Session() as db:
        assert db.get(Agent, "instagram").seeds == ["https://www.instagram.com/public/"]
        assert db.get(ScanTask, task_id).status == ("failed" if outcome == "failure" else "blocked")
        assert list(db.scalars(select(RiskAssessment))) == []
    discovery.collect.assert_awaited_once()


def test_public_scan_routes_cross_platform_links_and_records_provenance(discovery):
    cooldown = utcnow() + timedelta(minutes=20)
    add_agent(discovery, ["https://www.threads.com/@existing"], platform="threads",
              status="blocked", stage="blocked", next_run_at=cooldown)
    add_agent(discovery, [], platform="youtube")
    add_agent(discovery, [], platform="telegram")
    with discovery.Session.begin() as db:
        db.get(Agent, "telegram").enabled = False
        task = ScanTask(url="https://www.instagram.com/public/", platform="instagram", mode="live")
        db.add(task)
        db.flush()
        task_id = task.id
    discovery.collect.side_effect = None
    discovery.collect.return_value = {
        "status": "completed", "url": "https://www.instagram.com/public/",
        "text": "A public account linking its other pages, with no advertising claim.",
        "links": ["https://www.threads.net/@PUBLIC?tracking=1", "https://www.threads.com/@public",
                  "https://youtu.be/abcdefghijk?t=3", "https://www.threads.com/login",
                  "https://www.threads.com.evil.test/@fake", "https://t.me/disabled_channel",
                  "http://127.0.0.1/private", "javascript:alert(1)"],
        "metadata": {},
    }
    runner.execute(task_id)
    with discovery.Session() as db:
        target = db.get(Agent, "threads")
        assert target.seeds == ["https://www.threads.com/@existing", "https://www.threads.com/@public"]
        assert (target.status, target.stage, target.checked, target.flagged) == ("blocked", "blocked", 0, 0)
        assert target.next_run_at.replace(tzinfo=cooldown.tzinfo) == cooldown
        assert db.get(Agent, "youtube").seeds == ["https://www.youtube.com/watch?v=abcdefghijk"]
        assert db.get(Agent, "telegram").seeds == []
        logs = list(db.scalars(select(AuditLog).where(AuditLog.stage == "source_discovered")))
        assert len(logs) == 2
        assert {log.agent_id for log in logs} == {"threads", "youtube"}
        assert all(log.task_id == task_id and "https://www.instagram.com/public/" in log.message for log in logs)
        assert all("does not establish risk" in log.message for log in logs)
        # Links receive no inherited score or synthetic assessment of their own.
        assert len(list(db.scalars(select(RiskAssessment)))) == 1
    discovery.dispatch.assert_not_called()


@pytest.mark.parametrize("source", ["demo", "manual_text", "upload"])
def test_nonpublic_inputs_cannot_seed_live_monitors(discovery, source):
    add_agent(discovery, [], platform="threads")
    with discovery.Session.begin() as db:
        task = ScanTask(url="https://www.instagram.com/public/", platform="instagram", mode="live")
        if source == "demo":
            task.mode = "demo"
        elif source == "manual_text":
            task.input_text = "https://www.threads.com/@unverified"
        else:
            task.input_media = {"filename": "local.mp4"}
        db.add(task)
        db.flush()
        runner._discover_monitor_sources(db, task, ["https://www.threads.com/@unverified"])
    with discovery.Session() as db:
        assert db.get(Agent, "threads").seeds == []
        assert list(db.scalars(select(AuditLog))) == []


def test_cross_platform_discovery_caps_full_monitor_without_eviction(discovery):
    seeds = [f"https://www.threads.com/@existing_{i}" for i in range(100)]
    add_agent(discovery, seeds, platform="threads")
    with discovery.Session.begin() as db:
        task = ScanTask(url="https://www.instagram.com/public/", platform="instagram", mode="live")
        db.add(task)
        db.flush()
        runner._discover_monitor_sources(db, task, ["https://www.threads.com/@new"])
    with discovery.Session() as db:
        assert db.get(Agent, "threads").seeds == seeds
        assert list(db.scalars(select(AuditLog))) == []


def test_telegram_aliases_schedule_one_public_preview(discovery):
    add_agent(discovery, ["https://t.me/+private", "https://t.me/PublicChannel/123",
                          "https://t.me/s/publicchannel/123?single"], platform="telegram")
    runner.schedule()
    with discovery.Session() as db:
        assert db.get(Agent, "telegram").seeds == ["https://t.me/s/publicchannel/123"]
        task = db.get(ScanTask, discovery.dispatch.call_args.args[0])
        assert task.platform == "telegram" and task.url == "https://t.me/s/publicchannel/123"


@pytest.mark.parametrize("existing_count,expected_count", [(1, 11), (95, 100)])
def test_execute_discovers_only_new_public_urls_with_per_run_and_total_bounds(discovery, existing_count, expected_count):
    seeds = [f"https://www.instagram.com/existing_{i}/" for i in range(existing_count)]
    add_agent(discovery, ["https://instagram.com/login/", *seeds])
    with discovery.Session.begin() as db:
        task = ScanTask(url=seeds[0], platform="instagram", agent_id="instagram", mode="live")
        db.add(task)
        db.flush()
        task_id = task.id
    links = ["https://instagram.com/", "https://instagram.com/accounts/emailsignup/",
             "https://l.instagram.com/?u=public", "https://www.tiktok.com/@other"]
    links += [seeds[0] + "?igsh=tracking"] * 15
    for index in range(20):
        links.extend([f"https://instagram.com/new_{index}/?igsh=tracking",
                      f"https://m.instagram.com/NEW_{index}/"])
    discovery.collect.side_effect = None
    discovery.collect.return_value = {
        "status": "completed", "url": seeds[0], "title": "Public notice",
        "text": "The public library opens at nine and holds a reading club on Tuesday.",
        "links": links, "metadata": {"origin": "public_http"},
    }
    runner.execute(task_id)
    with discovery.Session() as db:
        agent = db.get(Agent, "instagram")
        assert db.get(ScanTask, task_id).status == "completed"
        assert agent.seeds == seeds + [f"https://www.instagram.com/new_{i}/" for i in range(expected_count - existing_count)]
        assert agent.checked == 1 and agent.flagged == 0
        assessment = db.scalar(select(RiskAssessment).where(RiskAssessment.task_id == task_id))
        assert assessment.score == 0
    discovery.collect.assert_awaited_once()
