import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyOwnership, metaTagFor } from '../src/verify.js';
import { fakeFetcher, service } from './helpers.js';

const T = 'mb-abc123';
const FILE = `https://example.com/verify-${T}.txt`;
const PAGE = 'https://example.com/app';

test('인증 파일 내용이 토큰과 일치하면 성공', async () => {
  const r = await verifyOwnership(service(), fakeFetcher({ [FILE]: { status: 200, body: `${T}\n` } }));
  assert.deepEqual(r, { ok: true, method: 'file' });
});

test('BOM 이 붙은 파일도 허용', async () => {
  const r = await verifyOwnership(service(), fakeFetcher({ [FILE]: { status: 200, body: `﻿${T}` } }));
  assert.equal(r.ok, true);
});

test('파일 토큰이 다르면 실패', async () => {
  const r = await verifyOwnership(service(), fakeFetcher({ [FILE]: { status: 200, body: 'mb-other' } }));
  assert.equal(r.ok, false);
});

test('404 페이지가 주소(토큰)를 되풀이해도 오인증하지 않음', async () => {
  const echo = { status: 200, body: `<h1>Not found: /verify-${T}.txt</h1>` };
  const r = await verifyOwnership(service(), fakeFetcher({ [FILE]: echo }));
  assert.equal(r.ok, false);
});

test('메타 태그(속성 순서/따옴표 달라도) 로 성공', async () => {
  for (const tag of [metaTagFor(T), `<meta content='${T}' name='makerboard-verify'>`, `<META NAME=makerboard-verify CONTENT=${T} />`]) {
    const r = await verifyOwnership(service(), fakeFetcher({ [PAGE]: { status: 200, body: `<html><head>${tag}</head></html>` } }));
    assert.deepEqual(r, { ok: true, method: 'meta' }, tag);
  }
});

test('다른 토큰의 메타 태그는 실패', async () => {
  const r = await verifyOwnership(service(), fakeFetcher({ [PAGE]: { status: 200, body: metaTagFor('mb-zzz') } }));
  assert.equal(r.ok, false);
});

test('네트워크 오류/타임아웃이어도 throw 하지 않고 실패 사유 반환', async () => {
  const r = await verifyOwnership(service(), fakeFetcher({ [FILE]: new Error('요청 시간이 초과되었습니다.'), [PAGE]: new Error('ECONNREFUSED') }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /시간이 초과|ECONNREFUSED/);
});

test('다른 사이트로 리디렉션되면 거부', async () => {
  const r = await verifyOwnership(service(), fakeFetcher({ [FILE]: { status: 200, body: T, finalUrl: `https://evil.example.org/x.txt` } }));
  assert.equal(r.ok, false);
});

test('www 로의 리디렉션은 같은 사이트로 허용', async () => {
  const r = await verifyOwnership(service(), fakeFetcher({ [FILE]: { status: 200, body: T, finalUrl: `https://www.example.com/verify-${T}.txt` } }));
  assert.equal(r.ok, true);
});
