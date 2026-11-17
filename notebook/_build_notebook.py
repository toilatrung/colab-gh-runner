import json, sys

def md(s): return {"cell_type": "markdown", "metadata": {}, "source": s.strip("\n").splitlines(True)}
def code(s, title=None):
    meta = {"cellView": "form"} if "#@param" in s or "#@title" in s else {}
    return {"cell_type": "code", "metadata": meta, "execution_count": None, "outputs": [], "source": s.strip("\n").splitlines(True)}

cells = [
md("""
# 🚀 GitHub Self-hosted Runner trên Google Colab

Notebook này biến runtime Colab thành **self-hosted runner** cho GitHub Actions.

**Chuẩn bị (1 lần):**
1. Tạo GitHub PAT:
   - *Fine-grained*: chọn repo → quyền **Administration: Read and write** (cấp runner cho repo).
   - Hoặc *Classic*: scope `repo` (runner repo) / `admin:org` (runner org).
2. Trong Colab: biểu tượng 🔑 **Secrets** (thanh trái) → thêm secret tên `GH_PAT`, bật *Notebook access*.
3. (Tuỳ chọn) Runtime → Change runtime type → GPU.
4. (Tuỳ chọn) Giám sát qua Vercel: thêm secret `HEARTBEAT_SECRET` và điền `VERCEL_URL` ở cell Cấu hình.
   Notebook gửi heartbeat mỗi 120s; thiếu một trong hai thì bỏ qua, runner vẫn chạy bình thường.

**Chạy:** `Runtime → Run all` (Ctrl+F9). Cell cuối giữ runner chạy cho tới khi phiên Colab hết.
Webapp local (`webapp/`) sẽ phát hiện runner offline và mở lại notebook + Run all.

> ⚠️ Chỉ dùng runner này cho repo **private/tin cậy**. Không gắn self-hosted runner vào repo public nhận PR từ người lạ.
"""),
code("""
#@title ⚙️ Cấu hình
GITHUB_SCOPE = "repo"  #@param ["repo", "org"]
GITHUB_TARGET = "OWNER/REPO"  #@param {type:"string"}
RUNNER_NAME = "colab-runner"  #@param {type:"string"}
RUNNER_LABELS = "colab,linux,x64"  #@param {type:"string"}
RUNNER_GROUP = ""  #@param {type:"string"}
EPHEMERAL = False  #@param {type:"boolean"}
TOKEN_SECRET_NAME = "GH_PAT"  #@param {type:"string"}
VERCEL_URL = ""  #@param {type:"string"}
HEARTBEAT_SECRET_NAME = "HEARTBEAT_SECRET"  #@param {type:"string"}
HEARTBEAT_INTERVAL = 120  #@param {type:"integer"}

import os
GH_PAT = None
try:
    from google.colab import userdata
    GH_PAT = userdata.get(TOKEN_SECRET_NAME)
except Exception as e:
    print("Không đọc được Colab secret:", e)
if not GH_PAT:
    GH_PAT = os.environ.get("GH_PAT")
assert GH_PAT, f"Chưa có token. Thêm secret '{TOKEN_SECRET_NAME}' trong Colab (🔑)."
assert "/" in GITHUB_TARGET or GITHUB_SCOPE == "org", "GITHUB_TARGET phải dạng OWNER/REPO"

# GPU có thì tự gắn thêm nhãn 'gpu'
import shutil, subprocess
labels = [l.strip() for l in RUNNER_LABELS.split(",") if l.strip()]
if shutil.which("nvidia-smi") and subprocess.run(["nvidia-smi"], capture_output=True).returncode == 0:
    labels.append("gpu")
RUNNER_LABELS = ",".join(dict.fromkeys(labels))
RUNNER_DIR = "/content/actions-runner"

# Heartbeat (tuỳ chọn): thiếu VERCEL_URL hoặc secret thì bỏ qua, runner vẫn chạy bình thường
HEARTBEAT_SECRET = None
try:
    from google.colab import userdata as _ud
    HEARTBEAT_SECRET = _ud.get(HEARTBEAT_SECRET_NAME)
except Exception:
    pass
HEARTBEAT_SECRET = HEARTBEAT_SECRET or os.environ.get("HEARTBEAT_SECRET")
VERCEL_URL = (VERCEL_URL or "").strip().rstrip("/")
if VERCEL_URL and not VERCEL_URL.startswith("http"):
    VERCEL_URL = "https://" + VERCEL_URL
if VERCEL_URL and HEARTBEAT_SECRET:
    print("Heartbeat: BẬT ->", VERCEL_URL, f"(mỗi {HEARTBEAT_INTERVAL}s)")
else:
    print("Heartbeat: TẮT (cần điền VERCEL_URL và thêm Colab Secret", HEARTBEAT_SECRET_NAME + ")")
print("Target:", GITHUB_SCOPE, GITHUB_TARGET, "| Runner:", RUNNER_NAME, "| Labels:", RUNNER_LABELS)
"""),
code("""
#@title 📦 Tải & cài GitHub Actions runner (bản mới nhất)
import json, urllib.request, os, subprocess, tarfile

def gh_api(path, method="GET", data=None):
    req = urllib.request.Request("https://api.github.com" + path, method=method,
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Authorization": f"Bearer {GH_PAT}", "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "colab-runner"})
    with urllib.request.urlopen(req) as r:
        body = r.read()
        return json.loads(body) if body else {}

rel = gh_api("/repos/actions/runner/releases/latest")
version = rel["tag_name"].lstrip("v")
url = f"https://github.com/actions/runner/releases/download/v{version}/actions-runner-linux-x64-{version}.tar.gz"
os.makedirs(RUNNER_DIR, exist_ok=True)
tgz = f"/content/runner-{version}.tgz"
if not os.path.exists(os.path.join(RUNNER_DIR, "config.sh")):
    print("Tải runner", version)
    urllib.request.urlretrieve(url, tgz)
    with tarfile.open(tgz) as t:
        t.extractall(RUNNER_DIR)
    subprocess.run(["bash", "bin/installdependencies.sh"], cwd=RUNNER_DIR, check=False,
                   stdout=subprocess.DEVNULL)
print("✅ Runner", version, "đã sẵn sàng tại", RUNNER_DIR)
"""),
code("""
#@title 🔐 Đăng ký runner với GitHub
import subprocess, os
base = f"/repos/{GITHUB_TARGET}" if GITHUB_SCOPE == "repo" else f"/orgs/{GITHUB_TARGET}"
html_url = f"https://github.com/{GITHUB_TARGET}"

# Xoá runner offline cùng tên (phiên Colab trước) để tránh trùng
try:
    for r in gh_api(f"{base}/actions/runners?per_page=100").get("runners", []):
        if r["name"] == RUNNER_NAME and r["status"] == "offline":
            gh_api(f"{base}/actions/runners/{r['id']}", method="DELETE")
            print("Đã xoá runner offline cũ id", r["id"])
except Exception as e:
    print("Bỏ qua dọn runner cũ:", e)

reg_token = gh_api(f"{base}/actions/runners/registration-token", method="POST")["token"]
env = dict(os.environ, RUNNER_ALLOW_RUNASROOT="1")
if os.path.exists(os.path.join(RUNNER_DIR, ".runner")):
    os.remove(os.path.join(RUNNER_DIR, ".runner"))  # cấu hình lại sạch mỗi phiên
cmd = ["./config.sh", "--unattended", "--replace", "--url", html_url, "--token", reg_token,
       "--name", RUNNER_NAME, "--labels", RUNNER_LABELS, "--work", "_work"]
if EPHEMERAL: cmd.append("--ephemeral")
if RUNNER_GROUP and GITHUB_SCOPE == "org": cmd += ["--runnergroup", RUNNER_GROUP]
p = subprocess.run(cmd, cwd=RUNNER_DIR, env=env, capture_output=True, text=True)
print(p.stdout[-2000:], p.stderr[-2000:])
assert p.returncode == 0, "config.sh thất bại – kiểm tra quyền của PAT"
print("✅ Đã đăng ký", RUNNER_NAME)
"""),
code(r"""
#@title 💓 Heartbeat → Vercel (luồng nền, tuỳ chọn)
import collections, json, os, re, shutil, subprocess, threading, time, urllib.request, uuid

# Trạng thái chia sẻ với cell "Chạy runner"
RUNNER = globals().get("RUNNER") or {"proc": None}
JOB = globals().get("JOB") or {"busy": False, "name": None}
RUNNER_LOG = globals().get("RUNNER_LOG") or collections.deque(maxlen=200)
SESSION_ID = globals().get("SESSION_ID") or uuid.uuid4().hex     # 1 lần mỗi phiên
NOTEBOOK_START = globals().get("NOTEBOOK_START") or time.time()
SESSION_LIMIT_SEC = 12 * 3600                                     # Colab free ~12h/phiên
_HB = globals().get("_HB") or {"stop": threading.Event(), "thread": None, "stopped_sent": False,
                               "cpu_prev": None, "fails": 0}

_RE_START = re.compile(r"Running job:\s*(.+?)\s*$")
_RE_DONE = re.compile(r"Job\s+(.+?)\s+completed with result")

def hb_track_line(line):
    # Gọi cho mỗi dòng log của runner: lưu log và theo dõi job đang chạy
    try:
        RUNNER_LOG.append(line.rstrip())
        m = _RE_START.search(line)
        if m:
            JOB["busy"], JOB["name"] = True, m.group(1)
            return
        if _RE_DONE.search(line):
            JOB["busy"], JOB["name"] = False, None
    except Exception:
        pass

def _runner_state():
    proc = RUNNER.get("proc")
    if proc is not None:
        return "running" if proc.poll() is None else "exited"
    try:
        r = subprocess.run(["pgrep", "-f", "Runner.Listener"], capture_output=True, timeout=3)
        return "running" if r.returncode == 0 else "stopped"
    except Exception:
        return "stopped"

def _cpu_percent():
    try:
        with open("/proc/stat") as f:
            v = [int(x) for x in f.readline().split()[1:]]
        idle, total = v[3] + (v[4] if len(v) > 4 else 0), sum(v)
        prev, _HB["cpu_prev"] = _HB["cpu_prev"], (idle, total)
        if not prev or total == prev[1]:
            return None
        return round(100.0 * (1 - (idle - prev[0]) / (total - prev[1])), 1)
    except Exception:
        return None

def _mem_percent():
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for ln in f:
                k, v = ln.split(":")
                info[k] = int(v.split()[0])
        return round(100.0 * (1 - info["MemAvailable"] / info["MemTotal"]), 1)
    except Exception:
        return None

def _disk_percent():
    try:
        u = shutil.disk_usage("/content")
        return round(100.0 * u.used / u.total, 1)
    except Exception:
        return None

def _gpus():
    if not shutil.which("nvidia-smi"):
        return []
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
                              "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5).stdout
        res = []
        for ln in out.strip().splitlines():
            p = [x.strip() for x in ln.split(",")]
            res.append({"name": p[0], "util": float(p[1]), "mem_used_mb": float(p[2]),
                        "mem_total_mb": float(p[3]), "temp_c": float(p[4])})
        return res
    except Exception:
        return []

def hb_payload(event="beat"):
    up = time.time() - NOTEBOOK_START
    return {"session_id": SESSION_ID, "event": event, "runner_name": RUNNER_NAME,
            "runner_state": _runner_state(), "runner_busy": bool(JOB["busy"]), "current_job": JOB["name"],
            "session_uptime_sec": int(up), "session_remaining_est_sec": int(max(0, SESSION_LIMIT_SEC - up)),
            "cpu": _cpu_percent(), "mem": _mem_percent(), "disk": _disk_percent(), "gpus": _gpus()}

def send_heartbeat(event="beat"):
    # Không bao giờ ném lỗi, không bao giờ in secret
    if not (VERCEL_URL and HEARTBEAT_SECRET):
        return False
    try:
        data = json.dumps(hb_payload(event)).encode()
        req = urllib.request.Request(VERCEL_URL + "/api/heartbeat", data=data, method="POST",
            headers={"Authorization": "Bearer " + HEARTBEAT_SECRET, "Content-Type": "application/json",
                     "User-Agent": "colab-runner-heartbeat"})
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read()
        if _HB["fails"]:
            print(f"[heartbeat] đã gửi lại được sau {_HB['fails']} lần lỗi")
        _HB["fails"] = 0
        return True
    except Exception as e:
        _HB["fails"] += 1
        if _HB["fails"] in (1, 5) or _HB["fails"] % 30 == 0:
            print(f"[heartbeat] lỗi ({_HB['fails']}): {type(e).__name__}")
        return False

def _hb_loop():
    while not _HB["stop"].is_set():
        try:
            send_heartbeat("beat")
        except Exception:
            pass
        _HB["stop"].wait(max(10, int(HEARTBEAT_INTERVAL)))

def hb_stop():
    # Gửi 'stopping' (một lần) rồi dừng luồng heartbeat
    try:
        if not _HB["stopped_sent"]:
            _HB["stopped_sent"] = True
            send_heartbeat("stopping")
    finally:
        _HB["stop"].set()

if VERCEL_URL and HEARTBEAT_SECRET:
    if _HB["thread"] is None or not _HB["thread"].is_alive():
        _HB["stop"].clear()
        _HB["stopped_sent"] = False
        send_heartbeat("start")
        t = threading.Thread(target=_hb_loop, name="heartbeat", daemon=True)
        _HB["thread"] = t
        t.start()
        print("💓 Heartbeat đã chạy | phiên", SESSION_ID[:8])
    else:
        print("💓 Heartbeat đang chạy sẵn")
else:
    print("Heartbeat tắt – bỏ qua.")
"""),
code("""
#@title ▶️ Chạy runner (giữ cell này chạy)
import subprocess, threading, time, os, signal, datetime, json

# Chia sẻ trạng thái với luồng heartbeat (nếu cell heartbeat chưa chạy thì là no-op)
RUNNER = globals().setdefault("RUNNER", {"proc": None})
_track = globals().get("hb_track_line", lambda line: None)
_hb_stop = globals().get("hb_stop", lambda: None)

STATUS_FILE = "/content/runner_status.json"
def write_status(state):
    with open(STATUS_FILE, "w") as f:
        json.dump({"state": state, "time": datetime.datetime.now(datetime.timezone.utc).isoformat()}, f)

def remove_runner():
    try:
        tok = gh_api(f"{base}/actions/runners/remove-token", method="POST")["token"]
        subprocess.run(["./config.sh", "remove", "--token", tok], cwd=RUNNER_DIR, env=env,
                       capture_output=True)
        print("🧹 Đã gỡ runner khỏi GitHub")
    except Exception as e:
        print("Không gỡ được runner:", e)

def run_once():
    proc = subprocess.Popen(["./run.sh"], cwd=RUNNER_DIR, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1, preexec_fn=os.setsid)
    RUNNER["proc"] = proc
    for line in proc.stdout:
        print(line, end="")
        _track(line)
    return proc.wait()

write_status("running")
started = time.time()
try:
    while True:
        rc = run_once()
        print(f"[{datetime.datetime.now():%H:%M:%S}] runner thoát rc={rc}")
        if EPHEMERAL:
            break  # ephemeral: mỗi phiên 1 job, webapp sẽ chạy lại
        time.sleep(5)  # tự khởi động lại nếu runner tự thoát (update, lỗi mạng...)
except KeyboardInterrupt:
    print("⏹ Dừng bởi người dùng")
    _hb_stop()  # báo 'stopping' trước khi gỡ runner
    remove_runner()
finally:
    _hb_stop()  # no-op nếu đã gửi; dừng luồng heartbeat khi runner kết thúc (vd. ephemeral)
    write_status("stopped")
    print("Thời gian chạy: %.1f phút" % ((time.time() - started) / 60))
"""),
md("""
### Ghi chú
- Colab free giới hạn ~12 giờ/phiên và ngắt khi tab nhàn rỗi lâu → dùng **webapp local** để tự mở lại và Run all.
- Workflow chỉ định runner bằng: `runs-on: [self-hosted, colab]` (thêm `gpu` nếu cần GPU).
- Dọn tay: chạy cell dưới để gỡ runner khỏi GitHub.
"""),
code("""
#@title 🧹 (Tuỳ chọn) Gỡ runner khỏi GitHub
remove_runner()
"""),
]

nb = {"nbformat": 4, "nbformat_minor": 0,
      "metadata": {"colab": {"provenance": [], "name": "colab_github_runner.ipynb"},
                   "kernelspec": {"name": "python3", "display_name": "Python 3"},
                   "language_info": {"name": "python"}, "accelerator": "GPU"},
      "cells": cells}
with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as f:
    json.dump(nb, f, ensure_ascii=False, indent=1)
