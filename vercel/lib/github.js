/** Client GitHub tối giản cho một repo. */
export function createGithub(cfg, fetchImpl = fetch) {
  async function api(path, method = 'GET') {
    if (!cfg.githubToken || !cfg.githubRepo) throw new Error('GitHub chưa cấu hình');
    const r = await fetchImpl(`https://api.github.com/repos/${cfg.githubRepo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.githubToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'colab-runner-monitor',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    const text = await r.text();
    return text ? JSON.parse(text) : {};
  }

  return {
    async listRunners() {
      const d = await api('/actions/runners?per_page=100');
      return (d.runners || []).map((x) => ({
        id: x.id,
        name: x.name,
        status: x.status,
        busy: Boolean(x.busy),
        labels: (x.labels || []).map((l) => l.name),
      }));
    },
    async queuedCount() {
      return (await api('/actions/runs?status=queued&per_page=1')).total_count ?? 0;
    },
    async deleteRunner(id) {
      await api(`/actions/runners/${id}`, 'DELETE');
    },
  };
}
