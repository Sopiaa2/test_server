// HTTP 라우터. createApp 은 http.createServer 에 넘길 handler 를 돌려줍니다.
import crypto from 'node:crypto';
import { sha256 } from './store.js';
import { RateLimiter } from './ratelimit.js';
import { CATEGORIES, AUTO_KINDS, SELF_KINDS, ALL_KINDS } from './kinds.js';
import { parseSourceUrl, UserError } from './collectors.js';
import { refreshMetric, refreshService } from './metrics.js';
import { verifyOwnership, newToken } from './verify.js';
import { rankServices } from './ranking.js';
import { assertFetchableUrl, FetchBlockedError } from './ssrf.js';
import * as V from './views.js';

const MAX_BODY = 16 * 1024;

export function createApp({ store, config, fetcher, limiter = new RateLimiter(), now = () => new Date() }) {
  const L = config.limits;

  // 사용자 요청으로 나가는 외부 요청 전체에 걸린 상한
  const userFetcher = async (url, opts) => {
    if (!limiter.hit('outbound', L.outbound).ok) throw new Error('요청이 많아 잠시 후 다시 시도해 주세요.');
    return fetcher(url, opts);
  };
  const collectOpts = (f) => ({ fetcher: f, githubToken: config.githubToken, now });

  const clientIp = (req) => {
    if (config.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1]; // 프록시가 덧붙인 마지막 값만 신뢰
    }
    return req.socket.remoteAddress || 'unknown';
  };

  const csrfToken = () => crypto.createHmac('sha256', config.adminPassword).update('admin-csrf').digest('hex');
  const safeEq = (a, b) => crypto.timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));

  function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
    res.writeHead(status, {
      'content-type': type,
      'content-security-policy': "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      ...extra,
    });
    res.end(body);
  }
  const redirect = (res, to) => send(res, 303, '', 'text/plain', { location: to });
  const page = (res, status, body) => send(res, status, body);
  const tooMany = (res, sec) => send(res, 429, V.messagePage(config, '요청이 너무 많습니다', `${sec}초 후 다시 시도해 주세요.`), 'text/html; charset=utf-8', { 'retry-after': String(sec) });
  const notFound = (res) => page(res, 404, V.messagePage(config, '찾을 수 없습니다', '존재하지 않는 페이지입니다.'));

  async function readForm(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 });
      chunks.push(c);
    }
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
  }

  const clean = (v, max) => String(v ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);

  // ---------- 공개 ----------
  function board(req, res, url) {
    const sort = url.searchParams.get('sort') || 'score';
    const category = url.searchParams.get('category') || '';
    const safeSort = sort === 'score' || ALL_KINDS[sort] ? sort : 'score';
    const safeCat = CATEGORIES.includes(category) ? category : '';
    page(res, 200, V.boardPage(config, rankServices(store.list(), { sort: safeSort, category: safeCat }), { sort: safeSort, category: safeCat }));
  }

  async function register(req, res, ip) {
    const f = await readForm(req);
    const values = { name: clean(f.name, 40), url: clean(f.url, 200), category: clean(f.category, 30), email: clean(f.email, 100) };
    const fail = (error) => page(res, 400, V.registerPage(config, { error, values }));
    if (!L.register || !limiter.hit(`register:${ip}`, L.register).ok) return tooMany(res, 3600);
    if (!values.name) return fail('서비스명을 입력해 주세요.');
    if (!CATEGORIES.includes(values.category)) return fail('카테고리를 선택해 주세요.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) return fail('이메일 형식이 올바르지 않습니다.');
    if (f.consent !== '1') return fail('개인정보 처리방침에 동의해야 합니다.');
    let u;
    try {
      u = assertFetchableUrl(values.url);
    } catch (e) {
      return fail(e instanceof FetchBlockedError ? e.message : 'URL 이 올바르지 않습니다.');
    }
    values.url = u.href;
    if (store.list().filter((s) => s.status === 'pending').length >= config.maxPending) return fail('현재 신청이 많아 접수를 일시 중단했습니다. 나중에 다시 시도해 주세요.');
    const host = (x) => new URL(x).hostname.replace(/^www\./, '');
    if (store.list().some((s) => s.ownerVerifiedAt && host(s.url) === host(values.url))) return fail('이미 소유자 인증이 완료된 사이트입니다. 문의가 필요하면 운영자에게 연락해 주세요.');

    const key = crypto.randomBytes(24).toString('base64url');
    store.add({
      id: crypto.randomUUID(),
      name: values.name,
      url: values.url,
      category: values.category,
      email: values.email,
      status: 'pending',
      createdAt: now().toISOString(),
      verifyToken: newToken(),
      manageKeyHash: sha256(key),
      ownerVerifiedAt: null,
      metrics: [],
    });
    page(res, 201, V.registeredPage(config, `${config.baseUrl || ''}/manage/${key}`));
  }

  // ---------- 메이커 관리 (비밀 키 URL) ----------
  async function manage(req, res, url, ip, parts) {
    const s = store.findByManageKey(parts[1]);
    if (!s) return notFound(res);
    const key = parts[1];
    const show = (extra = {}, status = 200) => page(res, status, V.managePage(config, s, { key, ...extra }));
    if (req.method === 'GET' && parts.length === 2) return show();
    if (req.method !== 'POST') return notFound(res);
    if (!L.manage || !limiter.hit(`manage:${ip}`, L.manage).ok) return tooMany(res, 600);

    const action = parts[2];
    if (action === 'verify') {
      if (s.ownerVerifiedAt) return show({ msg: '이미 인증되었습니다.' });
      if (!limiter.hit(`verify:${s.id}`, L.verify).ok || !limiter.hit(`verifyIp:${ip}`, L.verifyIp).ok) return show({ error: '인증 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' }, 429);
      const r = await verifyOwnership(s, userFetcher);
      if (!r.ok) return show({ error: `인증에 실패했습니다: ${r.reason}` });
      s.ownerVerifiedAt = now().toISOString();
      store.save();
      return show({ msg: '소유자 인증이 완료되었습니다.' });
    }

    if (action === 'metrics' && parts.length === 3) {
      const f = await readForm(req);
      if (f.type === 'auto') {
        const kind = f.kind;
        if (!AUTO_KINDS[kind]) return show({ error: '지원하지 않는 지표입니다.' }, 400);
        let sourceUrl;
        try {
          parseSourceUrl(kind, f.sourceUrl);
          sourceUrl = clean(f.sourceUrl, 300);
        } catch (e) {
          return show({ error: e instanceof UserError ? e.message : 'URL 이 올바르지 않습니다.' }, 400);
        }
        let m = s.metrics.find((x) => x.kind === kind);
        if (!m && s.metrics.length >= config.maxMetricsPerService) return show({ error: `지표는 최대 ${config.maxMetricsPerService}개까지 등록할 수 있습니다.` }, 400);
        if (!m) {
          m = { id: crypto.randomUUID(), kind, level: 'auto', value: null, display: null, lastSuccessAt: null, lastAttemptAt: null, lastError: null, failCount: 0 };
          s.metrics.push(m);
        }
        if (m.sourceUrl !== sourceUrl) {
          m.sourceUrl = sourceUrl;
          m.value = null; // 출처가 바뀌면 이전 값은 무효
          m.display = null;
          m.lastSuccessAt = null;
        }
        store.save();
        if (s.status === 'approved') await refreshMetric(store, m, collectOpts(userFetcher)); // 승인 전에는 외부 요청을 보내지 않음
        return show({ msg: s.status === 'approved' ? '지표를 저장하고 수집을 시도했습니다.' : '지표를 저장했습니다. 승인 후 수집이 시작됩니다.' });
      }
      if (f.type === 'self') {
        const kind = f.kind;
        const n = Number(String(f.value).replace(/,/g, ''));
        if (!SELF_KINDS[kind]) return show({ error: '지원하지 않는 지표입니다.' }, 400);
        if (!Number.isInteger(n) || n < 0 || n > 1_000_000_000) return show({ error: '0 이상의 정수를 입력해 주세요.' }, 400);
        let m = s.metrics.find((x) => x.kind === kind);
        if (!m && s.metrics.length >= config.maxMetricsPerService) return show({ error: `지표는 최대 ${config.maxMetricsPerService}개까지 등록할 수 있습니다.` }, 400);
        if (!m) {
          m = { id: crypto.randomUUID(), kind, level: 'self' };
          s.metrics.push(m);
        }
        Object.assign(m, { value: n, display: n.toLocaleString('en-US'), updatedAt: now().toISOString(), lastSuccessAt: now().toISOString() });
        store.save();
        return show({ msg: '자가 입력 값을 저장했습니다.' });
      }
      return show({ error: '잘못된 요청입니다.' }, 400);
    }

    if (action === 'metrics' && parts[4] === 'delete') {
      s.metrics = s.metrics.filter((m) => m.id !== parts[3]);
      store.save();
      return show({ msg: '삭제했습니다.' });
    }
    return notFound(res);
  }

  // ---------- 관리자 (나 혼자) ----------
  async function admin(req, res, url, ip, parts) {
    if (!config.adminPassword) return notFound(res); // 비밀번호 미설정 시 관리자 화면 비활성
    if (!limiter.peek(`adminFail:${ip}`, L.adminFail)) return tooMany(res, 900);
    const auth = String(req.headers.authorization || '');
    const [user, ...pw] = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString().split(':') : [''];
    if (!(auth && safeEq(user, 'admin') && safeEq(pw.join(':'), config.adminPassword))) {
      limiter.hit(`adminFail:${ip}`, L.adminFail);
      return send(res, 401, 'Unauthorized', 'text/plain; charset=utf-8', { 'www-authenticate': 'Basic realm="admin", charset="UTF-8"' });
    }
    if (req.method === 'GET' && parts.length === 1) return page(res, 200, V.adminPage(config, store.list(), csrfToken(), url.searchParams.get('msg') || ''));
    if (req.method === 'GET' && parts[1] === 'export.json') {
      return send(res, 200, JSON.stringify(store.data, null, 2), 'application/json; charset=utf-8', { 'content-disposition': 'attachment; filename="maker-board-backup.json"' });
    }
    if (req.method !== 'POST') return notFound(res);
    if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, 'Forbidden', 'text/plain');
    const f = await readForm(req);
    if (!f.csrf || !safeEq(f.csrf, csrfToken())) return send(res, 403, 'Forbidden', 'text/plain');
    const s = store.get(parts[2]);
    if (!s) return redirect(res, '/admin?msg=' + encodeURIComponent('대상을 찾을 수 없습니다.'));
    if (parts[1] === 'approve') {
      s.status = 'approved';
      s.approvedAt = now().toISOString();
      store.save();
      refreshService(store, s, collectOpts(fetcher)).catch((e) => console.error('[collect]', e.message)); // 백그라운드 수집
      return redirect(res, '/admin?msg=' + encodeURIComponent('승인했습니다.'));
    }
    if (parts[1] === 'unapprove') {
      s.status = 'pending';
      store.save();
      return redirect(res, '/admin?msg=' + encodeURIComponent('승인을 취소했습니다.'));
    }
    if (parts[1] === 'recollect') {
      refreshService(store, s, collectOpts(fetcher)).catch((e) => console.error('[collect]', e.message));
      return redirect(res, '/admin?msg=' + encodeURIComponent('수집을 시작했습니다.'));
    }
    if (parts[1] === 'delete') {
      store.remove(s.id);
      return redirect(res, '/admin?msg=' + encodeURIComponent('삭제했습니다.'));
    }
    return notFound(res);
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const ip = clientIp(req);
      if (!limiter.hit(`global:${ip}`, L.global).ok) return tooMany(res, 60);
      const parts = url.pathname.split('/').filter(Boolean);
      const m = req.method;

      if (url.pathname === '/style.css') return send(res, 200, V.CSS, 'text/css; charset=utf-8', { 'cache-control': 'public, max-age=3600' });
      if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
      if (url.pathname === '/' && m === 'GET') return board(req, res, url);
      if (url.pathname === '/privacy' && m === 'GET') return page(res, 200, V.privacyPage(config));
      if (url.pathname === '/register') {
        if (m === 'GET') return page(res, 200, V.registerPage(config));
        if (m === 'POST') return await register(req, res, ip);
      }
      if (parts[0] === 'manage' && parts[1]) return await manage(req, res, url, ip, parts);
      if (parts[0] === 'admin') return await admin(req, res, url, ip, parts);
      return notFound(res);
    } catch (e) {
      if (e && e.status === 413) return send(res, 413, 'Payload Too Large', 'text/plain');
      console.error('[error]', e);
      if (!res.headersSent) send(res, 500, V.messagePage(config, '오류', '잠시 후 다시 시도해 주세요.'));
    }
  }

  return { handler, limiter };
}
