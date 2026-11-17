/**
 * Logic lõi (thuần, nhận deps để dễ test):
 *   deps = { cfg, store, telegram, github, now: () => ms }
 */
import { escapeHtml as esc, fmtDuration, fmtTime } from './util.js';

const RERUN_TTL_MS = 3600 * 1000;
const CHECK_LOCK_SEC = 25;

export const newState = (now) => ({
  status: 'unknown', // alive | dead | unknown
  since: now,
  last_alert_at: 0,
  alert_count: 0,
  muted_until: 0,
  early_warned_session: null,
});

/* ------------------------------------------------------------------ heartbeat */
const str = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Lọc/giới hạn dữ liệu heartbeat. Trả null nếu thiếu trường bắt buộc. */
export function sanitizeHeartbeat(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const session_id = str(b.session_id, 64);
  if (!session_id) return null;
  const event = ['start', 'beat', 'stopping'].includes(b.event) ? b.event : 'beat';
  const runner_state = ['running', 'stopped', 'exited'].includes(b.runner_state) ? b.runner_state : undefined;
  const gpus = Array.isArray(b.gpus)
    ? b.gpus.slice(0, 8).map((g) => ({
        name: str(g?.name, 60),
        util: num(g?.util),
        mem_used_mb: num(g?.mem_used_mb),
        mem_total_mb: num(g?.mem_total_mb),
        temp_c: num(g?.temp_c),
      }))
    : [];
  return {
    session_id,
    event,
    runner_name: str(b.runner_name, 80),
    runner_state,
    runner_busy: typeof b.runner_busy === 'boolean' ? b.runner_busy : undefined,
    current_job: str(b.current_job, 200) ?? null,
    session_uptime_sec: num(b.session_uptime_sec),
    session_remaining_est_sec: num(b.session_remaining_est_sec),
    cpu: num(b.cpu),
    mem: num(b.mem),
    disk: num(b.disk),
    gpus,
  };
}

const compact = (rec) => ({
  t: rec.time,
  cpu: rec.cpu ?? null,
  mem: rec.mem ?? null,
  gpu: rec.gpus?.[0]?.util ?? null,
  busy: rec.runner_busy ? 1 : 0,
});

export async function handleHeartbeat(deps, body) {
  const { store, telegram, cfg } = deps;
  const clean = sanitizeHeartbeat(body);
  if (!clean) return { ok: false, error: 'invalid' };
  const now = deps.now();
  const prev = await store.getLast();
  const rec = { ...clean, time: now };
  await store.setLast(rec);
  await store.pushHistory(compact(rec));

  const st = (await store.getState()) || newState(now);
  const newSession = !prev || prev.session_id !== clean.session_id;
  let notified = null;

  if (clean.event !== 'stopping') {
    if (st.status === 'dead') {
      const downFor = Math.round((now - st.since) / 1000);
      st.status = 'alive';
      st.since = now;
      st.alert_count = 0;
      st.last_alert_at = 0;
      await store.queueClear(); // phiên đã chạy lại → bỏ lệnh rerun đang chờ
      await store.setState(st);
      await telegram.send(
        `✅ <b>Runner đã online lại</b>\nPhiên mới: <code>${esc(clean.session_id.slice(0, 8))}</code>\n` +
          `Đã gián đoạn: ${fmtDuration(downFor)}`,
        { buttons: dashButtons(cfg, false) },
      );
      notified = 'recovered';
    } else {
      if (st.status !== 'alive') {
        st.status = 'alive';
        st.since = now;
        await store.setState(st);
      }
      if (newSession) {
        if (clean.event === 'start') await store.queueClear();
        await telegram.send(
          `🚀 <b>Phiên Colab mới đã khởi động</b>\nPhiên: <code>${esc(clean.session_id.slice(0, 8))}</code>` +
            (clean.runner_name ? `\nRunner: <code>${esc(clean.runner_name)}</code>` : ''),
          { buttons: dashButtons(cfg, false) },
        );
        notified = 'started';
      }
    }
  }
  return { ok: true, notified };
}

/* ------------------------------------------------------------------ check */
export async function fetchGithubInfo(deps) {
  const { github, cfg } = deps;
  const info = { runners: [], runner: null, queued: null, error: null };
  try {
    info.runners = await github.listRunners();
    info.runner = info.runners.find((r) => r.name === cfg.runnerName) || null;
  } catch (e) {
    info.error = String(e?.message || e);
  }
  try {
    info.queued = await github.queuedCount();
  } catch (e) {
    info.error = info.error || String(e?.message || e);
  }
  return info;
}

