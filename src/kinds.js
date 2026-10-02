// 지표 종류 정의. level: auto = 서버가 공개 페이지/API 에서 직접 수집, self = 메이커 자가 입력
export const AUTO_KINDS = {
  chrome_users: { label: '크롬 웹스토어 사용자', hint: 'https://chromewebstore.google.com/detail/…', level: 'auto' },
  play_installs: { label: 'Google Play 설치(구간)', hint: 'https://play.google.com/store/apps/details?id=…', level: 'auto' },
  npm_weekly: { label: 'npm 주간 다운로드', hint: 'https://www.npmjs.com/package/…', level: 'auto' },
  github_stars: { label: 'GitHub 스타', hint: 'https://github.com/소유자/저장소', level: 'auto' },
};

export const SELF_KINDS = {
  self_visitors: { label: '월 방문자', level: 'self' },
  self_users: { label: '가입자/사용자', level: 'self' },
};

export const ALL_KINDS = { ...AUTO_KINDS, ...SELF_KINDS };

export const CATEGORIES = ['웹 서비스', '모바일 앱', '크롬 확장', '개발자 도구/라이브러리', '게임', '기타'];

export const LEVEL_LABELS = { auto: '자동 확인', owner: '소유자 인증', self: '자가 입력' };
