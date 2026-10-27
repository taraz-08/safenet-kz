"""Restart recovery against a real isolated SQLite DB, without external I/O."""

from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
import threading

import pytest
from sqlalchemy import create_engine, select, func, text, inspect
from sqlalchemy.orm import sessionmaker

from safenet import runner, store, llm
from safenet.models import Agent, AuditLog, Base, RiskAssessment, ScanTask, utcnow


class SchedulerThread:
    """Do not run the 10-second loop; tests explicitly advance schedule()."""
    def __init__(self, **kwargs):
        self.alive = False

    def start(self):
        self.alive = True

    def is_alive(self):
        return self.alive

    def join(self, timeout=None):
        self.alive = False


@pytest.fixture
def recovery(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'recovery.db'}")
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(store, "engine", engine)
    monkeypatch.setattr(store, "Session", sessions)
    monkeypatch.setattr(runner, "Session", sessions)
    monkeypatch.setattr(runner, "_thread", None)
    monkeypatch.setattr(runner, "_startup_recovered", False)
    monkeypatch.setattr(runner, "_stop", threading.Event())
    monkeypatch.setattr(runner, "_lifecycle_lock", threading.Lock())
    monkeypatch.setattr(runner, "_schedule_lock", threading.Lock())
    monkeypatch.setattr(runner.settings, "scheduler_enabled", True)
    monkeypatch.setattr(runner.settings, "queue", "local")
    monkeypatch.setattr(runner.settings, "max_tasks", 100)
    dispatch = Mock()
    monkeypatch.setattr(runner, "dispatch", dispatch)
    # Replacing the module reference avoids mutating Python's threading module.
    thread_factory = Mock(side_effect=SchedulerThread)
    monkeypatch.setattr(runner, "threading", SimpleNamespace(Thread=thread_factory))
    monkeypatch.setattr(llm, "explain_with_llm", AsyncMock(return_value={"status": "disabled"}))
    yield SimpleNamespace(Session=sessions, engine=engine, dispatch=dispatch, threads=thread_factory)
    engine.dispose()


def seed_task(recovery, status="queued", *, agent=None, **kwargs):
    with recovery.Session.begin() as db:
        if agent:
            db.add(agent)
            db.flush()
        task = ScanTask(status=status, agent_id=agent.id if agent else None,
                        input_text="A public library opens at nine.", **kwargs)
        db.add(task)
        db.flush()
        return task.id


def test_start_recovers_and_replays_old_pending_jobs_once(recovery):
    old = utcnow() - timedelta(days=2)
    ids = [seed_task(recovery, state, created_at=old, started_at=old if state == "running" else None)
           for state in ("queued", "running")]
    finished = seed_task(recovery, "completed", created_at=old)
    runner.start_scheduler()
    runner.start_scheduler()
    recovery.threads.assert_called_once()
    runner.schedule()
    runner.schedule()
    assert {call.args[0] for call in recovery.dispatch.call_args_list} == set(ids)
    assert recovery.dispatch.call_count == 2
    runner.cleanup()
    with recovery.Session() as db:
        for task_id in ids:
            task = db.get(ScanTask, task_id)
            assert (task.status, task.stage) == ("queued", "recovered")
            assert task.started_at > old.replace(tzinfo=None)
            assert task.created_at == old.replace(tzinfo=None)
        assert db.get(ScanTask, finished).status == "completed"
    # Atomic worker claiming also prevents a duplicate submission from adding
    # a second assessment or collecting the same job twice.
    for task_id in ids:
        runner.execute(task_id)
        runner.execute(task_id)
    with recovery.Session() as db:
        assert db.scalar(select(func.count()).select_from(RiskAssessment)) == 2
        assert all(db.get(ScanTask, task_id).status == "completed" for task_id in ids)


def test_stopped_and_cancel_requested_tasks_are_not_replayed(recovery):
    agent = Agent(id="telegram", name="Stopped", platform="telegram", enabled=False,
                  status="stopped", stage="stopped", source_cursor=8)
    stopped = seed_task(recovery, "running", agent=agent)
    cancelled = seed_task(recovery, "queued", cancel_requested=True)
    runner.start_scheduler()
    runner.schedule()
    with recovery.Session() as db:
        for task_id in (stopped, cancelled):
            task = db.get(ScanTask, task_id)
            assert (task.status, task.stage, task.cancel_requested) == ("cancelled", "stopped", True)
            assert task.completed_at is not None
        agent = db.get(Agent, "telegram")
        assert (agent.enabled, agent.status, agent.stage, agent.source_cursor) == (False, "stopped", "stopped", 8)
    recovery.dispatch.assert_not_called()


