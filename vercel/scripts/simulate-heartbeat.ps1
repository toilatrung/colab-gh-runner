# Giả lập Colab: gửi heartbeat rồi NGỪNG, sau đó gọi /api/check để quan sát cảnh báo Telegram.
# Dùng (PowerShell):
#   $env:HEARTBEAT_SECRET="xxx"; $env:CHECK_SECRET="yyy"
#   .\simulate-heartbeat.ps1 -BaseUrl http://localhost:3000 -Beats 5 -Interval 5 -WaitAfter 120
# Gợi ý: đặt STALE_AFTER_SEC=30 trong .env để thấy cảnh báo nhanh.
param(
  [string]$BaseUrl = $(if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }),
  [int]$Beats = 5,
  [int]$Interval = 5,
  [int]$WaitAfter = 120
)
if (-not $env:HEARTBEAT_SECRET -or -not $env:CHECK_SECRET) { throw 'Cần đặt $env:HEARTBEAT_SECRET và $env:CHECK_SECRET' }
$sid = "sim-$([int][double]::Parse((Get-Date -UFormat %s)))"

function Send-Beat($obj) {
  try {
    Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/heartbeat" -ContentType 'application/json' `
      -Headers @{ Authorization = "Bearer $($env:HEARTBEAT_SECRET)" } -Body ($obj | ConvertTo-Json -Depth 5) | ConvertTo-Json -Compress
  } catch { "LỖI: $($_.Exception.Message)" }
}

"== Phiên giả lập $sid : gửi $Beats heartbeat mỗi ${Interval}s =="
for ($i = 1; $i -le $Beats; $i++) {
  Send-Beat @{
    session_id = $sid; event = $(if ($i -eq 1) { 'start' } else { 'beat' })
    runner_name = 'colab-runner'; runner_state = 'running'; runner_busy = $false
    session_uptime_sec = $i * $Interval; session_remaining_est_sec = 43000
    cpu = Get-Random -Max 60; mem = 20 + (Get-Random -Max 40); disk = 12
    gpus = @(@{ name = 'T4'; util = (Get-Random -Max 90); mem_used_mb = 2048; mem_total_mb = 15360 })
  }
  Start-Sleep -Seconds $Interval
}

"== NGỪNG gửi heartbeat. Theo dõi /api/check trong ${WaitAfter}s =="
$end = (Get-Date).AddSeconds($WaitAfter)
while ((Get-Date) -lt $end) {
  try { Invoke-RestMethod "$BaseUrl/api/check?key=$($env:CHECK_SECRET)" | ConvertTo-Json -Compress } catch { "LỖI: $($_.Exception.Message)" }
  Start-Sleep -Seconds 15
}
"== Gửi lại 1 heartbeat để thử cảnh báo 'online lại' =="
Send-Beat @{ session_id = "$sid-2"; event = 'start'; runner_state = 'running' }
