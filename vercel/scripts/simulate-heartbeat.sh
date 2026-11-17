#!/usr/bin/env bash
# Giả lập Colab: gửi heartbeat mỗi INTERVAL giây trong BEATS lần rồi NGỪNG.
# Sau đó gọi /api/check định kỳ để quan sát cảnh báo Telegram.
#
# Dùng:
#   BASE_URL=http://localhost:3000 HEARTBEAT_SECRET=xxx CHECK_SECRET=yyy ./simulate-heartbeat.sh
# Tuỳ chọn: BEATS=5 INTERVAL=5 WAIT_AFTER=420 (giây theo dõi sau khi ngừng; STALE_AFTER_SEC nên đặt nhỏ, vd 30)
set -u
BASE_URL="${BASE_URL:-http://localhost:3000}"
BEATS="${BEATS:-5}"
INTERVAL="${INTERVAL:-5}"
WAIT_AFTER="${WAIT_AFTER:-120}"
SID="sim-$(date +%s)"
: "${HEARTBEAT_SECRET:?Cần HEARTBEAT_SECRET}"
: "${CHECK_SECRET:?Cần CHECK_SECRET}"

post() {
  curl -sS -X POST "$BASE_URL/api/heartbeat" -H "Authorization: Bearer $HEARTBEAT_SECRET" \
    -H 'Content-Type: application/json' -d "$1"
  echo
}

echo "== Phiên giả lập $SID: gửi $BEATS heartbeat mỗi ${INTERVAL}s =="
for i in $(seq 1 "$BEATS"); do
  ev=beat; [ "$i" = 1 ] && ev=start
  post "{\"session_id\":\"$SID\",\"event\":\"$ev\",\"runner_name\":\"colab-runner\",\"runner_state\":\"running\",\"runner_busy\":false,\"session_uptime_sec\":$((i*INTERVAL)),\"session_remaining_est_sec\":43000,\"cpu\":$((RANDOM%60)),\"mem\":$((20+RANDOM%40)),\"disk\":12,\"gpus\":[{\"name\":\"T4\",\"util\":$((RANDOM%90)),\"mem_used_mb\":2048,\"mem_total_mb\":15360}]}"
  sleep "$INTERVAL"
done

echo "== NGỪNG gửi heartbeat. Theo dõi /api/check trong ${WAIT_AFTER}s (cron-job.org thật thì không cần) =="
end=$(( $(date +%s) + WAIT_AFTER ))
while [ "$(date +%s)" -lt "$end" ]; do
  curl -sS "$BASE_URL/api/check?key=$CHECK_SECRET"; echo
  sleep 15
done
echo "== Xong. Gửi lại 1 heartbeat để thử cảnh báo 'online lại' =="
post "{\"session_id\":\"$SID-2\",\"event\":\"start\",\"runner_state\":\"running\"}"
