// 가짜 fetcher: { url: {status, body} | Error | (url)=>res } 맵으로 응답을 지정. 실제 네트워크는 쓰지 않음.
export function fakeFetcher(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push(url);
    const r = routes[url];
    if (r === undefined) return { status: 404, body: 'not found', finalUrl: url };
    if (r instanceof Error) throw r;
    const res = typeof r === 'function' ? r(url, opts) : r;
    return { finalUrl: url, ...res };
  };
  fn.calls = calls;
  return fn;
}
export const service = (over = {}) => ({
  id: 's1', name: 'Test', url: 'https://example.com/app', category: '웹 서비스', email: 'a@b.co',
  status: 'approved', createdAt: '2026-01-01T00:00:00.000Z', verifyToken: 'mb-abc123', ownerVerifiedAt: null, metrics: [], ...over,
});