@pytest.mark.parametrize("seeds", [[], ["https://www.instagram.com/public/"]])
def test_recovery_preserves_blocked_cooldown_even_after_cleanup(recovery, seeds):
    cooldown = utcnow() + timedelta(minutes=30)
    old = utcnow() - timedelta(days=2)
    agent = Agent(id="instagram", name="Paused", platform="instagram", enabled=True,
                  status="blocked", stage="blocked", next_run_at=cooldown,
                  last_error="Login required", seeds=seeds, source_cursor=7)
    task_id = seed_task(recovery, "running", agent=agent, created_at=old, started_at=old)
    runner.start_scheduler()
    runner.schedule()
    runner.cleanup()
    runner.schedule()
    recovery.dispatch.assert_not_called()
    with recovery.Session.begin() as db:
        task = db.get(ScanTask, task_id)
        agent = db.get(Agent, "instagram")
        assert (task.status, task.stage) == ("queued", "recovery_pending")
        assert (agent.status, agent.stage, agent.last_error, agent.source_cursor) == ("blocked", "blocked", "Login required", 7)
        assert agent.next_run_at == cooldown.replace(tzinfo=None)
        agent.next_run_at = utcnow() - timedelta(seconds=1)
    runner.schedule()
    runner.schedule()
    recovery.dispatch.assert_called_once_with(task_id)
    with recovery.Session() as db:
        assert db.get(Agent, "instagram").source_cursor == 7


def test_normal_next_schedule_time_does_not_delay_existing_accepted_job(recovery):
    next_run = utcnow() + timedelta(minutes=15)
    agent = Agent(id="telegram", name="Enabled", platform="telegram", enabled=True,
                  status="running", next_run_at=next_run, source_cursor=4)
    task_id = seed_task(recovery, "running", agent=agent)
    runner.start_scheduler()
    runner.schedule()
    recovery.dispatch.assert_called_once_with(task_id)
    with recovery.Session() as db:
        agent = db.get(Agent, "telegram")
        assert agent.source_cursor == 4
        assert agent.next_run_at == next_run.replace(tzinfo=None)


def test_stop_start_in_same_process_does_not_recover_live_executor_tasks(recovery):
    task_id = seed_task(recovery, "running")
    runner.start_scheduler()
    runner.schedule()
    with recovery.Session.begin() as db:
        db.get(ScanTask, task_id).status = "running"
    runner.stop_scheduler()
    runner.start_scheduler()
    runner.schedule()
    recovery.dispatch.assert_called_once_with(task_id)
    with recovery.Session() as db:
        assert db.get(ScanTask, task_id).status == "running"
        assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.stage == "recovery_pending")) == 1


def test_concurrent_start_calls_recover_once_and_create_one_scheduler(recovery):
    task_id = seed_task(recovery, "running")
    barrier = threading.Barrier(6)

    def start():
        barrier.wait(timeout=5)
        runner.start_scheduler()

    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = [executor.submit(start) for _ in range(6)]
        for future in futures:
            future.result(timeout=5)
    recovery.threads.assert_called_once()
    runner.schedule()
    recovery.dispatch.assert_called_once_with(task_id)
    with recovery.Session() as db:
        assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.stage == "recovery_pending")) == 1


def test_stop_after_recovery_before_replay_cancels_task(recovery):
    agent = Agent(id="telegram", name="Enabled", platform="telegram", enabled=True)
    task_id = seed_task(recovery, "running", agent=agent)
    runner.start_scheduler()
    with recovery.Session.begin() as db:
        agent = db.get(Agent, "telegram")
        agent.enabled, agent.status, agent.stage = False, "stopped", "stopped"
    runner.schedule()
    recovery.dispatch.assert_not_called()
    with recovery.Session() as db:
        assert db.get(ScanTask, task_id).status == "cancelled"
        assert db.get(Agent, "telegram").status == "stopped"


@pytest.mark.parametrize("queue,enabled", [("celery", True), ("local", False)])
def test_nonlocal_or_disabled_scheduler_does_not_recover_tasks(recovery, queue, enabled, monkeypatch):
    monkeypatch.setattr(runner.settings, "queue", queue)
    monkeypatch.setattr(runner.settings, "scheduler_enabled", enabled)
    task_id = seed_task(recovery, "running")
    runner.start_scheduler()
    recovery.threads.assert_not_called()
    with recovery.Session() as db:
        assert db.get(ScanTask, task_id).status == "running"


def test_additive_cursor_migration_backfills_once_without_changing_monitor(recovery):
    cooldown = utcnow() + timedelta(minutes=20)
    agent = Agent(id="telegram", name="Existing", platform="telegram", enabled=False,
                  status="stopped", stage="stopped", seeds=["https://t.me/s/example"], next_run_at=cooldown)
    seed_task(recovery, "completed", agent=agent)
    with recovery.Session.begin() as db:
        db.add(ScanTask(agent_id="telegram", status="failed"))
    with recovery.engine.begin() as connection:
        connection.execute(text("ALTER TABLE agents DROP COLUMN source_cursor"))
    store.initialize()
    assert "source_cursor" in {column["name"] for column in inspect(recovery.engine).get_columns("agents")}
    with recovery.Session.begin() as db:
        agent = db.get(Agent, "telegram")
        assert agent.source_cursor == 2
        assert not agent.enabled and agent.status == "stopped"
        assert agent.seeds == ["https://t.me/s/example"]
        assert agent.next_run_at == cooldown.replace(tzinfo=None)
        agent.source_cursor = 17
    store.initialize()
    with recovery.Session() as db:
        assert db.get(Agent, "telegram").source_cursor == 17
        assert db.get(Agent, "youtube").source_cursor == 0
