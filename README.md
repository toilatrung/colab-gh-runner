# Colab GitHub Runner

Dùng runtime Google Colab (CPU/GPU miễn phí) làm **self-hosted runner** cho GitHub Actions. Một webapp nhỏ chạy trên máy của bạn sẽ tự khởi động lại phiên Colab khi phiên cũ hết hạn.

```
 ┌──────────────── Máy local ────────────────┐        ┌────────── Google Colab ──────────┐
 │ webapp/server.py  (http://127.0.0.1:8765) │        │ notebook/colab_github_runner     │
 │  ├─ poll GitHub API: runner online?  ─────┼──┐     │  ├─ tải actions/runner mới nhất   │
 │  ├─ có job queued?                        │  │     │  ├─ đăng ký runner (--replace)    │
 │  └─ offline → colab_driver.py (Playwright)│  │     │  └─ ./run.sh  ◄── nhận job CI     │
 │        mở Colab + Run all ────────────────┼──┼────►│                                   │
 └───────────────────────────────────────────┘  │     └──────────────▲────────────────────┘
                                                ▼                    │ long-poll
                                        ┌───────────────┐            │
                                        │  GitHub API   │◄───────────┘
                                        └───────────────┘
```

### Kiến trúc giám sát mới (Vercel + Telegram)

Colab không có API khởi động phiên, nên khi phiên chết thì không tự báo được. Phần `vercel/` thêm giám sát online: notebook gửi heartbeat, bộ đếm giờ ngoài gọi `/api/check`, và bạn nhận cảnh báo Telegram để bấm chạy lại.

```
Colab notebook ──POST heartbeat mỗi 120s──► Vercel /api/heartbeat ──► Upstash Redis
cron-job.org ──GET mỗi 1 phút──► Vercel /api/check ──(stale/khôi phục)──► Telegram Bot
Điện thoại/PC ──► Vercel dashboard (mật khẩu)       Telegram ──webhook──► /api/telegram (/status …)
(tuỳ chọn) webapp local ──poll /api/agent/next──► Playwright Run all
```

Hướng dẫn từng bước (BotFather, chat_id, deploy, Upstash, env vars, webhook, cron-job.org, Colab Secret) nằm trong [`vercel/README.md`](vercel/README.md). Heartbeat là tuỳ chọn: thiếu `VERCEL_URL` hoặc secret `HEARTBEAT_SECRET` thì notebook chạy như cũ.

Toàn bộ job CI chạy trên máy của Google. Trình duyệt trên máy bạn chỉ làm hai việc: bấm **Run all** và giữ tab mở (Colab cần tab mở thì mới không bị ngắt vì nhàn rỗi). Google không có API công khai để khởi động một phiên Colab, nên đây là cách duy nhất để rerun tự động.

## Cấu trúc

| Đường dẫn | Mô tả |
|---|---|
| `notebook/colab_github_runner.ipynb` | Notebook chép vào repo, ví dụ `colab/colab_github_runner.ipynb` |
| `examples/.github/workflows/ci-colab.yml` | Workflow mẫu, `runs-on: [self-hosted, colab]` |
| `webapp/server.py` | Server và giao diện giám sát, chỉ dùng thư viện chuẩn của Python |
| `webapp/colab_driver.py` | Dùng Playwright mở Colab rồi Run all |
| `webapp/start.sh`, `start.bat` | Tạo venv, cài Playwright rồi chạy webapp |
| `vercel/` | Monitor trên Vercel: heartbeat, `/api/check`, cảnh báo Telegram, dashboard (xem `vercel/README.md`) |
| `.github/workflows/colab-watchdog.yml` | Dự phòng gọi `/api/check` mỗi 10 phút nếu chưa dùng cron-job.org |
| `notebook/_build_notebook.py` | Sinh notebook: `python _build_notebook.py colab_github_runner.ipynb` |

## Cài đặt

### 1. GitHub token (PAT)
- **Fine-grained** (nên dùng): Repository access chọn repo cần chạy CI; Permissions đặt **Administration: Read and write** và **Actions: Read**.
- **Classic**: scope `repo` cho runner của repo, hoặc `admin:org` cho runner của org.

Webapp và notebook có thể dùng chung token này.

### 2. Thêm notebook vào dự án
```bash
mkdir -p colab .github/workflows
cp notebook/colab_github_runner.ipynb colab/
cp examples/.github/workflows/ci-colab.yml .github/workflows/
git add colab .github && git commit -m "CI: Colab self-hosted runner" && git push
```
URL mở notebook trực tiếp từ GitHub:
`https://colab.research.google.com/github/OWNER/REPO/blob/main/colab/colab_github_runner.ipynb`

Với repo private, lần đầu Colab sẽ xin quyền truy cập GitHub. Cách khác: lưu notebook vào Google Drive và dùng URL `https://colab.research.google.com/drive/<id>`.

### 3. Chạy notebook lần đầu (làm tay)
1. Mở notebook. Trong 🔑 **Secrets**, thêm `GH_PAT` = token và bật **Notebook access**.
2. Ở cell **Cấu hình**, đặt `GITHUB_TARGET = OWNER/REPO`. Giữ `RUNNER_NAME` trùng với tên trong webapp.
3. Bấm Runtime → Run all. Vào trang Settings → Actions → Runners của repo, runner `colab-runner` phải hiện **Idle**.

> Nếu bạn muốn notebook mở từ GitHub không phải sửa form, hãy commit sẵn giá trị `GITHUB_TARGET` vào notebook. Token luôn nằm trong Colab Secrets, không bao giờ commit.

