// 소유권 인증: 서비스별 고유 토큰을 사이트에 올리게 하고 서버가 가져와 일치 확인.
//  방법 1) {origin}/verify-<토큰>.txt  (내용 = 토큰 그대로)
//  방법 2) 등록 URL 페이지의 <meta name="makerboard-verify" content="<토큰>">
import crypto from 'node:crypto';
import { sameSite } from './ssrf.js';

export const META_NAME = 'makerboard-verify';

export const newToken = () => `mb-${crypto.randomBytes(12).toString('hex')}`;
export const verifyFilePath = (token) => `/verify-${token}.txt`;
export const metaTagFor = (token) => `<meta name="${META_NAME}" content="${token}">`;

function findMeta(html, token) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
    }
    if (attrs.name && attrs.name.toLowerCase() === META_NAME && attrs.content === token) return true;
  }
  return false;
}

async function tryFetch(fetcher, url, baseUrl, opts) {
  try {
    const res = await fetcher(url, opts);
    if (res.finalUrl && !sameSite(baseUrl, res.finalUrl)) return { error: '다른 사이트로 이동되어 확인할 수 없습니다.' };
    if (res.status !== 200) return { error: `HTTP ${res.status}` };
    return { body: String(res.body || '') };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e).slice(0, 120) };
  }
}

// 절대 throw 하지 않음 → { ok, method?, reason? }
export async function verifyOwnership(service, fetcher) {
  let origin;
  try {
    origin = new URL(service.url).origin;
  } catch {
    return { ok: false, reason: '등록된 URL 이 올바르지 않습니다.' };
  }
  const token = service.verifyToken;
  const opts = { maxBytes: 300_000 };

  const file = await tryFetch(fetcher, `${origin}${verifyFilePath(token)}`, service.url, opts);
  // 내용이 "토큰과 정확히 일치"해야 함 (404 페이지가 주소를 되풀이해 보여주는 경우의 오인증 방지)
  if (file.body !== undefined && file.body.replace(/^﻿/, '').trim() === token) return { ok: true, method: 'file' };

  const page = await tryFetch(fetcher, service.url, service.url, opts);
  if (page.body !== undefined && findMeta(page.body, token)) return { ok: true, method: 'meta' };

  const why = [file.error && `파일: ${file.error}`, file.body !== undefined && '파일 내용이 토큰과 다릅니다', page.error && `메타태그: ${page.error}`, page.body !== undefined && '메타태그를 찾지 못했습니다']
    .filter(Boolean)
    .join(' / ');
  return { ok: false, reason: why || '확인하지 못했습니다.' };
}
