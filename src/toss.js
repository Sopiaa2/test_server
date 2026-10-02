// 토스 매출 인증 확장 지점 (1단계에서는 구현하지 않음).
//
// 2단계에서 할 일:
//   1) features.js 의 tossRevenue 를 true 로 변경
//   2) 아래 RevenueVerifier 인터페이스를 구현한 클래스를 registerRevenueVerifier() 로 등록
//   3) 구현체가 반환한 값은 metric 으로 저장하되 level 은 'revenue' 같은 새 단계로 추가
//      (ranking.js 의 WEIGHTS, views.js 의 배지 문구도 함께 추가)
import { FEATURES } from './features.js';

/**
 * @typedef {Object} RevenueResult
 * @property {number} amountKrw  검증된 기간 매출(원)
 * @property {string} period     예: '2026-09'
 * @property {string} verifiedAt ISO 시각
 *
 * @typedef {Object} RevenueVerifier
 * @property {(service: object) => Promise<{ authUrl: string }>} startAuthorization  메이커가 토스 연결을 시작할 URL
 * @property {(service: object, callbackParams: object) => Promise<void>} completeAuthorization
 * @property {(service: object) => Promise<RevenueResult>} fetchRevenue
 */

let verifier = null;

export function registerRevenueVerifier(impl) {
  verifier = impl;
}

// 플래그가 꺼져 있으면 항상 null → 호출하는 쪽은 기능이 없는 것으로 취급
export function getRevenueVerifier() {
  if (!FEATURES.tossRevenue) return null;
  if (!verifier) throw new Error('tossRevenue 플래그가 켜져 있지만 구현체가 등록되지 않았습니다.');
  return verifier;
}
