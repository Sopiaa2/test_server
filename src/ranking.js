// 순위 계산.
// 종합점수 = Σ log10(1 + 값) × 단계 가중치 × 소유자 인증 계수
//   단계 가중치: 자동 확인 1.0, 자가 입력 0.2 (자가 입력은 의도적으로 낮게)
//   소유자 인증 계수: 인증 1.0, 미인증 0.5
export const WEIGHTS = { auto: 1, self: 0.2 };
export const UNVERIFIED_FACTOR = 0.5;

export const isVerified = (s) => !!s.ownerVerifiedAt;

export function serviceScore(s) {
  const factor = isVerified(s) ? 1 : UNVERIFIED_FACTOR;
  let sum = 0;
  for (const m of s.metrics) {
    if (m.value == null) continue; // 한 번도 수집 못한 지표는 점수 없음
    sum += Math.log10(1 + m.value) * (WEIGHTS[m.level] ?? 0);
  }
  return sum * factor;
}

// sort: 'score' 또는 지표 종류. 승인된 서비스만 대상.
export function rankServices(services, { sort = 'score', category = '' } = {}) {
  let rows = services.filter((s) => s.status === 'approved');
  if (category) rows = rows.filter((s) => s.category === category);
  rows = rows.map((s) => ({ service: s, score: serviceScore(s), metric: s.metrics.find((m) => m.kind === sort && m.value != null) }));
  if (sort !== 'score') {
    rows = rows.filter((r) => r.metric);
    rows.sort((a, b) => b.metric.value - a.metric.value || b.score - a.score);
  } else {
    rows.sort((a, b) => b.score - a.score || a.service.createdAt.localeCompare(b.service.createdAt));
  }
  return rows;
}
