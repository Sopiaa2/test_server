// 지표 갱신 실행기. 어떤 수집이 실패해도 예외를 밖으로 던지지 않고,
// 마지막 성공값/시각을 보존하면서 실패 사실만 기록합니다.
import { collectOnce } from './collectors.js';

export async function refreshMetric(store, metric, { fetcher, githubToken = '', now = () => new Date() }) {
  const at = now().toISOString();
  metric.lastAttemptAt = at;
  try {
    const r = await collectOnce(metric.kind, metric.sourceUrl, { fetcher, githubToken });
    metric.value = r.value;
    metric.display = r.display;
    metric.lastSuccessAt = at;
    metric.lastError = null;
    metric.failCount = 0;
  } catch (e) {
    // value/display/lastSuccessAt 은 건드리지 않는다 = 마지막 성공값 유지
    metric.lastError = String(e && e.message ? e.message : e).slice(0, 200);
    metric.failCount = (metric.failCount || 0) + 1;
  }
  try {
    store.save();
  } catch (e) {
    console.error('[metrics] 저장 실패', e.message);
  }
  return metric.lastError === null;
}

export async function refreshService(store, service, opts) {
  for (const m of service.metrics) {
    if (m.level === 'auto') await refreshMetric(store, m, opts);
  }
}

// 승인된 서비스의 자동 지표를 순서대로(동시 요청 없이) 갱신
export async function refreshAll(store, { delayMs = 1000, ...opts } = {}) {
  let ok = 0;
  let failed = 0;
  for (const s of store.list()) {
    if (s.status !== 'approved') continue;
    for (const m of s.metrics) {
      if (m.level !== 'auto') continue;
      if (await refreshMetric(store, m, opts)) ok += 1;
      else failed += 1;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return { ok, failed };
}
