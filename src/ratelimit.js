// 메모리 기반 슬라이딩 윈도우 속도 제한. (서버 1대 구조 전제)
export class RateLimiter {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.hits = new Map();
  }

  // 한도 안이면 기록하고 ok:true, 넘으면 ok:false + 재시도까지 남은 초
  hit(key, [limit, windowMs]) {
    const t = this.now();
    const arr = (this.hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((arr[0] + windowMs - t) / 1000)) };
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 20000) this.sweep(windowMs);
    return { ok: true, retryAfterSec: 0 };
  }

  // 기록만 조회 (실패 횟수 확인용)
  peek(key, [limit, windowMs]) {
    const t = this.now();
    const arr = (this.hits.get(key) || []).filter((x) => t - x < windowMs);
    return arr.length < limit;
  }

  sweep(windowMs) {
    const t = this.now();
    for (const [k, arr] of this.hits) {
      if (!arr.length || t - arr[arr.length - 1] >= windowMs) this.hits.delete(k);
    }
  }
}
