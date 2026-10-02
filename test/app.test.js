import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { FEATURES } from '../src/features.js';
import { getRevenueVerifier } from '../src/toss.js';
import { fakeFetcher } from './helpers.js';

const ADMIN = 'Basic ' + Buffer.from('admin:s3cret').toString('base64');

async function boot({ routes = {}, limits = {} } = {}) {
  const config = { ...loadConfig({ ADMIN_PASSWORD: 's3cret', BASE_URL: 'http://t' }), ...{} };
  config.limits = { ...config.limits, ...limits };
  const store = new Store();
  const fetcher = fakeFetcher(routes);
  const { handler } = createApp({ store, config, fetcher });
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = (path, { method = 'GET', form, headers = {} } = {}) =>
    fetch(base + path, { method, redirect: 'manual', headers: { ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers }, body: form ? new URLSearchParams(form) : undefined });
  return { store, fetcher, req, close: () => srv.close(), config };
}

const REG = { name: 'My App', url: 'https://example.com/', category: '웹 서비스', email: 'maker@example.com', consent: '1' };
async function registerAndKey(ctx, over = {}) {
  const r = await ctx.req('/register', { method: 'POST', form: { ...REG, ...over } });
  assert.equal(r.status, 201);
  const key = (await r.text()).match(/\/manage\/([\w-]+)/)[1];
  return { key, s: ctx.store.list().at(-1) };
}
const csrfOf = async (ctx) => (await (await ctx.req('/admin', { headers: { authorization: ADMIN } })).text()).match(/name="csrf" value="(\w+)"/)[1];
const approve = async (ctx, id) => ctx.req(`/admin/approve/${id}`, { method: 'POST', form: { csrf: await csrfOf(ctx) }, headers: { authorization: ADMIN } });

test('등록 → 승인 전에는 비공개 → 승인 후 순위표 표시, 이메일은 비공개', async () => {
  const ctx = await boot();
  const { s } = await registerAndKey(ctx);
  assert.equal(s.status, 'pending');
  let home = await (await ctx.req('/')).text();
  assert.ok(!home.includes('My App'));
  assert.equal((await approve(ctx, s.id)).status, 303);
  home = await (await ctx.req('/')).text();
  assert.ok(home.includes('My App'));
  assert.ok(!home.includes('maker@example.com'));
  ctx.close();
});

test('소유권 인증 성공 시 "소유자 인증" 배지, 실패 시 미인증 유지', async () => {
  const ctx = await boot();
  const { key, s } = await registerAndKey(ctx);
  await approve(ctx, s.id);
  let r = await ctx.req(`/manage/${key}/verify`, { method: 'POST' });
  assert.match(await r.text(), /인증에 실패/);
  assert.equal(s.ownerVerifiedAt, null);

  const routes = {};
  const ctx2 = await boot({ routes });
  const reg = await registerAndKey(ctx2);
  routes[`https://example.com/verify-${reg.s.verifyToken}.txt`] = { status: 200, body: reg.s.verifyToken };
  await approve(ctx2, reg.s.id);
  r = await ctx2.req(`/manage/${reg.key}/verify`, { method: 'POST' });
  assert.match(await r.text(), /인증이 완료/);
  assert.ok(reg.s.ownerVerifiedAt);
  assert.match(await (await ctx2.req('/')).text(), /소유자 인증/);
  ctx.close(); ctx2.close();
});

test('자가 입력 지표는 "자가 입력" 배지, 자동 수집 지표는 "자동 확인" 배지, 수집 실패 시 마지막 성공값 표시', async () => {
  const api = 'https://api.github.com/repos/o/r';
  const routes = { [api]: { status: 200, body: '{"stargazers_count": 321}' } };
  const ctx = await boot({ routes });
  const { key, s } = await registerAndKey(ctx);
  await approve(ctx, s.id);
  await ctx.req(`/manage/${key}/metrics`, { method: 'POST', form: { type: 'self', kind: 'self_visitors', value: '1,500' } });
  await ctx.req(`/manage/${key}/metrics`, { method: 'POST', form: { type: 'auto', kind: 'github_stars', sourceUrl: 'https://github.com/o/r' } });
  let home = await (await ctx.req('/')).text();
  assert.match(home, /자가 입력/);
  assert.match(home, /자동 확인/);
  assert.match(home, /321/);

  routes[api] = { status: 500, body: '' }; // 이후 수집 실패
  await ctx.req(`/admin/recollect/${s.id}`, { method: 'POST', form: { csrf: await csrfOf(ctx) }, headers: { authorization: ADMIN } });
  await new Promise((r) => setTimeout(r, 50));
  home = await (await ctx.req('/?sort=github_stars')).text();
  assert.match(home, /321/);
  assert.match(home, /마지막 성공값을 표시 중/);
  ctx.close();
});

