// 기능 플래그. 환경변수로 켤 수 없게 의도적으로 코드에 고정했습니다.
// 켜려면 아래 값을 바꾸고 src/toss.js 의 인터페이스를 구현해야 합니다.
export const FEATURES = Object.freeze({
  tossRevenue: false, // 토스 매출 인증 (2단계 이후)
});
