import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

DEPLOY = Path(__file__).resolve().parents[1]
ROOT = DEPLOY.parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location("railway_" + name, DEPLOY / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def run_bootstrap(target):
    env = dict(os.environ, SAFENET_DATABASE_URL="sqlite:///" + target.as_posix(),
               SAFENET_DATABASE_HOST="", PYTHONPATH=str(ROOT / "services/intelligence"))
    return subprocess.run([sys.executable, str(DEPLOY / "bootstrap.py")], env=env,
                          capture_output=True, text=True, timeout=30, check=True)


def test_new_database_seeded_once_without_modifying_existing_stopped_agents(tmp_path):
    target = tmp_path / "ai" / "safenet.db"
    legacy = tmp_path / "cases.json"
    legacy.write_text('{"legacy":true}')
    run_bootstrap(target)
    with sqlite3.connect(target) as db:
        rows = db.execute("SELECT id, enabled, interval_seconds, seeds, next_run_at FROM agents ORDER BY next_run_at").fetchall()
        assert {r[0] for r in rows} == {"telegram", "instagram", "threads", "youtube", "tiktok"}
        assert all(r[1] == 1 and r[2] == 1800 and json.loads(r[3]) for r in rows)
        from datetime import datetime
        offsets = [datetime.fromisoformat(r[4]) for r in rows]
        assert all((b - a).total_seconds() == 60 for a, b in zip(offsets, offsets[1:]))
        assert db.execute("SELECT COUNT(*) FROM scan_tasks").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM audit_logs WHERE stage='bootstrap'").fetchone()[0] == 5
        db.execute("UPDATE agents SET enabled=0,status='stopped',seeds='[]',source_cursor=31 WHERE id='telegram'")
        db.commit()
    run_bootstrap(target)
    with sqlite3.connect(target) as db:
        assert db.execute("SELECT enabled,status,seeds,source_cursor FROM agents WHERE id='telegram'").fetchone() == (0, "stopped", "[]", 31)
        assert db.execute("SELECT COUNT(*) FROM audit_logs WHERE stage='bootstrap'").fetchone()[0] == 5
    assert legacy.read_text() == '{"legacy":true}'
    assert not list(target.parent.glob(".bootstrap-*"))


def test_existing_empty_database_is_not_overwritten_or_autoenabled(tmp_path):
    target = tmp_path / "safenet.db"
    target.touch()
    run_bootstrap(target)
    assert target.stat().st_size == 0


def test_initial_monitor_config_rejects_login_pages(tmp_path):
    config = json.loads((DEPLOY / "initial-monitoring.json").read_text(encoding="utf-8-sig"))
    config["monitors"][0]["seeds"] = ["https://www.instagram.com/accounts/login/"]
    path = tmp_path / "invalid.json"
    path.write_text(json.dumps(config))
    with pytest.raises(ValueError):
        module("bootstrap").load_monitors(path)


def test_supervisor_commands_enforce_cloud_auth_and_single_private_worker():
    specs = module("serve").commands({"PORT": "4321", "SAFENET_LOCAL_ADMIN": "true"})
    assert [s[0] for s in specs] == ["api", "console"]
    api, console = specs
    assert api[1][-6:] == ["--host", "127.0.0.1", "--port", "8100", "--workers", "1"]
    assert console[3]["PORT"] == "4321" and console[3]["HOSTNAME"] == "0.0.0.0"
    assert all(s[3]["SAFENET_LOCAL_ADMIN"] == "false" for s in specs)
    assert all(s[3]["SAFENET_SECURE_COOKIE"] == "true" for s in specs)
    assert api[3]["SAFENET_VISION_URL"] == ""
    assert api[3]["SAFENET_MEDIA_ENABLED"] == "false"
    assert api[3]["SAFENET_RETENTION_DAYS"] == "7"


def test_text_only_mode_cannot_start_ollama_or_connect_to_vision(monkeypatch):
    serve = module("serve")
    lookup = Mock(side_effect=AssertionError("Text-only deployment must not launch Ollama"))
    monkeypatch.setattr(serve.shutil, "which", lookup)
    specs = serve.commands({"SAFENET_START_OLLAMA": "true", "SAFENET_VISION_URL": "http://127.0.0.1:11434"})
    assert [s[0] for s in specs] == ["api", "console"]
    assert all(s[3]["SAFENET_MEDIA_ENABLED"] == "false" and s[3]["SAFENET_VISION_URL"] == "" for s in specs)
    lookup.assert_not_called()


@pytest.mark.parametrize("port", ["8100", "0", "65536", "bad"])
def test_invalid_public_port_rejected(port):
    with pytest.raises(ValueError):
        module("serve").commands({"PORT": port})


def test_ollama_is_explicit_optional_and_requires_binary(monkeypatch):
    serve = module("serve")
    monkeypatch.setattr(serve.shutil, "which", lambda _: None)
    with pytest.raises(RuntimeError, match="not installed"):
        serve.commands({"SAFENET_START_OLLAMA": "true", "SAFENET_MEDIA_ENABLED": "true"})
    monkeypatch.setattr(serve.shutil, "which", lambda _: "/usr/bin/ollama")
    specs = serve.commands({"SAFENET_START_OLLAMA": "true", "SAFENET_MEDIA_ENABLED": "true"})
    assert specs[0][0] == "ollama"
    assert specs[0][3]["OLLAMA_HOST"] == "127.0.0.1:11434"
    assert specs[1][3]["SAFENET_VISION_URL"] == "http://127.0.0.1:11434"


@pytest.mark.parametrize("failed_index", [0, 1])
@pytest.mark.parametrize("exit_code", [0, 1, -9])
def test_any_server_exit_stops_all_children(monkeypatch, failed_index, exit_code):
    serve = module("serve")
    children = [Mock(), Mock()]
    for i, child in enumerate(children):
        child.poll.return_value = exit_code if i == failed_index else None
    shutdown = Mock()
    monkeypatch.setattr(serve, "terminate_children", shutdown)
    code = serve.supervise(serve.commands({}), threading.Event(), popen=Mock(side_effect=children))
    assert code == 1
    assert [child for _, child in shutdown.call_args.args[0]] == children


def test_spawn_failure_still_cleans_started_child(monkeypatch):
    serve = module("serve")
    shutdown = Mock()
    monkeypatch.setattr(serve, "terminate_children", shutdown)
    child = Mock()
    with pytest.raises(OSError):
        serve.supervise(serve.commands({}), threading.Event(), popen=Mock(side_effect=[child, OSError("spawn")]))
    assert shutdown.call_args.args[0] == [("api", child)]


def test_signal_stop_is_graceful(monkeypatch):
    serve = module("serve")
    stop = threading.Event()
    shutdown = Mock()
    monkeypatch.setattr(serve, "terminate_children", shutdown)
    child = Mock()
    child.poll.return_value = None
    def spawn(*args, **kwargs):
        stop.set()
        return child
    assert serve.supervise(serve.commands({}), stop, popen=spawn) == 0
    assert shutdown.call_args.args[0] == [("api", child)]


def test_unresponsive_child_is_killed_after_grace(monkeypatch):
    serve = module("serve")
    killpg = Mock()
    monkeypatch.setattr(serve, "os", SimpleNamespace(name="posix", killpg=killpg))
    monkeypatch.setattr(serve, "signal", SimpleNamespace(SIGTERM=15, SIGKILL=9))
    child = Mock(pid=42)
    child.wait.side_effect = [subprocess.TimeoutExpired("api", 0), None]
    serve.terminate_children([("api", child)], grace=0)
    assert killpg.call_args_list[0].args == (42, serve.signal.SIGTERM)
    assert killpg.call_args_list[1].args == (42, serve.signal.SIGKILL)
