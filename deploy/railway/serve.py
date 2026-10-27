"""Single-replica process supervisor. Any child failure terminates the container."""
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def commands(env):
    port = int(env.get("PORT", "3000"))
    if not 1 <= port <= 65535 or port == 8100:
        raise ValueError("PORT must be a valid public port distinct from the private API port 8100")
    api_env = dict(env)
    api_env.update(SAFENET_LOCAL_ADMIN="false", SAFENET_SECURE_COOKIE="true",
                   SAFENET_QUEUE="local", SAFENET_SCHEDULER_ENABLED="true")
    api_env.setdefault("SAFENET_RETENTION_DAYS", "7")
    api_env.setdefault("SAFENET_MEDIA_ENABLED", "false")
    api_env.setdefault("SAFENET_VISION_URL", "")
    api_env.setdefault("SAFENET_VISION_MODEL", "")
    media_enabled = api_env["SAFENET_MEDIA_ENABLED"].lower() in {"1", "true"}
    if not media_enabled:
        api_env.update(SAFENET_VISION_URL="", SAFENET_VISION_MODEL="", SAFENET_START_OLLAMA="false")
    specs = []
    if media_enabled and api_env.get("SAFENET_START_OLLAMA", "false").lower() in {"1", "true"}:
        binary = shutil.which("ollama")
        if not binary:
            raise RuntimeError("Ollama explicitly requested but not installed")
        ollama_env = dict(api_env, OLLAMA_HOST="127.0.0.1:11434")
        specs.append(("ollama", [binary, "serve"], ROOT, ollama_env))
        api_env["SAFENET_VISION_URL"] = "http://127.0.0.1:11434"
        api_env["SAFENET_VISION_MODEL"] = env.get("SAFENET_VISION_MODEL") or "qwen3-vl:2b-instruct"
    specs.append(("api", [sys.executable, "-m", "uvicorn", "safenet.app:app", "--host", "127.0.0.1",
                           "--port", "8100", "--workers", "1"], ROOT / "services/intelligence", api_env))
    specs.append(("console", ["node", str(ROOT / "apps/console/server.js")], ROOT / "apps/console",
                  dict(api_env, PORT=str(port), HOSTNAME="0.0.0.0")))
    return specs


def terminate_children(children, grace=20):
    # Terminate both servers and their process groups before container exit.
    for _, child in children:
        try:
            if os.name == "posix":
                os.killpg(child.pid, signal.SIGTERM)
            elif child.poll() is None:
                child.terminate()
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + grace
    for _, child in children:
        try:
            child.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            pass
    for _, child in children:
        try:
            if os.name == "posix":
                os.killpg(child.pid, signal.SIGKILL)
            elif child.poll() is None:
                child.kill()
        except ProcessLookupError:
            pass
        child.wait()


def supervise(specs, stop, *, popen=subprocess.Popen, startup_timeout=90):
    children = []
    try:
        for name, argv, cwd, env in specs:
            if stop.is_set():
                return 0
            children.append((name, popen(argv, cwd=cwd, env=env, start_new_session=os.name == "posix")))
            print(f"Started {name}", flush=True)
        deadline = time.monotonic() + startup_timeout
        ready = False
        while not stop.is_set():
            for name, child in children:
                code = child.poll()
                if code is not None:
                    print(f"Required child {name} exited ({code}); shutting down container", flush=True)
                    return 1
            if not ready:
                port = specs[-1][3]["PORT"]
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/v1/health", timeout=2) as response:
                        ready = response.status == 200
                except (OSError, urllib.error.URLError):
                    pass
                if ready:
                    print("Console and API health proxy ready", flush=True)
                elif time.monotonic() > deadline:
                    print("Health proxy startup deadline exceeded", flush=True)
                    return 1
            stop.wait(0.5)
        return 0
    finally:
        terminate_children(children)


def main():
    stop = threading.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stop.set())
    # Run bootstrap in its own process: its temporary DB environment must never
    # leak into the API process. No keys or environment contents are logged.
    bootstrap_env = dict(os.environ, PYTHONPATH=str(ROOT / "services/intelligence"))
    subprocess.run([sys.executable, str(Path(__file__).with_name("bootstrap.py"))],
                   env=bootstrap_env, check=True, timeout=90)
    return supervise(commands(os.environ), stop)


if __name__ == "__main__":
    raise SystemExit(main())
