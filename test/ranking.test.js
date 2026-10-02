import test from 'node:test';
import assert from 'node:assert/strict';
import { rankServices, serviceScore } from '../src/ranking.js';
import { service } from './helpers.js';

const auto = (kind, value) => ({ id: kind, kind, level: 'auto', value });
const self = (kind, value) => ({ id: kind, kind, level: 'self', value });

test('자가 입력은 같은 값이어도 자동 확인보다 점수가 낮다', () => {
  assert.ok(serviceScore(service({ metrics: [auto('npm_weekly', 1000)] })) > serviceScore(service({ metrics: [self('self_visitors', 1000)] })));
});

test('자가 입력을 부풀려도 자동 확인 지표 서비스를 쉽게 앞지르지 못한다', () => {
  const a = service({ id: 'a', metrics: [auto('github_stars', 500)] });
  const b = service({ id: 'b', metrics: [self('self_visitors', 100000)] });
  assert.equal(rankServices([b, a])[0].service.id, 'a');
});

test('소유자 인증 서비스가 가산된다', () => {
  const m = [auto('github_stars', 100)];
  assert.ok(serviceScore(service({ metrics: m, ownerVerifiedAt: 'x' })) > serviceScore(service({ metrics: m })));
});

test('지표별 정렬, 미승인 제외, 값 없는 지표 제외', () => {
  const a = service({ id: 'a', metrics: [auto('github_stars', 10)] });
  const b = service({ id: 'b', metrics: [auto('github_stars', 99)] });
  const c = service({ id: 'c', status: 'pending', metrics: [auto('github_stars', 9999)] });
  const d = service({ id: 'd', metrics: [auto('github_stars', null)] });
  assert.deepEqual(rankServices([a, b, c, d], { sort: 'github_stars' }).map((r) => r.service.id), ['b', 'a']);
  assert.deepEqual(rankServices([a, b, c, d], { sort: 'score' }).map((r) => r.service.id).slice(0, 2), ['b', 'a']);
});

test('카테고리 필터', () => {
  const a = service({ id: 'a', category: '게임' });
  const b = service({ id: 'b', category: '기타' });
  assert.deepEqual(rankServices([a, b], { category: '게임' }).map((r) => r.service.id), ['a']);
});
