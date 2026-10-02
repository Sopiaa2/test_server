// 공개 지표 수집기. 수집 대상은 "메이커가 등록한 URL"에서 식별자만 뽑아 만든,
// 허용된 호스트(스토어/npm/GitHub)의 주소뿐입니다. 임의 URL 은 가져오지 않습니다.
//
// fetcher(url, opts) => { status, body, finalUrl }  (실서비스는 ssrf.safeFetch, 테스트는 가짜)

export class UserError extends Error {}

// "1,234", "1.2M", "10K", "100만", "5천" → 정수
export function parseCount(raw) {
  const s = String(raw).replace(/[\s,]/g, '');
  const m = s.match(/^([\d.]+)([kKmMbB만천억]?)$/);
  if (!m) return null;
  const mult = { '': 1, k: 1e3, m: 1e6, b: 1e9, 천: 1e3, 만: 1e4, 억: 1e8 }[m[2].toLowerCase()] ?? { 만: 1e4, 천: 1e3, 억: 1e8 }[m[2]];
  const n = Math.round(parseFloat(m[1]) * mult);
  return Number.isFinite(n) ? n : null;
}

const fmt = (n) => n.toLocaleString('en-US');

function parseUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
    return u;
  } catch {
    throw new UserError('URL 형식이 올바르지 않습니다.');
  }
}

const hostIs = (u, ...hosts) => hosts.includes(u.hostname.toLowerCase().replace(/^www\./, ''));

async function getOk(fetcher, url, opts) {
  const res = await fetcher(url, opts);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return res.body;
}

export const COLLECTORS = {
  chrome_users: {
    parse(raw) {
      const u = parseUrl(raw);
      if (!hostIs(u, 'chromewebstore.google.com', 'chrome.google.com')) {
        throw new UserError('크롬 웹스토어 주소(chromewebstore.google.com)만 등록할 수 있습니다.');
      }
      const id = u.pathname.split('/').find((p) => /^[a-p]{32}$/.test(p));
      if (!id) throw new UserError('주소에서 확장 프로그램 ID(32자)를 찾지 못했습니다.');
      return { id };
    },
    async collect({ id }, { fetcher }) {
      const body = await getOk(fetcher, `https://chromewebstore.google.com/detail/${id}?hl=en`, { maxBytes: 2_000_000 });
      const m = body.match(/([\d][\d,.]*\s?[KkMm]?)\+?\s*users/) || body.match(/사용자\s*([\d][\d,.]*\s?[만천]?)\+?\s*명/);
      const value = m && parseCount(m[1]);
      if (value == null) throw new Error('페이지에서 사용자 수를 찾지 못했습니다(스토어 페이지 구조 변경 가능).');
      return { value, display: fmt(value) };
    },
  },

  play_installs: {
    parse(raw) {
      const u = parseUrl(raw);
      if (!hostIs(u, 'play.google.com')) throw new UserError('Google Play 주소(play.google.com)만 등록할 수 있습니다.');
      const id = u.searchParams.get('id');
      if (!id || !/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/.test(id)) throw new UserError('주소에서 앱 패키지명(id=…)을 찾지 못했습니다.');
      return { id };
    },
    async collect({ id }, { fetcher }) {
      const body = await getOk(fetcher, `https://play.google.com/store/apps/details?id=${encodeURIComponent(id)}&hl=en&gl=US`, { maxBytes: 2_500_000 });
      const m = body.match(/([\d][\d,.]*\s?[KMB]?)\+\s*(?:<[^>]*>\s*)*Downloads/i);
      const value = m && parseCount(m[1]);
      if (value == null) throw new Error('페이지에서 설치 구간을 찾지 못했습니다(스토어 페이지 구조 변경 가능).');
      return { value, display: `${m[1].trim()}+` }; // 구간의 하한값
    },
  },

  npm_weekly: {
    parse(raw) {
      const u = parseUrl(raw);
      if (!hostIs(u, 'npmjs.com')) throw new UserError('npm 주소(npmjs.com/package/…)만 등록할 수 있습니다.');
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'package' || !parts[1]) throw new UserError('npmjs.com/package/패키지명 형식이어야 합니다.');
      const name = parts[1].startsWith('@') ? `${parts[1]}/${parts[2] || ''}` : parts[1];
      if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) throw new UserError('패키지명이 올바르지 않습니다.');
      return { name };
    },
    async collect({ name }, { fetcher }) {
      const body = await getOk(fetcher, `https://api.npmjs.org/downloads/point/last-week/${name}`);
      const value = JSON.parse(body).downloads;
      if (!Number.isInteger(value) || value < 0) throw new Error('응답에 downloads 값이 없습니다.');
      return { value, display: fmt(value) };
    },
  },

  github_stars: {
    parse(raw) {
      const u = parseUrl(raw);
      if (!hostIs(u, 'github.com')) throw new UserError('GitHub 주소(github.com/소유자/저장소)만 등록할 수 있습니다.');
      const [owner, repoRaw] = u.pathname.split('/').filter(Boolean);
      const repo = (repoRaw || '').replace(/\.git$/, '');
      if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new UserError('github.com/소유자/저장소 형식이어야 합니다.');
      return { owner, repo };
    },
    async collect({ owner, repo }, { fetcher, githubToken }) {
      const headers = { accept: 'application/vnd.github+json' };
      if (githubToken) headers.authorization = `Bearer ${githubToken}`;
      const body = await getOk(fetcher, `https://api.github.com/repos/${owner}/${repo}`, { headers });
      const value = JSON.parse(body).stargazers_count;
      if (!Number.isInteger(value) || value < 0) throw new Error('응답에 stargazers_count 값이 없습니다.');
      return { value, display: fmt(value) };
    },
  },
};

// 등록 시점 검증: 올바른 형식이 아니면 UserError
export function parseSourceUrl(kind, raw) {
  const c = COLLECTORS[kind];
  if (!c) throw new UserError('지원하지 않는 지표입니다.');
  return c.parse(String(raw).trim());
}

export async function collectOnce(kind, sourceUrl, ctx) {
  const parsed = parseSourceUrl(kind, sourceUrl);
  return COLLECTORS[kind].collect(parsed, ctx);
}
