# Vercel monitor cho Colab runner

Giám sát runner Colab từ xa: notebook gửi **heartbeat**, Vercel lưu vào **Upstash Redis**, một bộ đếm giờ bên ngoài gọi `/api/check` mỗi phút. Khi runner chết bạn nhận **cảnh báo Telegram** có nút mở Colab.

```
Colab notebook ──POST heartbeat mỗi 120s──► /api/heartbeat ──► Upstash Redis
cron-job.org ──GET mỗi 1 phút──► /api/check ──(chết / hồi phục / sắp hết phiên)──► Telegram Bot
Điện thoại/PC ──► Dashboard (mật khẩu)        Telegram ──webhook──► /api/telegram  (/status /rerun …)
(tuỳ chọn) webapp local ──poll /api/agent/next──► Playwright "Run all"
```

Không dùng framework: Vercel Node.js Serverless Functions (`api/*.js`, ESM) + `public/index.html` tĩnh. Dependency duy nhất là `@upstash/redis`.

## Các bước cài đặt

### 1. Tạo bot Telegram
1. Chat với **@BotFather** → `/newbot` → đặt tên → nhận **token** (`TELEGRAM_BOT_TOKEN`).
2. Mở bot vừa tạo trong Telegram và bấm **Start** (bot chỉ nhắn được cho người đã bắt đầu chat).

### 2. Lấy `chat_id`
- Cách 1: chat với **@userinfobot**, nó trả về `Id: 123456789`.
- Cách 2: gửi một tin cho bot của bạn rồi mở `https://api.telegram.org/bot<TOKEN>/getUpdates` và lấy `message.chat.id`.

Đó là `TELEGRAM_CHAT_ID`. Bot chỉ trả lời đúng chat này.

### 3. Chuẩn bị các bí mật
Tạo 5 chuỗi ngẫu nhiên (PowerShell: `-join ((48..57+97..122) | Get-Random -Count 32 | % {[char]$_})`, hoặc `openssl rand -hex 24`):
`HEARTBEAT_SECRET`, `CHECK_SECRET`, `AGENT_TOKEN`, `SESSION_SECRET`, `TELEGRAM_WEBHOOK_SECRET` (chỉ gồm `A-Za-z0-9_-`), cộng `DASHBOARD_PASSWORD` do bạn chọn. Xem `.env.example`.

### 4. Deploy lên Vercel
**Cách A – CLI**
```bash
npm i -g vercel
cd vercel
npm install
vercel            # lần đầu: đăng nhập, tạo project
vercel --prod
```
**Cách B – import repo**: Vercel → *Add New → Project* → chọn repo → **Root Directory = `vercel`** → Deploy.

### 5. Thêm Upstash Redis
Vercel → project → **Storage / Marketplace → Upstash (Redis)** → tạo database → *Connect to Project*. Vercel tự thêm `KV_REST_API_URL` và `KV_REST_API_TOKEN` (hoặc `UPSTASH_REDIS_REST_*`, code đọc cả hai).

### 6. Đặt biến môi trường
Project → Settings → Environment Variables (Production), theo `.env.example`:

| Biến | Ý nghĩa |
|---|---|
| `HEARTBEAT_SECRET` | Colab → `/api/heartbeat` |
| `CHECK_SECRET` | cron-job.org → `/api/check` |
| `AGENT_TOKEN` | webapp local → `/api/agent/*` |
| `DASHBOARD_PASSWORD`, `SESSION_SECRET` | đăng nhập dashboard, ký cookie |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` | Telegram |
| `GITHUB_TOKEN`, `GITHUB_REPO` (`toilatrung/nutrimeal`), `RUNNER_NAME` (`colab-runner`) | đối chiếu runner trên GitHub (PAT: Administration RW + Actions R) |
| `COLAB_URL` | link notebook, dùng cho nút **Mở Colab** |
| `STALE_AFTER_SEC` (300), `ALERT_REPEAT_SEC` (1800) | ngưỡng mất heartbeat, chu kỳ nhắc lại |
| `PUBLIC_URL` (tuỳ chọn) | URL app, dùng cho nút **Dashboard** (mặc định lấy domain Vercel) |

Sau khi thêm/sửa biến cần **Redeploy**.

### 7. Đăng ký webhook Telegram
Mở một lần trên trình duyệt:
```
https://<app>.vercel.app/api/setup-webhook?key=<CHECK_SECRET>
```
Kết quả `{"ok":true,...}`. Thử gửi `/status` cho bot.

### 8. Tạo job trên cron-job.org
- URL: `https://<app>.vercel.app/api/check?key=<CHECK_SECRET>`
- Lịch: **mỗi 1 phút**, method GET. (Cron của Vercel gói Hobby chỉ chạy mỗi ngày nên phải dùng dịch vụ ngoài.)
- Dự phòng: `.github/workflows/colab-watchdog.yml` gọi `/api/check` mỗi 10 phút. Thêm Repository secrets `CHECK_SECRET` và `VERCEL_APP_URL`. **Lưu ý:** `schedule` của GitHub có thể trễ vài phút hoặc bị bỏ qua khi tải cao, nên chỉ để dự phòng.