test('허용되지 않은 출처 URL(내부 IP, 다른 도메인)은 지표로 등록할 수 없다', async () => {
  const ctx = await boot();
  const { key, s } = await registerAndKey(ctx);
  await approve(ctx, s.id);
  for (const sourceUrl of ['http://169.254.169.254/package/x', 'https://evil.com/o/r']) {
    const r = await ctx.req(`/manage/${key}/metrics`, { method: 'POST', form: { type: 'auto', kind: 'github_stars', sourceUrl } });
    assert.equal(r.status, 400);
  }
  assert.equal(s.metrics.length, 0);
  assert.equal(ctx.fetcher.calls.length, 0);
  ctx.close();
});

test('내부 주소로 서비스 등록 불가', async () => {
  const ctx = await boot();
  for (const url of ['http://localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/', 'http://10.0.0.5/']) {
    const r = await ctx.req('/register', { method: 'POST', form: { ...REG, url } });
    assert.equal(r.status, 400, url);
  }
  assert.equal(ctx.store.list().length, 0);
  ctx.close();
});

test('입력 검증: 동의 누락, 이메일 형식, XSS 이스케이프', async () => {
  const ctx = await boot();
  assert.equal((await ctx.req('/register', { method: 'POST', form: { ...REG, consent: '' } })).status, 400);
  assert.equal((await ctx.req('/register', { method: 'POST', form: { ...REG, email: 'nope' } })).status, 400);
  const { s } = await registerAndKey(ctx, { name: '<script>alert(1)</script>' });
  await approve(ctx, s.id);
  const home = await (await ctx.req('/')).text();
  assert.ok(!home.includes('<script>alert'));
  assert.ok(home.includes('&lt;script&gt;'));
  ctx.close();
});

test('관리자: 인증 없으면 401, 잘못된 CSRF 는 403, 삭제 동작', async () => {
  const ctx = await boot();
  const { s } = await registerAndKey(ctx);
  assert.equal((await ctx.req('/admin')).status, 401);
  assert.equal((await ctx.req('/admin', { headers: { authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') } })).status, 401);
  assert.equal((await ctx.req(`/admin/delete/${s.id}`, { method: 'POST', form: { csrf: 'bad' }, headers: { authorization: ADMIN } })).status, 403);
  assert.equal(ctx.store.list().length, 1);
  assert.equal((await ctx.req(`/admin/delete/${s.id}`, { method: 'POST', form: { csrf: await csrfOf(ctx) }, headers: { authorization: ADMIN } })).status, 303);
  assert.equal(ctx.store.list().length, 0);
  ctx.close();
});

test('관리자 비밀번호 미설정이면 관리자 화면 비활성', async () => {
  const config = loadConfig({});
  const { handler } = createApp({ store: new Store(), config, fetcher: fakeFetcher({}) });
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  assert.equal((await fetch(`http://127.0.0.1:${srv.address().port}/admin`)).status, 404);
  srv.close();
});

test('관리자 로그인 연속 실패 시 429', async () => {
  const ctx = await boot({ limits: { adminFail: [3, 60000] } });
  const bad = { authorization: 'Basic ' + Buffer.from('admin:x').toString('base64') };
  for (let i = 0; i < 3; i++) assert.equal((await ctx.req('/admin', { headers: bad })).status, 401);
  assert.equal((await ctx.req('/admin', { headers: bad })).status, 429);
  assert.equal((await ctx.req('/admin', { headers: { authorization: ADMIN } })).status, 429); // 차단 중에는 정답도 거부
  ctx.close();
});

test('속도 제한: 등록 한도 초과 시 429, 인증 시도 한도 초과 시 429', async () => {
  const ctx = await boot({ limits: { register: [2, 60000], verify: [2, 60000] } });
  await registerAndKey(ctx);
  const { key } = await registerAndKey(ctx);
  assert.equal((await ctx.req('/register', { method: 'POST', form: REG })).status, 429);
  await ctx.req(`/manage/${key}/verify`, { method: 'POST' });
  await ctx.req(`/manage/${key}/verify`, { method: 'POST' });
  assert.equal((await ctx.req(`/manage/${key}/verify`, { method: 'POST' })).status, 429);
  ctx.close();
});

test('관리 키를 모르면 접근 불가, 개인정보 처리방침/정적 페이지 제공', async () => {
  const ctx = await boot();
  assert.equal((await ctx.req('/manage/wrong-key')).status, 404);
  const p = await ctx.req('/privacy');
  assert.equal(p.status, 200);
  assert.match(await p.text(), /이메일/);
  assert.match(p.headers.get('content-security-policy'), /default-src 'none'/);
  ctx.close();
});

test('토스 매출 인증은 기능 플래그 OFF, 인터페이스만 존재', () => {
  assert.equal(FEATURES.tossRevenue, false);
  assert.equal(getRevenueVerifier(), null);
  assert.throws(() => { FEATURES.tossRevenue = true; });
});
