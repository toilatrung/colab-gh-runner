#!/usr/bin/env python3
"""
Colab Runner Monitor – webapp local giám sát self-hosted runner chạy trên Google Colab.

- Không cần thư viện ngoài (chỉ Python >= 3.9 stdlib).
- Playwright là tuỳ chọn: có thì tự mở Colab + "Run all"; không có thì mở trình duyệt mặc định.

Chạy:  python server.py            (mặc định http://127.0.0.1:8765)
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
STATIC = ROOT / "static"

DEFAULT_CONFIG = {
    "github_token": "",            # PAT: Administration read/write (repo) hoặc admin:org
    "scope": "repo",               # "repo" | "org"
    "target": "OWNER/REPO",        # OWNER/REPO hoặc tên ORG
    "runner_name": "colab-runner",
    "colab_url": "https://colab.research.google.com/github/OWNER/REPO/blob/main/colab/colab_github_runner.ipynb",
    "rerun_mode": "playwright",    # "playwright" | "browser"
    "browser_profile_dir": str(ROOT / ".colab-profile"),
    "browser_channel": "chrome",   # "chrome" | "msedge" | "" (chromium đi kèm playwright)
    "mode": "github",              # "github" (poll GitHub, như cũ) | "vercel-agent" (nhận lệnh từ Vercel)
    "vercel_url": "",              # vd https://ten-app.vercel.app  (chỉ dùng ở mode vercel-agent)
    "agent_token": "",             # trùng AGENT_TOKEN trên Vercel
    "agent_poll_sec": 30,
    "auto_rerun": False,
    "only_when_queued": False,     # chỉ rerun khi có job đang chờ
    "poll_interval_sec": 60,
    "offline_grace_sec": 180,      # offline liên tục bao lâu thì rerun
    "rerun_cooldown_sec": 600,     # tối thiểu giữa 2 lần rerun
    "host": "127.0.0.1",
    "port": 8765,
}


# ----------------------------------------------------------------- config
def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    if os.environ.get("GH_PAT"):
        cfg["github_token"] = os.environ["GH_PAT"]
    if os.environ.get("AGENT_TOKEN"):
        cfg["agent_token"] = os.environ["AGENT_TOKEN"]
    if cfg.get("mode") not in ("github", "vercel-agent"):
        cfg["mode"] = "github"
    return cfg

SECRET_KEYS = ("github_token", "agent_token")


def save_config(cfg):
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


CFG = load_config()
LOCK = threading.RLock()


# ----------------------------------------------------------------- state
class State:
    def __init__(self):
        self.runner = None          # dict của runner khớp tên
        self.runners = []
        self.queued = 0
        self.in_progress = 0
        self.last_check = None
        self.last_error = None
        self.offline_since = None
        self.last_rerun = 0.0
        self.rerun_count = 0
        self.driver_proc = None
        self.agent_last_poll = None
        self.agent_error = None
        self.agent_attempts = {}    # id lệnh -> số lần thử
        self.logs = []

    def log(self, msg, level="info"):
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with LOCK:
            self.logs.append({"time": ts, "level": level, "msg": msg})
            self.logs = self.logs[-300:]
        try:
            print(f"[{ts}] {level.upper():5} {msg}", flush=True)
        except Exception:  # console không in được ký tự (Windows cp1252) – không được làm hỏng luồng chính
            pass


S = State()


# ----------------------------------------------------------------- GitHub API
def gh(path, method="GET"):
    if not CFG["github_token"]:
        raise RuntimeError("Chưa cấu hình github_token")
    req = urllib.request.Request(
        "https://api.github.com" + path, method=method,
        headers={"Authorization": f"Bearer {CFG['github_token']}",
                 "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28",
                 "User-Agent": "colab-runner-monitor"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"GitHub {e.code}: {e.read().decode(errors='ignore')[:200]}")


def base_path():
    return f"/repos/{CFG['target']}" if CFG["scope"] == "repo" else f"/orgs/{CFG['target']}"


def check_status():
    data = gh(f"{base_path()}/actions/runners?per_page=100")
    runners = data.get("runners", [])
    mine = next((r for r in runners if r["name"] == CFG["runner_name"]), None)
    queued = in_prog = 0
    if CFG["scope"] == "repo":
        queued = gh(f"{base_path()}/actions/runs?status=queued&per_page=1").get("total_count", 0)
        in_prog = gh(f"{base_path()}/actions/runs?status=in_progress&per_page=1").get("total_count", 0)
    with LOCK:
        S.runners, S.runner, S.queued, S.in_progress = runners, mine, queued, in_prog
        S.last_check = datetime.now(timezone.utc).isoformat()
        S.last_error = None
        online = bool(mine and mine["status"] == "online")
        if online:
            if S.offline_since:
                S.log(f"Runner '{CFG['runner_name']}' ONLINE trở lại")
            S.offline_since = None
        elif S.offline_since is None:
            S.offline_since = time.time()
            S.log(f"Runner '{CFG['runner_name']}' OFFLINE/không tồn tại", "warn")
    return online


def cleanup_offline():
    n = 0
    for r in gh(f"{base_path()}/actions/runners?per_page=100").get("runners", []):
        if r["status"] == "offline":
            gh(f"{base_path()}/actions/runners/{r['id']}", method="DELETE")
            n += 1
    S.log(f"Đã xoá {n} runner offline")
    return n


# ----------------------------------------------------------------- rerun Colab
def driver_running():
    p = S.driver_proc
    return p is not None and p.poll() is None


def stop_driver():
    if driver_running():
        S.driver_proc.terminate()
        try:
            S.driver_proc.wait(10)
        except subprocess.TimeoutExpired:
            S.driver_proc.kill()
    S.driver_proc = None


def have_playwright():
    try:
        import playwright  # noqa: F401
        return True
    except ImportError:
        return False


def rerun(reason="manual", login=False):
    with LOCK:
        S.last_rerun = time.time()
        S.rerun_count += 1
    mode = CFG["rerun_mode"]
    if mode == "playwright" and not have_playwright():
        S.log("Chưa cài playwright → chuyển sang mở trình duyệt", "warn")
        mode = "browser"
    S.log(f"Rerun Colab ({reason}, mode={mode})")
    if mode == "browser":
        webbrowser.open(CFG["colab_url"])
        S.log("Đã mở notebook – bấm Runtime → Run all (Ctrl+F9)")
        return
    stop_driver()
    cmd = [sys.executable, str(ROOT / "colab_driver.py"), "--url", CFG["colab_url"],
           "--profile", CFG["browser_profile_dir"]]
    if CFG.get("browser_channel"):
        cmd += ["--channel", CFG["browser_channel"]]
    if login:
        cmd.append("--login")
    # Windows: ép UTF-8 hai đầu ống, nếu không log tiếng Việt của driver làm UnicodeEncodeError (cp1252)
    S.driver_proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, bufsize=1, encoding="utf-8", errors="replace",
                                     env=dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1"))
    threading.Thread(target=_pipe_driver, args=(S.driver_proc,), daemon=True).start()


def _pipe_driver(proc):
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            S.log("[driver] " + line, "warn" if "ERR" in line or "WARN" in line else "info")
    S.log(f"[driver] thoát rc={proc.wait()}")


# ----------------------------------------------------------------- watcher
def watcher():
    while True:
        try:
            online = check_status()
            with LOCK:
                due = (CFG["mode"] == "github"
                       and CFG["auto_rerun"] and not online and S.offline_since
                       and time.time() - S.offline_since >= CFG["offline_grace_sec"]
                       and time.time() - S.last_rerun >= CFG["rerun_cooldown_sec"]
                       and (not CFG["only_when_queued"] or S.queued > 0))
            if due:
                rerun("auto: runner offline")
        except Exception as e:
            with LOCK:
                S.last_error = str(e)
            S.log(f"Lỗi kiểm tra: {e}", "error")
        time.sleep(max(15, int(CFG["poll_interval_sec"])))


# ----------------------------------------------------------------- agent (Vercel)
def vercel_call(path, method="GET", body=None):
    base = (CFG.get("vercel_url") or "").rstrip("/")
    if not base or not CFG.get("agent_token"):
        raise RuntimeError("Chưa cấu hình vercel_url / agent_token")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        base + path, method=method, data=data,
        headers={"Authorization": f"Bearer {CFG['agent_token']}",
                 "Content-Type": "application/json",
                 "User-Agent": "colab-runner-agent"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Vercel {e.code}: {e.read().decode(errors='ignore')[:120]}")


def agent_poll_once():
    """Lấy 1 lệnh từ Vercel; rerun → ack. Trả về True nếu đã xử lý một lệnh."""
    cmd = vercel_call("/api/agent/next").get("command")
    with LOCK:
        S.agent_last_poll = datetime.now(timezone.utc).isoformat()
        S.agent_error = None
    if not cmd:
        return False
    cid = str(cmd.get("id"))
    if cmd.get("type") != "rerun":
        vercel_call("/api/agent/ack", "POST", {"id": cid})  # lệnh lạ: bỏ qua
        return True
    tries = S.agent_attempts.get(cid, 0) + 1
    S.agent_attempts[cid] = tries
    if tries > 3:
        S.log(f"Lệnh {cid} lỗi quá 3 lần, bỏ qua", "error")
        vercel_call("/api/agent/ack", "POST", {"id": cid})
        return True
    S.log(f"Nhận lệnh rerun từ Vercel ({cmd.get('source', '?')})")
    rerun(f"vercel-agent:{cid}")
    vercel_call("/api/agent/ack", "POST", {"id": cid})
    S.agent_attempts.pop(cid, None)
    return True


def agent_loop():
    while True:
        if CFG["mode"] == "vercel-agent":
            try:
                agent_poll_once()
            except Exception as e:
                with LOCK:
                    S.agent_error = str(e)
                S.log(f"Agent: {e}", "error")
        time.sleep(max(10, int(CFG["agent_poll_sec"])))


# ----------------------------------------------------------------- HTTP
def snapshot():
    with LOCK:
        r = S.runner
        return {
            "config": {k: v for k, v in CFG.items() if k not in SECRET_KEYS} | {
                "github_token_set": bool(CFG["github_token"]),
                "agent_token_set": bool(CFG.get("agent_token"))},
            "agent": {"last_poll": S.agent_last_poll, "error": S.agent_error},
            "runner": r and {"id": r["id"], "name": r["name"], "status": r["status"],
                             "busy": r["busy"], "os": r.get("os"),
                             "labels": [l["name"] for l in r.get("labels", [])]},
            "runners": [{"id": x["id"], "name": x["name"], "status": x["status"], "busy": x["busy"]}
                        for x in S.runners],
            "queued": S.queued, "in_progress": S.in_progress,
            "last_check": S.last_check, "last_error": S.last_error,
            "offline_for": int(time.time() - S.offline_since) if S.offline_since else 0,
            "last_rerun": datetime.fromtimestamp(S.last_rerun).isoformat() if S.last_rerun else None,
            "rerun_count": S.rerun_count, "driver_running": driver_running(),
            "playwright": have_playwright(), "logs": S.logs[-120:],
        }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            b = (STATIC / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(b)
        elif self.path == "/api/status":
            self._json(snapshot())
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        # chống CSRF đơn giản: chỉ nhận request từ chính origin local
        origin = self.headers.get("Origin")
        if origin and not origin.startswith((f"http://127.0.0.1:{CFG['port']}",
                                             f"http://localhost:{CFG['port']}")):
            return self._json({"error": "forbidden origin"}, 403)
        try:
            body = self._body()
            if self.path == "/api/check":
                check_status()
            elif self.path == "/api/rerun":
                rerun("manual", login=bool(body.get("login")))
            elif self.path == "/api/stop-driver":
                stop_driver()
                S.log("Đã đóng trình duyệt điều khiển Colab")
            elif self.path == "/api/open":
                webbrowser.open(CFG["colab_url"])
            elif self.path == "/api/cleanup":
                cleanup_offline()
                check_status()
            elif self.path == "/api/config":
                with LOCK:
                    for k, v in body.items():
                        if k in DEFAULT_CONFIG and not (k in SECRET_KEYS and not v):
                            if k == "mode" and v not in ("github", "vercel-agent"):
                                continue
                            CFG[k] = type(DEFAULT_CONFIG[k])(v)
                    save_config(CFG)
                S.log("Đã lưu cấu hình")
            else:
                return self._json({"error": "not found"}, 404)
            self._json(snapshot())
        except Exception as e:
            S.log(str(e), "error")
            self._json({"error": str(e)}, 500)


def main():
    for stream in (sys.stdout, sys.stderr):  # Windows: console mặc định cp1252, ép UTF-8
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if not CONFIG_PATH.exists():
        save_config(CFG)
        print(f"Đã tạo {CONFIG_PATH} – hãy điền token/target trên giao diện.")
    threading.Thread(target=watcher, daemon=True).start()
    threading.Thread(target=agent_loop, daemon=True).start()
    srv = ThreadingHTTPServer((CFG["host"], int(CFG["port"])), Handler)
    url = f"http://{CFG['host']}:{CFG['port']}"
    S.log(f"Colab Runner Monitor chạy tại {url}")
    if "--no-browser" not in sys.argv:
        threading.Timer(1, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        stop_driver()


if __name__ == "__main__":
    main()