function dashButtons(cfg, withMute = true) {
  const row = [];
  if (cfg.colabUrl) row.push({ text: '▶️ Mở Colab', url: cfg.colabUrl });
  if (cfg.publicUrl) row.push({ text: '📊 Dashboard', url: cfg.publicUrl });
  const rows = row.length ? [row] : [];
  if (withMute) rows.push([{ text: '🔕 Tắt báo 1h', callback_data: 'mute:60' }]);
  return rows;
}

function deadMessage(deps, last, gh, st, ageSec) {
  const { cfg } = deps;
  const lines = [];
  lines.push(st.alert_count === 0 ? '🔴 <b>Colab runner đã dừng</b>' : `🔴 <b>Colab runner vẫn đang dừng</b> (nhắc lần ${st.alert_count + 1})`);
  if (last?.event === 'stopping') lines.push('Lý do: notebook báo đang dừng (event <code>stopping</code>).');
  else lines.push(`Lý do: không có heartbeat suốt ${fmtDuration(ageSec)} (ngưỡng ${fmtDuration(cfg.staleAfterSec)}).`);
  lines.push(`Heartbeat cuối: ${fmtTime(last?.time)}`);
  if (gh.runner) {
    lines.push(`GitHub runner <code>${esc(cfg.runnerName)}</code>: <b>${esc(gh.runner.status)}</b>${gh.runner.busy ? ' (busy)' : ''}`);
    if (gh.runner.status === 'online') lines.push('⚠️ GitHub vẫn thấy runner online — có thể chỉ heartbeat bị lỗi.');
  } else if (!gh.error) {
    lines.push(`GitHub runner <code>${esc(cfg.runnerName)}</code>: không tồn tại`);
  } else {
    lines.push(`GitHub: không đọc được (${esc(gh.error)})`);
  }
  if (gh.queued != null) lines.push(`Job đang chờ (queued): <b>${gh.queued}</b>`);
  return lines.join('\n');
}

