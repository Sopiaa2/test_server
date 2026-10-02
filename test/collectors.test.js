import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCount, parseSourceUrl, collectOnce, UserError } from '../src/collectors.js';
import { refreshMetric, refreshAll } from '../src/metrics.js';
import { Store } from '../src/store.js';
import { fakeFetcher, service } from './helpers.js';

const CHROME_ID = 'a'.repeat(32);
const CHROME_URL = `https://chromewebstore.google.com/detail/my-ext/${CHROME_ID}`;
const CHROME_API = `https://chromewebstore.google.com/detail/${CHROME_ID}?hl=en`;

test('parseCount', () => {
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('1.2M'), 1_200_000);
  assert.equal(parseCount('10K'), 10_000);
  assert.equal(parseCount('100만'), 1_000_000);
  assert.equal(parseCount('abc'), null);
});

test('등록 URL 은 허용된 호스트만 받는다', () => {
  assert.throws(() => parseSourceUrl('chrome_users', 'https://evil.com/detail/x'), UserError);
  assert.throws(() => parseSourceUrl('npm_weekly', 'http://169.254.169.254/package/x'), UserError);
  assert.throws(() => parseSourceUrl('github_stars', 'https://github.com.evil.com/a/b'), UserError);
  assert.throws(() => parseSourceUrl('play_installs', 'https://play.google.com/store/apps/details?id=../../x'), UserError);
  assert.deepEqual(parseSourceUrl('npm_weekly', 'https://www.npmjs.com/package/@scope/pkg'), { name: '@scope/pkg' });
  assert.deepEqual(parseSourceUrl('github_stars', 'https://github.com/o/r.git'), { owner: 'o', repo: 'r' });
});

test('수집기: 가짜 응답에서 값 추출', async () => {
  const f = fakeFetcher({
    [CHROME_API]: { status: 200, body: '<div>12,345 users</div>' },
    'https://play.google.com/store/apps/details?id=com.a.b&hl=en&gl=US': { status: 200, body: '<div>100K+</div><div class="x">Downloads</div>' },
    'https://api.npmjs.org/downloads/point/last-week/pkg': { status: 200, body: '{"downloads": 777}' },
    'https://api.github.com/repos/o/r': { status: 200, body: '{"stargazers_count": 42}' },
  });
  const ctx = { fetcher: f };
  assert.equal((await collectOnce('chrome_users', CHROME_URL, ctx)).value, 12345);
  const play = await collectOnce('play_installs', 'https://play.google.com/store/apps/details?id=com.a.b', ctx);
  assert.deepEqual([play.value, play.display], [100000, '100K+']);
  assert.equal((await collectOnce('npm_weekly', 'https://www.npmjs.com/package/pkg', ctx)).value, 777);
  assert.equal((await collectOnce('github_stars', 'https://github.com/o/r', ctx)).value, 42);
});

test('수집기는 등록 URL 이 아니라 허용 호스트의 API 만 호출한다', async () => {
  const f = fakeFetcher({ 'https://api.npmjs.org/downloads/point/last-week/pkg': { status: 200, body: '{"downloads": 1}' } });
  await collectOnce('npm_weekly', 'https://www.npmjs.com/package/pkg?x=http://evil.com', { fetcher: f });
  assert.deepEqual(f.calls, ['https://api.npmjs.org/downloads/point/last-week/pkg']);
});

function metric(over = {}) {
  return { id: 'm1', kind: 'npm_weekly', level: 'auto', sourceUrl: 'https://www.npmjs.com/package/pkg', value: 500, display: '500', lastSuccessAt: '2026-01-01T00:00:00.000Z', lastError: null, ...over };
}
const NPM = 'https://api.npmjs.org/downloads/point/last-week/pkg';
const T2 = () => new Date('2026-02-02T00:00:00.000Z');

test('수집 실패(HTTP 오류) 시 마지막 성공값/시각을 유지하고 오류만 기록', async () => {
  const m = metric();
  const ok = await refreshMetric(new Store(), m, { fetcher: fakeFetcher({ [NPM]: { status: 500, body: '' } }), now: T2 });
  assert.equal(ok, false);
  assert.equal(m.value, 500);
  assert.equal(m.lastSuccessAt, '2026-01-01T00:00:00.000Z');
  assert.equal(m.lastAttemptAt, '2026-02-02T00:00:00.000Z');
  assert.match(m.lastError, /HTTP 500/);
  assert.equal(m.failCount, 1);
});

test('수집 실패(예외/타임아웃/깨진 JSON/구조 변경) 모두 앱을 죽이지 않음', async () => {
  for (const routes of [{ [NPM]: new Error('요청 시간이 초과되었습니다.') }, { [NPM]: { status: 200, body: '<html>' } }, { [NPM]: { status: 200, body: '{}' } }]) {
    const m = metric();
    assert.equal(await refreshMetric(new Store(), m, { fetcher: fakeFetcher(routes), now: T2 }), false);
    assert.equal(m.value, 500);
    assert.ok(m.lastError);
  }
  const m = metric({ kind: 'chrome_users', sourceUrl: CHROME_URL });
  await refreshMetric(new Store(), m, { fetcher: fakeFetcher({ [CHROME_API]: { status: 200, body: '<html>layout changed</html>' } }), now: T2 });
  assert.equal(m.value, 500);
  assert.match(m.lastError, /찾지 못/);
});

test('다시 성공하면 값/시각 갱신, 오류 초기화', async () => {
  const m = metric({ lastError: 'x', failCount: 3 });
  assert.equal(await refreshMetric(new Store(), m, { fetcher: fakeFetcher({ [NPM]: { status: 200, body: '{"downloads": 900}' } }), now: T2 }), true);
  assert.deepEqual([m.value, m.lastSuccessAt, m.lastError, m.failCount], [900, '2026-02-02T00:00:00.000Z', null, 0]);
});

test('한 번도 성공 못 한 지표는 value 가 null 로 남음', async () => {
  const m = metric({ value: null, display: null, lastSuccessAt: null });
  await refreshMetric(new Store(), m, { fetcher: fakeFetcher({ [NPM]: new Error('boom') }), now: T2 });
  assert.equal(m.value, null);
});

test('refreshAll: 하나가 실패해도 나머지는 계속 수집, 미승인/자가 입력은 건드리지 않음', async () => {
  const store = new Store();
  store.add(service({ id: 'a', metrics: [metric({ id: '1', sourceUrl: 'https://www.npmjs.com/package/bad' }), metric({ id: '2' }), { id: '3', kind: 'self_visitors', level: 'self', value: 5 }] }));
  store.add(service({ id: 'b', status: 'pending', metrics: [metric({ id: '4' })] }));
  const f = fakeFetcher({ [NPM]: { status: 200, body: '{"downloads": 1000}' }, 'https://api.npmjs.org/downloads/point/last-week/bad': new Error('boom') });
  const r = await refreshAll(store, { fetcher: f, delayMs: 0, now: T2 });
  assert.deepEqual(r, { ok: 1, failed: 1 });
  assert.equal(store.get('a').metrics[1].value, 1000);
  assert.equal(store.get('b').metrics[0].value, 500); // 미승인: 수집 안 함
  assert.equal(f.calls.length, 2);
});
