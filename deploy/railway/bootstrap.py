"""Initialize a brand-new SQLite database atomically; never re-enable old agents."""
import json
import os
from pathlib import Path
import tempfile

from filelock import FileLock
from sqlalchemy.engine import make_url

CONFIG = Path(__file__).with_name("initial-monitoring.json")
PLATFORMS = {"telegram", "instagram", "youtube", "threads", "tiktok"}


def load_monitors(path=CONFIG):
    from safenet.discovery_urls import public_content_urls
    config = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    monitors = config["monitors"]
    if config.get("version") != 1 or len(monitors) != 5 or {row["id"] for row in monitors} != PLATFORMS:
        raise ValueError("Expected exactly the five approved monitor configurations")
    result = []
    for row in monitors:
        seeds = public_content_urls(row["seeds"], row["id"])
        if not seeds or len(seeds) != len(row["seeds"]) or row["enabled"] is not True:
            raise ValueError("Initial monitors must have unique valid public sources and explicit enablement")
        result.append({"id": row["id"], "seeds": seeds,
                       "interval_seconds": max(300, min(86400, int(row["interval_seconds"])))})
    return result


def bootstrap(config_path=CONFIG):
    url = make_url(os.environ.get("SAFENET_DATABASE_URL", "sqlite:////data/ai/safenet.db"))
    if url.drivername != "sqlite" or not url.database or url.database == ":memory:":
        raise ValueError("Railway bootstrap requires a persistent SQLite file")
    target = Path(url.database).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(str(target.parent / ".bootstrap.lock"), timeout=60):
        if target.exists():
            print("Existing AI database retained; monitor settings unchanged", flush=True)
            return False
        monitors = load_monitors(config_path)
        # A crash before os.replace leaves no published half-configured database.
        with tempfile.TemporaryDirectory(prefix=".bootstrap-", dir=target.parent) as temporary:
            staged = Path(temporary) / "safenet.db"
            os.environ["SAFENET_DATABASE_URL"] = "sqlite:///" + staged.as_posix()
            os.environ["SAFENET_DATABASE_HOST"] = ""
            from datetime import timedelta
            from sqlalchemy import text
            from safenet import store
            from safenet.models import Agent, AuditLog, utcnow
            try:
                store.initialize()
                now = utcnow()
                with store.Session.begin() as db:
                    for index, row in enumerate(monitors):
                        agent = db.get(Agent, row["id"])
                        agent.enabled = True
                        agent.seeds = row["seeds"]
                        agent.interval_seconds = row["interval_seconds"]
                        agent.status, agent.stage = "idle", "waiting_for_schedule"
                        agent.next_run_at = now + timedelta(seconds=30 + 60 * index)
                        db.add(AuditLog(agent_id=agent.id, stage="bootstrap", message="Approved public sources configured on initial cloud database creation; awaiting real collection"))
                # Publish a self-contained SQLite file rather than leaving a WAL behind.
                with store.engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
                    connection.execute(text("PRAGMA wal_checkpoint(TRUNCATE)"))
                    connection.execute(text("PRAGMA journal_mode=DELETE"))
            finally:
                store.engine.dispose()
            os.replace(staged, target)
        print("Created AI database with five approved monitors; first runs staggered", flush=True)
        return True


if __name__ == "__main__":
    bootstrap()