async function pushRerun(store, now, source) {
  const pending = (await store.queueList()).filter((c) => c.type === 'rerun' && now - c.created < RERUN_TTL_MS);
  if (pending.length) return pending[0];
  const cmd = { id: `rr-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, type: 'rerun', created: now, source };
  await store.queuePush(cmd);
  return cmd;
}

export async function runCheck(deps) {
  const { store, telegram, cfg } = deps;
  if (!(await store.lock('check', CHECK_LOCK_SEC))) return { ok: true, skipped: 'locked' };
  try {
    const now = deps.now();
    const last = await store.getLast();
    const st = (await store.getState()) || newState(now);
    const actions = [];

    if (!last) {
      if (!(await store.getState())) await store.setState(st);
      return { ok: true, state: st.status, actions };
    }

    const ageSec = (now - last.time) / 1000;
    const down = ageSec > cfg.staleAfterSec || last.event === 'stopping';
    let gh = null;
    const ghInfo = async () => (gh ||= await fetchGithubInfo(deps));
    let dirty = false;

    if (!down && st.status !== 'alive') {
      // Heartbeat tươi nhưng state chưa kịp cập nhật (heartbeat handler lỗi giữa chừng)
      const wasDead = st.status === 'dead';
      st.status = 'alive';
      st.since = now;
      st.alert_count = 0;
      st.last_alert_at = 0;
      dirty = true;
      if (wasDead) {
        await store.queueClear();
        await telegram.send(`✅ <b>Runner đã online lại</b>\nPhiên: <code>${esc(last.session_id.slice(0, 8))}</code>`, { buttons: dashButtons(cfg, false) });
        actions.push('recovered');
      }
    } else if (down && st.status !== 'dead') {
      st.status = 'dead';
      st.since = now;
      st.alert_count = 0;
      st.last_alert_at = 0;
      dirty = true;
      await store.setState(st); // lưu TRƯỚC khi gửi để lần gọi trùng không gửi lại
      await pushRerun(store, now, 'check');
      actions.push('dead');
    }

    if (st.status === 'dead' && down) {
      const muted = st.muted_until > now;
      if (!muted && now - st.last_alert_at >= cfg.alertRepeatSec * 1000) {
        const info = await ghInfo();
        const ok = await telegram.send(deadMessage(deps, last, info, st, ageSec), { buttons: dashButtons(cfg) });
        if (ok) {
          st.last_alert_at = now;
          st.alert_count += 1;
          dirty = true;
          actions.push(st.alert_count === 1 ? 'alert' : 'reminder');
        } else {
          actions.push('alert_failed');
        }
      } else {
        actions.push(muted ? 'muted' : 'wait');
      }
    }

    if (st.status === 'alive' && !down) {
      const remaining = last.session_remaining_est_sec != null ? last.session_remaining_est_sec - ageSec : null;
      if (remaining != null && remaining < cfg.earlyWarnSec && st.early_warned_session !== last.session_id) {
        const ok = await telegram.send(
          `⏳ <b>Phiên Colab sắp hết</b>\nCòn khoảng ${fmtDuration(Math.max(0, remaining))}. ` +
            'Hãy chuẩn bị mở lại Colab sau khi phiên kết thúc.' +
            (last.current_job ? `\nJob đang chạy: <code>${esc(last.current_job)}</code>` : ''),
          { buttons: dashButtons(cfg, false) },
        );
        if (ok) {
          st.early_warned_session = last.session_id;
          dirty = true;
          actions.push('early_warning');
        }
      }
    }

    if (dirty) await store.setState(st);
    return { ok: true, state: st.status, actions };
  } finally {
    await store.unlock('check');
  }
}

/* ------------------------------------------------------------------ hành động dùng chung */
export async function setMute(deps, minutes) {
  const now = deps.now();
  const st = (await deps.store.getState()) || newState(now);
  st.muted_until = minutes > 0 ? now + minutes * 60000 : 0;
  await deps.store.setState(st);
  return st.muted_until;
}

export async function requestRerun(deps, source) {
  return pushRerun(deps.store, deps.now(), source);
}

export async function cleanupOffline(deps) {
  const runners = await deps.github.listRunners();
  const offline = runners.filter((r) => r.status === 'offline');
  let removed = 0;
  for (const r of offline) {
    try { await deps.github.deleteRunner(r.id); removed++; } catch { /* tiếp tục */ }
  }
  return { removed, total: offline.length };
}

export async function buildStatus(deps) {
  const now = deps.now();
  const [last, st, history, queue, gh] = await Promise.all([
    deps.store.getLast(),
    deps.store.getState(),
    deps.store.getHistory(),
    deps.store.queueList(),
    fetchGithubInfo(deps),
  ]);
  const state = st || newState(now);
  const ageSec = last ? Math.round((now - last.time) / 1000) : null;
  return {
    now,
    state: {
      status: state.status,
      since: state.since,
      muted_until: state.muted_until || 0,
      last_alert_at: state.last_alert_at || 0,
    },
    stale_after_sec: deps.cfg.staleAfterSec,
    heartbeat_age_sec: ageSec,
    last,
    remaining_sec:
      last?.session_remaining_est_sec != null ? Math.max(0, Math.round(last.session_remaining_est_sec - ageSec)) : null,
    history: history.slice().reverse(), // cũ → mới
    github: gh,
    queue: queue.map((c) => ({ id: c.id, type: c.type, created: c.created })),
    colab_url: deps.cfg.colabUrl,
    runner_name: deps.cfg.runnerName,
  };
}

export async function statusText(deps) {
  const s = await buildStatus(deps);
  const icon = { alive: '🟢', dead: '🔴', unknown: '⚪' }[s.state.status];
  const l = [`${icon} <b>${s.state.status.toUpperCase()}</b> (từ ${fmtTime(s.state.since)})`];
  if (s.last) {
    l.push(`Heartbeat cuối: ${fmtDuration(s.heartbeat_age_sec)} trước`);
    l.push(`Runner: ${esc(s.last.runner_state || '?')}${s.last.runner_busy ? ' • busy' : ' • idle'}`);
    if (s.last.current_job) l.push(`Job: <code>${esc(s.last.current_job)}</code>`);
    if (s.remaining_sec != null) l.push(`Phiên còn ~${fmtDuration(s.remaining_sec)}`);
    if (s.last.cpu != null || s.last.mem != null) l.push(`CPU ${s.last.cpu ?? '—'}% • RAM ${s.last.mem ?? '—'}%`);
    const g = s.last.gpus?.[0];
    if (g) l.push(`GPU ${esc(g.name || '')}: ${g.util ?? '—'}% • VRAM ${g.mem_used_mb ?? '—'}/${g.mem_total_mb ?? '—'} MB`);
  } else {
    l.push('Chưa nhận heartbeat nào.');
  }
  if (s.github.runner) l.push(`GitHub runner: ${esc(s.github.runner.status)}`);
  else if (s.github.error) l.push(`GitHub: lỗi (${esc(s.github.error)})`);
  else l.push('GitHub runner: không tồn tại');
  if (s.github.queued != null) l.push(`Job chờ: ${s.github.queued}`);
  if (s.state.muted_until > deps.now()) l.push(`🔕 Tắt báo đến ${fmtTime(s.state.muted_until)}`);
  if (s.queue.length) l.push(`Lệnh rerun đang chờ agent: ${s.queue.length}`);
  return l.join('\n');
}