### 4. Chạy webapp local
```bash
cd webapp
./start.sh          # Windows: start.bat
# hoặc: python server.py   (không có Playwright thì rerun = mở tab cho bạn tự bấm)
```
Mở http://127.0.0.1:8765, rồi:
1. Điền token, target, tên runner và URL notebook, sau đó bấm **Lưu cấu hình**.
2. Bấm **Đăng nhập Google**, đăng nhập Google trong cửa sổ vừa mở rồi đóng nó lại. Phiên đăng nhập được lưu trong `webapp/.colab-profile/`.
3. Bật **Tự động rerun**.

## Cơ chế tự động rerun
Cứ mỗi `poll_interval_sec` giây, webapp gọi `GET /repos/{owner}/{repo}/actions/runners` để xem runner có tên `runner_name`:

- `online`: phiên Colab còn sống.
- `offline` hoặc không tìm thấy liên tục quá `offline_grace_sec`: webapp chạy lại notebook. Bước này còn bị giới hạn bởi `rerun_cooldown_sec` (tránh rerun dồn dập trong lúc notebook đang cài đặt). Nếu bật `only_when_queued`, webapp chỉ rerun khi có workflow run đang `queued`, giúp tiết kiệm quota GPU.

Khi rerun, `colab_driver.py` mở Colab bằng profile đã đăng nhập, bấm Ctrl+F9 rồi tự bấm các hộp thoại như *Run anyway* hay *Connect without GPU*. Sau đó nó giữ tab mở và cứ vài phút cuộn trang một lần để tránh bị ngắt vì nhàn rỗi.

Notebook đăng ký runner với `--replace` và tự xoá runner offline cùng tên, nên mỗi phiên mới dùng lại đúng tên cũ. Nếu `run.sh` thoát (do cập nhật hoặc lỗi mạng), cell cuối của notebook tự khởi động lại nó.

## Mode `vercel-agent` (webapp nhận lệnh từ Vercel)
Mặc định webapp ở mode `github` (poll GitHub như trên). Đặt `mode: "vercel-agent"`, `vercel_url` và `agent_token` (trùng `AGENT_TOKEN` trên Vercel), hoặc điền trong giao diện. Khi đó webapp poll `GET /api/agent/next` mỗi `agent_poll_sec` (30s). Khi Vercel phát hiện runner chết (hoặc bạn gõ `/rerun` trong Telegram, bấm Rerun trên dashboard) thì webapp chạy `colab_driver.py` như cũ rồi gọi `POST /api/agent/ack`. Chỉ dùng thư viện chuẩn của Python. Token cũng có thể đặt qua biến môi trường `AGENT_TOKEN`.

Rerun tự động chỉ xảy ra khi webapp local đang bật. Nếu không, bạn bấm link Mở Colab trong Telegram rồi chạy Run all.

## Cấu hình (`webapp/config.json`)
| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `scope` / `target` | `repo` / `OWNER/REPO` | Runner cấp repo hoặc org |
| `runner_name` | `colab-runner` | Phải trùng `RUNNER_NAME` trong notebook |
| `rerun_mode` | `playwright` | `browser` = chỉ mở tab |
| `browser_channel` | `chrome` | `chrome` / `msedge` / `""` (Chromium đi kèm Playwright) |
| `poll_interval_sec` | 60 | Chu kỳ gọi GitHub API |
| `offline_grace_sec` | 180 | Runner offline bao lâu thì rerun |
| `rerun_cooldown_sec` | 600 | Khoảng cách tối thiểu giữa 2 lần rerun |
| `only_when_queued` | false | Chỉ rerun khi có job đang chờ |
| `mode` | `github` | `github` hoặc `vercel-agent` |
| `vercel_url` / `agent_token` | rỗng | Dùng ở mode `vercel-agent` |
| `agent_poll_sec` | 30 | Chu kỳ poll `/api/agent/next` |

Biến môi trường `GH_PAT`, nếu có, sẽ ghi đè `github_token`.

## Giới hạn và lưu ý
- Không có API khởi động Colab ⇒ rerun tự động chỉ có khi webapp local đang bật; nếu không thì bấm link trong Telegram.
- Colab free: một phiên tối đa khoảng 12 giờ, bị ngắt khi nhàn rỗi (đóng tab), GPU có quota. Job dài hơn thời gian còn lại của phiên sẽ bị cắt ngang, nên đặt `timeout-minutes` cho job.
- Không có ổ đĩa lưu lâu dài: mỗi phiên là một máy mới. Muốn cache thì dùng `actions/cache` hoặc mount Google Drive.
- Giao diện Colab có thể thay đổi. Nếu tự động Run all không còn ăn, chuyển `rerun_mode` sang `browser` hoặc sửa selector trong `colab_driver.py`.
- Google có thể chặn đăng nhập trên Chromium điều khiển tự động. Khi đó dùng `browser_channel: "chrome"` (cần cài Chrome thật).
- Điều khoản sử dụng của Colab hạn chế việc dùng runtime ngoài mục đích notebook tương tác (ví dụ chạy dịch vụ nền lâu dài). Hãy tự cân nhắc rủi ro bị giới hạn tài khoản, hoặc dùng Colab Pro hay Colab Enterprise.
- **Bảo mật:** chỉ gắn runner này cho repo private hoặc tin cậy. Không dùng cho repo public nhận PR từ fork. Webapp chỉ lắng nghe trên `127.0.0.1`.
