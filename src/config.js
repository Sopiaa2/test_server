import path from 'node:path';

// 환경변수로만 설정합니다. (비밀번호 등은 코드/깃에 넣지 마세요)
export function loadConfig(env = process.env) {
  return {
    siteName: '메이커 순위표',
    port: Number(env.PORT) || 3000,
    dataDir: env.DATA_DIR || path.resolve('data'),
    adminPassword: env.ADMIN_PASSWORD || '',
    baseUrl: (env.BASE_URL || '').replace(/\/$/, ''), // 예: https://my-board.example.com (등록 완료 화면의 관리 주소용)
    contactEmail: env.CONTACT_EMAIL || '',
    githubToken: env.GITHUB_TOKEN || '', // 선택: GitHub API 한도 상향
    trustProxy: env.TRUST_PROXY === '1', // 호스팅 프록시 뒤에서 실행할 때 1
    collectIntervalHours: Number(env.COLLECT_INTERVAL_HOURS) || 6,
    maxPending: 200, // 승인 대기 상한 (스팸 방지)
    maxMetricsPerService: 8,
    // 속도 제한: [허용 횟수, 창(ms)]
    limits: {
      global: [300, 60_000], // IP당 분당 전체 요청
      register: [5, 3_600_000], // IP당 시간당 등록
      verify: [10, 3_600_000], // 서비스당 시간당 인증 시도
      verifyIp: [30, 3_600_000], // IP당 시간당 인증 시도
      manage: [40, 3_600_000], // IP당 시간당 지표 변경
      outbound: [60, 60_000], // 사용자 요청으로 나가는 외부 요청 전체(분당)
      adminFail: [10, 900_000], // IP당 15분 관리자 로그인 실패
    },
  };
}
