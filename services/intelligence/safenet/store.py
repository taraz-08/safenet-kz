from datetime import timezone
from sqlalchemy import create_engine, event, select, func, inspect, text
from sqlalchemy.orm import sessionmaker
from .settings import settings
from .models import Base, Agent, User, ScanTask, ScannedContent, RiskAssessment, AuditLog

engine = create_engine(settings.database_url, pool_pre_ping=True, connect_args={"check_same_thread": False, "timeout": 30} if settings.database_url.startswith("sqlite") else {})
Session = sessionmaker(engine, expire_on_commit=False)

if settings.database_url.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def configure_sqlite(connection, _):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()


def initialize():
    Base.metadata.create_all(engine)
    # Additive migration for databases created by the initial AI prototype.
    if "started_at" not in {column["name"] for column in inspect(engine).get_columns("scan_tasks")}:
        timestamp_type = ScanTask.__table__.c.started_at.type.compile(dialect=engine.dialect)
        with engine.begin() as connection:
            connection.execute(text(f"ALTER TABLE scan_tasks ADD COLUMN started_at {timestamp_type}"))
    if "input_media" not in {column["name"] for column in inspect(engine).get_columns("scan_tasks")}:
        json_type = ScanTask.__table__.c.input_media.type.compile(dialect=engine.dialect)
        with engine.begin() as connection:
            connection.execute(text(f"ALTER TABLE scan_tasks ADD COLUMN input_media {json_type}"))
    if "source_cursor" not in {column["name"] for column in inspect(engine).get_columns("agents")}:
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE agents ADD COLUMN source_cursor INTEGER NOT NULL DEFAULT 0"))
            # Preserve the old next-source position once, then decouple rotation
            # from history retention. Repeated initialization never resets it.
            connection.execute(text("UPDATE agents SET source_cursor = (SELECT COUNT(*) FROM scan_tasks WHERE scan_tasks.agent_id = agents.id)"))
    with Session.begin() as db:
        for platform, name in [("tiktok", "TikTok Monitor"), ("instagram", "Instagram Monitor"), ("youtube", "YouTube Monitor"), ("threads", "Threads Monitor"), ("telegram", "Telegram Monitor")]:
            if not db.get(Agent, platform):
                db.add(Agent(id=platform, name=name, platform=platform))
        if not db.scalar(select(User.id).limit(1)):
            db.add(User(name="Administrator"))


def iso(value):
    if value is None:
        return None
    aware = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    return aware.isoformat().replace("+00:00", "Z")


def agent_json(agent):
    keys = ("id", "name", "platform", "enabled", "status", "stage", "last_error", "seeds", "interval_seconds", "checked", "flagged")
    result = {key: getattr(agent, key) for key in keys}
    result.update(last_run_at=iso(agent.last_run_at), next_run_at=iso(agent.next_run_at))
    return result


def scan_json(db, task):
    content = db.scalar(select(ScannedContent).where(ScannedContent.task_id == task.id))
    risk = db.scalar(select(RiskAssessment).where(RiskAssessment.task_id == task.id))
    return {"id": task.id, "agent_id": task.agent_id, "url": task.url, "platform": task.platform, "mode": task.mode, "status": task.status, "stage": task.stage, "created_at": iso(task.created_at), "completed_at": iso(task.completed_at), "title": content.title if content else "", "text": content.text if content else task.input_text, "metadata": content.source_metadata if content else {"origin": ("synthetic_media" if task.mode == "demo" else "uploaded_media") if task.input_media else "manual" if task.input_text else "public_url", "independently_fetched": False}, "score": risk.score if risk else None, "level": risk.level if risk else None, "category": risk.category if risk else None, "analysis": risk.analysis if risk else None, "error": task.error, "review": task.review}


def audit(stage, message, agent_id=None, task_id=None):
    with Session.begin() as db:
        db.add(AuditLog(stage=stage, message=message[:1200], agent_id=agent_id, task_id=task_id))


def overview(mode="live"):
    with Session() as db:
        where = ScanTask.mode == mode
        scanned = db.scalar(select(func.count()).select_from(ScanTask).where(where, ScanTask.status == "completed")) or 0
        levels = dict(db.execute(select(RiskAssessment.level, func.count()).join(ScanTask, RiskAssessment.task_id == ScanTask.id).where(where).group_by(RiskAssessment.level)).all())
        agents = [agent_json(row) for row in db.scalars(select(Agent).order_by(Agent.id))]
        recent = [scan_json(db, row) for row in db.scalars(select(ScanTask).where(where).order_by(ScanTask.created_at.desc()).limit(12))]
        day = func.date(ScanTask.created_at)
        rows = db.execute(select(day, RiskAssessment.score).join(ScanTask, RiskAssessment.task_id == ScanTask.id).where(where).order_by(day.desc()).limit(10000)).all()
        timeline = {}
        for date, score in rows:
            key = str(date)
            entry = timeline.setdefault(key, {"date": key, "count": 0, "suspicious": 0})
            entry["count"] += 1
            entry["suspicious"] += int(score >= 30)
        return {"mode": mode, "totals": {"scanned": scanned, "suspicious": sum(levels.get(level, 0) for level in ("medium", "high", "critical")), "critical": levels.get("critical", 0), "active_agents": sum(item["enabled"] for item in agents)}, "distribution": [{"level": level, "count": levels.get(level, 0)} for level in ("low", "medium", "high", "critical")], "timeline": sorted(timeline.values(), key=lambda item: item["date"])[-30:], "recent": recent, "agents": agents}