### 9. Cấu hình Colab
1. Colab → 🔑 **Secrets** → thêm `HEARTBEAT_SECRET` (cùng giá trị trên Vercel), bật *Notebook access*.
2. Ở cell **Cấu hình** của notebook, điền `VERCEL_URL = https://<app>.vercel.app`.
3. Run all. Telegram báo "🚀 Phiên Colab mới đã khởi động". Thiếu `VERCEL_URL` hoặc secret thì heartbeat tự tắt, runner vẫn chạy như cũ.

## Thử cục bộ
```bash
npm install
npm test                         # các test: state machine /api/check, auth, endpoint
vercel dev                       # hoặc: node scripts/dev-server.mjs  (không cần tài khoản Vercel)
```
Không có Redis thì dùng bộ nhớ trong (chỉ để thử). Giả lập Colab gửi heartbeat rồi ngừng:
```bash
STALE_AFTER_SEC=30 vercel dev    # terminal 1 (đặt các biến trong .env)
HEARTBEAT_SECRET=... CHECK_SECRET=... ./scripts/simulate-heartbeat.sh        # terminal 2
```
PowerShell: `$env:HEARTBEAT_SECRET="..."; $env:CHECK_SECRET="..."; .\scripts\simulate-heartbeat.ps1`

## Hành vi cảnh báo
- **Chết**: `now − heartbeat cuối > STALE_AFTER_SEC`, hoặc notebook gửi `stopping`. Gửi 🔴 kèm lý do, trạng thái runner trên GitHub, số job đang chờ và nút [Mở Colab] [Dashboard] [Tắt báo 1h]; đồng thời đẩy lệnh `rerun` vào hàng đợi agent.
- **Nhắc lại** mỗi `ALERT_REPEAT_SEC` khi vẫn chết; bỏ qua khi đang tắt báo (mute). Hết mute thì báo tiếp.
- **Hồi phục**: heartbeat mới → ✅ "Runner đã online lại" và xoá lệnh rerun đang chờ.
- **Sắp hết phiên**: còn dưới 15 phút → ⏳ một lần cho mỗi phiên.
- `/api/check` idempotent: gọi trùng không gửi tin trùng (state lưu trước khi gửi, thêm khoá 25 giây chống gọi đồng thời). Nếu Telegram lỗi, lần check kế tiếp gửi lại.

Lệnh Telegram: `/status`, `/rerun`, `/mute [phút]`, `/unmute`, `/cleanup`.

## Endpoints
| Endpoint | Xác thực | Mô tả |
|---|---|---|
| `POST /api/heartbeat` | Bearer `HEARTBEAT_SECRET` | body ≤ 16KB |
| `GET/POST /api/check` | `?key=` / `x-check-key` / Bearer `CHECK_SECRET` | state machine + cảnh báo |
| `POST /api/telegram` | header `X-Telegram-Bot-Api-Secret-Token` | webhook |
| `GET /api/setup-webhook` | `?key=CHECK_SECRET` | gọi `setWebhook` |
| `POST /api/login`, `/api/logout` | mật khẩu | cookie HttpOnly, Secure, SameSite=Strict, HMAC, 7 ngày |
| `GET /api/status`, `POST /api/cleanup`, `/api/rerun`, `/api/mute` | cookie | dashboard |
| `GET /api/agent/next`, `POST /api/agent/ack` | Bearer `AGENT_TOKEN` | webapp local lấy lệnh rerun |

Bảo mật: so sánh secret constant-time, không trả token về client, lỗi xác thực luôn là `401 unauthorized`, login giới hạn 10 lần/10 phút/IP.

## Giới hạn
- **Không có API khởi động Colab.** Rerun tự động chỉ xảy ra khi **webapp local đang bật** ở mode `vercel-agent` (nó poll `/api/agent/next` rồi dùng Playwright bấm Run all). Nếu không thì bạn bấm nút/link **Mở Colab** trong Telegram rồi chạy Run all.
- Colab free ~12 giờ/phiên và có idle timeout khi đóng tab; "thời gian còn lại" trên dashboard chỉ là ước tính (12h − thời gian từ lúc chạy notebook).
- Hobby plan của Vercel không có cron mỗi phút, nên cần cron-job.org.
- Mất heartbeat vì mạng của Colab cũng bị coi là "chết"; cảnh báo có ghi chú nếu GitHub vẫn thấy runner online.
