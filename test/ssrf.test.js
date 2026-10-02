import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isBlockedIp, fetchExternal, assertFetchableUrl, FetchBlockedError } from '../src/ssrf.js';

test('내부/예약 IP 는 차단 (IPv4)', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
});

test('공인 IP 는 허용', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isBlockedIp(ip), false, ip);
});

test('내부/예약 IP 는 차단 (IPv6, 매핑·변환 주소 포함)', () => {
  for (const ip of ['::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2002:7f00:0001::1', '2001:db8::1', '::127.0.0.1']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  assert.equal(isBlockedIp('::ffff:8.8.8.8'), false);
});

test('파싱 불가 값은 안전하게 차단', () => {
  assert.equal(isBlockedIp('not-an-ip'), true);
  assert.equal(isBlockedIp('fe80::1%eth0'), true);
});

test('위험한 URL 은 요청 전에 거부', async () => {
  const bad = [
    'http://localhost/', 'http://localhost:80/', 'http://foo.localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://[::ffff:127.0.0.1]/',
    'http://intranet/', 'http://printer.local/', 'http://metadata.internal/',
    'http://example.com:22/', 'http://example.com:8080/', 'ftp://example.com/', 'file:///etc/passwd', 'http://user:pw@example.com/', 'not a url',
  ];
  for (const u of bad) await assert.rejects(() => fetchExternal(u), FetchBlockedError, u);
});

test('정상 외부 URL 은 사전 검사를 통과', () => {
  assert.doesNotThrow(() => assertFetchableUrl('https://example.com/verify-x.txt'));
  assert.doesNotThrow(() => assertFetchableUrl('http://8.8.8.8/'));
});

// 로컬 서버를 대상으로 동작(타임아웃/크기/리디렉션) 검증 — 테스트에서만 차단 검사를 완화
const relaxed = { allowedPorts: [80, 443], blockCheck: () => false };
function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler).listen(0, '127.0.0.1', async () => {
      try {
        await fn(srv.address().port);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        srv.closeAllConnections?.();
        srv.close();
      }
    });
  });
}

test('타임아웃: 응답이 없으면 지정 시간 안에 실패', async () => {
  await withServer(() => {}, async (port) => {
    const t = Date.now();
    await assert.rejects(() => fetchExternal(`http://127.0.0.1:${port}/`, { ...relaxed, allowedPorts: [port], timeoutMs: 300 }), /시간이 초과/);
    assert.ok(Date.now() - t < 2000);
  });
});

test('응답 크기 상한: 큰 응답은 잘라서 반환', async () => {
  await withServer((req, res) => res.end('x'.repeat(100_000)), async (port) => {
    const r = await fetchExternal(`http://127.0.0.1:${port}/`, { ...relaxed, allowedPorts: [port], maxBytes: 1000 });
    assert.equal(r.body.length, 1000);
    assert.equal(r.truncated, true);
  });
});

test('같은 사이트 안의 리디렉션은 따라가고, 내부 IP 로의 리디렉션은 차단', async () => {
  await withServer((req, res) => {
    if (req.url === '/a') return res.writeHead(302, { location: '/b' }).end();
    if (req.url === '/evil') return res.writeHead(302, { location: 'http://169.254.169.254/latest' }).end();
    res.end('ok');
  }, async (port) => {
    const opts = { allowedPorts: [port], blockCheck: (ip) => ip !== '127.0.0.1' };
    const r = await fetchExternal(`http://127.0.0.1:${port}/a`, opts);
    assert.equal(r.body, 'ok');
    await assert.rejects(() => fetchExternal(`http://127.0.0.1:${port}/evil`, opts), FetchBlockedError);
  });
});

test('다른 사이트로의 리디렉션 차단', async () => {
  await withServer((req, res) => res.writeHead(302, { location: 'http://example.org/' }).end(), async (port) => {
    await assert.rejects(() => fetchExternal(`http://127.0.0.1:${port}/`, { ...relaxed, allowedPorts: [port, 80] }), /다른 사이트/);
  });
});
