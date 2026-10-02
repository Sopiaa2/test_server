// SSRF 방어가 적용된 외부 URL 가져오기.
// - http/https 만, 포트 80/443 만, URL 내 계정정보 금지
// - localhost / 내부 IP / 링크로컬 / 메타데이터 IP 차단 (IPv4·IPv6·매핑 주소 포함)
// - DNS 조회 결과를 "연결 시점"에 검사 (DNS 리바인딩 방지)
// - 리디렉션은 매 단계 재검사, 같은 사이트(www 제외) 안에서만 허용
// - 타임아웃, 응답 크기 상한
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';

export class FetchBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FetchBlockedError';
  }
}

const V4_BLOCKS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4ToInt(ip) {
  return ip.split('.').reduce((acc, p) => ((acc << 8) | Number(p)) >>> 0, 0) >>> 0;
}

function isBlockedV4Int(n) {
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((v4ToInt(base) & mask) >>> 0);
  });
}

// IPv6 문자열 → 16비트 8개. 실패하면 null.
function parseV6(ip) {
  let s = ip;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!net.isIPv4(tail)) return null;
    const n = v4ToInt(tail);
    s = `${s.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

export function isBlockedIp(ip) {
  if (net.isIPv4(ip)) return isBlockedV4Int(v4ToInt(ip));
  if (!net.isIPv6(ip) || ip.includes('%')) return true; // 모르면 차단
  const g = parseV6(ip);
  if (!g) return true;
  const embeddedV4 = (hi, lo) => isBlockedV4Int(((g[hi] << 16) | g[lo]) >>> 0);
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::/96 (::, ::1, v4 호환)
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embeddedV4(6, 7); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] !== 0 || embeddedV4(6, 7); // NAT64
  if (g[0] === 0x2002) return embeddedV4(1, 2); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return true; // 문서용, teredo
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard
  return false;
}

export function isBlockedHostname(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/\.(local|internal|localdomain|home\.arpa|lan|intranet)$/.test(h)) return true;
  if (!h.includes('.') && !net.isIP(h)) return true; // 점 없는 내부용 이름
  return false;
}

const stripWww = (h) => h.toLowerCase().replace(/^www\./, '');
export const sameSite = (a, b) => stripWww(new URL(a).hostname) === stripWww(new URL(b).hostname);

// 문자열 → 검증된 URL 객체. 실패하면 FetchBlockedError.
export function assertFetchableUrl(raw, { blockCheck = isBlockedIp, allowedPorts = [80, 443] } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchBlockedError('URL 형식이 올바르지 않습니다.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchBlockedError('http/https 주소만 사용할 수 있습니다.');
  }
  if (url.username || url.password) throw new FetchBlockedError('주소에 계정 정보를 넣을 수 없습니다.');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!allowedPorts.includes(port)) throw new FetchBlockedError('허용되지 않는 포트입니다.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (blockCheck(host)) throw new FetchBlockedError('내부/예약 IP 주소는 사용할 수 없습니다.');
  } else if (isBlockedHostname(host)) {
    throw new FetchBlockedError('내부용 호스트 이름은 사용할 수 없습니다.');
  }
  return url;
}

function guardedLookup(blockCheck) {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!addrs.length) return cb(new Error('DNS 결과 없음'));
      if (addrs.some((a) => blockCheck(a.address))) {
        return cb(new FetchBlockedError('내부/예약 IP 로 연결되는 주소는 사용할 수 없습니다.'));
      }
      return options && options.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

function requestOnce(url, { timeoutMs, maxBytes, headers, blockCheck }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: {
          'user-agent': 'MakerBoardBot/0.1 (+ownership-verification)',
          'accept-encoding': 'gzip, deflate, br',
          ...headers,
        },
        lookup: guardedLookup(blockCheck),
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return finish(resolve, { status, headers: res.headers, body: '', location: res.headers.location });
        }
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        const chunks = [];
        let size = 0;
        const done = (truncated) => {
          res.destroy();
          finish(resolve, { status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), truncated });
        };
        stream.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            chunks.push(c.subarray(0, c.length - (size - maxBytes)));
            done(true);
          } else chunks.push(c);
        });
        stream.on('end', () => done(false));
        stream.on('error', (e) => finish(reject, e));
        res.on('error', (e) => finish(reject, e));
      },
    );
    const timer = setTimeout(() => {
      const e = new Error('요청 시간이 초과되었습니다.');
      finish(reject, e);
      req.destroy(e);
    }, timeoutMs);
    req.on('error', (e) => finish(reject, e));
    req.end();
  });
}

export async function safeFetch(rawUrl, opts = {}) {
  const {
    timeoutMs = 5000,
    maxBytes = 1_000_000,
    maxRedirects = 3,
    headers = {},
    blockCheck = isBlockedIp, // 테스트에서만 교체
    allowedPorts = [80, 443], // 테스트에서만 교체
  } = opts;
  const deadline = Date.now() + timeoutMs;
  let url = assertFetchableUrl(rawUrl, { blockCheck, allowedPorts });
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('요청 시간이 초과되었습니다.');
    const res = await requestOnce(url, { timeoutMs: remaining, maxBytes, headers, blockCheck });
    if (res.location) {
      const next = assertFetchableUrl(new URL(res.location, url).href, { blockCheck, allowedPorts });
      if (!sameSite(url.href, next.href)) throw new FetchBlockedError('다른 사이트로의 리디렉션은 허용되지 않습니다.');
      url = next;
      continue;
    }
    return { status: res.status, headers: res.headers, body: res.body, truncated: !!res.truncated, finalUrl: url.href };
  }
  throw new Error('리디렉션이 너무 많습니다.');
}
