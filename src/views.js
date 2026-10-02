// 서버 렌더링 HTML. html`` 템플릿은 값을 기본으로 이스케이프합니다(XSS 방지).
import { AUTO_KINDS, SELF_KINDS, ALL_KINDS, CATEGORIES, LEVEL_LABELS } from './kinds.js';
import { isVerified } from './ranking.js';
import { metaTagFor, verifyFilePath } from './verify.js';

const RAW = Symbol('raw');
export const raw = (s) => ({ [RAW]: String(s) });
export function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function render(v) {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return v.map(render).join('');
  if (typeof v === 'object' && RAW in v) return v[RAW];
  return esc(v);
}
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    out += render(v) + strings[i + 1];
  });
  return raw(out);
}

export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16) : '-');

export function layout(config, title, body) {
  return render(html`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · ${config.siteName}</title><link rel="stylesheet" href="/style.css"></head>
<body><header><a class="brand" href="/">${config.siteName}</a>
<nav><a href="/">순위표</a><a href="/register">메이커 등록</a><a href="/privacy">개인정보 처리방침</a></nav></header>
<main>${body}</main>
<footer>지표는 각 단계 배지로 신뢰 수준을 구분합니다. · <a href="/privacy">개인정보 처리방침</a></footer></body></html>`);
}

const badge = (level) => html`<span class="badge ${level}">${LEVEL_LABELS[level]}</span>`;

function metricItem(m) {
  const kind = ALL_KINDS[m.kind];
  const never = m.value == null;
  return html`<li><span class="mlabel">${kind ? kind.label : m.kind}</span>
<strong>${never ? '–' : m.display}</strong> ${badge(m.level)}
<small class="muted">${never ? '수집 대기 중' : `${m.level === 'self' ? '입력' : '갱신'} ${fmtTime(m.lastSuccessAt || m.updatedAt)}`}</small>
${m.lastError ? html`<small class="warn">최근 수집 실패 — ${never ? '아직 성공한 값이 없습니다' : '마지막 성공값을 표시 중'} (시도 ${fmtTime(m.lastAttemptAt)})</small>` : ''}</li>`;
}

const SORTS = [['score', '종합'], ...Object.entries(AUTO_KINDS).map(([k, v]) => [k, v.label]), ...Object.entries(SELF_KINDS).map(([k, v]) => [k, `${v.label}(자가)`])];

export function boardPage(config, rows, { sort, category }) {
  const qs = (o) => {
    const p = new URLSearchParams();
    const next = { sort, category, ...o };
    if (next.sort !== 'score') p.set('sort', next.sort);
    if (next.category) p.set('category', next.category);
    return p.size ? `/?${p}` : '/';
  };
  return layout(config, '순위표', html`
<h1>검증 지표 순위표</h1>
<p class="muted">한국 인디 메이커의 공개 지표 순위입니다. <b>자동 확인</b>은 서버가 공개 페이지에서 직접 읽은 값, <b>소유자 인증</b>은 사이트 소유권을 확인한 서비스, <b>자가 입력</b>은 메이커가 직접 적은 값(순위 가중치 낮음)입니다.</p>
<div class="tabs">${SORTS.map(([k, label]) => html`<a class="${k === sort ? 'on' : ''}" href="${qs({ sort: k })}">${label}</a>`)}</div>
<div class="tabs sub"><a class="${category ? '' : 'on'}" href="${qs({ category: '' })}">전체</a>${CATEGORIES.map((c) => html`<a class="${c === category ? 'on' : ''}" href="${qs({ category: c })}">${c}</a>`)}</div>
${rows.length === 0 ? html`<p class="empty">아직 표시할 서비스가 없습니다.</p>` : html`
<table><thead><tr><th>#</th><th>서비스</th><th>지표</th></tr></thead><tbody>
${rows.map((r, i) => html`<tr><td class="rank">${i + 1}</td>
<td><a href="${r.service.url}" rel="nofollow noopener ugc" target="_blank">${r.service.name}</a>
${isVerified(r.service) ? badge('owner') : html`<span class="badge none">미인증</span>`}<br><small class="muted">${r.service.category}</small></td>
<td>${r.service.metrics.length ? html`<ul class="metrics">${r.service.metrics.map(metricItem)}</ul>` : html`<span class="muted">등록된 지표 없음</span>`}</td></tr>`)}
</tbody></table>`}`);
}

export function registerPage(config, { error, values = {} } = {}) {
  return layout(config, '메이커 등록', html`
<h1>메이커 등록</h1>
${error ? html`<p class="error">${error}</p>` : ''}
<form method="post" action="/register" class="card">
<label>서비스명<input name="name" maxlength="40" required value="${values.name || ''}"></label>
<label>서비스 URL<input name="url" type="url" maxlength="200" required placeholder="https://example.com" value="${values.url || ''}"></label>
<label>카테고리<select name="category">${CATEGORIES.map((c) => html`<option ${values.category === c ? raw('selected') : ''}>${c}</option>`)}</select></label>
<label>이메일 (공개되지 않으며 운영자 연락용으로만 사용)<input name="email" type="email" maxlength="100" required value="${values.email || ''}"></label>
<label class="check"><input type="checkbox" name="consent" value="1" required> <a href="/privacy" target="_blank">개인정보 처리방침</a>에 동의합니다.</label>
<button>등록 신청</button></form>
<p class="muted">신청 후 운영자 승인을 거쳐 순위표에 표시됩니다.</p>`);
}

export function registeredPage(config, manageUrl) {
  return layout(config, '등록 신청 완료', html`
<h1>등록 신청이 접수되었습니다</h1>
<div class="card"><p><b>아래 관리 주소는 이 화면에서만 보여드립니다.</b> 비밀번호 역할을 하므로 북마크하고 공유하지 마세요. 이 주소로 소유권 인증과 지표 등록을 합니다. 분실 시 운영자에게 문의해야 합니다.</p>
<p><a href="${manageUrl}">${manageUrl}</a></p></div>`);
}

export function managePage(config, s, { key, msg, error } = {}) {
  const token = s.verifyToken;
  const origin = new URL(s.url).origin;
  const base = `/manage/${key}`;
  return layout(config, `${s.name} 관리`, html`
<h1>${s.name} 관리</h1>
${msg ? html`<p class="ok">${msg}</p>` : ''}${error ? html`<p class="error">${error}</p>` : ''}
<p>상태: ${s.status === 'approved' ? '승인됨(순위표 표시 중)' : '승인 대기 중 (승인 후 순위표에 표시되고 자동 수집이 시작됩니다)'}</p>

<h2>1. 소유자 인증 ${isVerified(s) ? badge('owner') : ''}</h2>
${isVerified(s) ? html`<p>${fmtTime(s.ownerVerifiedAt)} 에 인증되었습니다.</p>` : html`
<p>둘 중 <b>하나</b>만 하면 됩니다.</p>
<p><b>방법 A. 파일</b> — 아래 주소에 파일이 열리고, 내용이 토큰 한 줄뿐이어야 합니다.<br><code>${origin}${verifyFilePath(token)}</code><br>파일 내용: <code>${token}</code></p>
<p><b>방법 B. 메타 태그</b> — ${s.url} 페이지의 &lt;head&gt; 안에 추가:<br><code>${metaTagFor(token)}</code></p>
<form method="post" action="${base}/verify"><button>인증 확인</button></form>`}

<h2>2. 지표</h2>
${s.metrics.length ? html`<ul class="metrics">${s.metrics.map((m) => html`<li>${metricItem(m)}
<form method="post" action="${base}/metrics/${m.id}/delete" class="inline"><button class="link">삭제</button></form>
${m.sourceUrl ? html`<br><small class="muted">출처: ${m.sourceUrl}</small>` : ''}</li>`)}</ul>` : html`<p class="muted">아직 없습니다.</p>`}

<h3>공개 지표 자동 수집 추가</h3>
<form method="post" action="${base}/metrics" class="card"><input type="hidden" name="type" value="auto">
<label>지표<select name="kind">${Object.entries(AUTO_KINDS).map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}</select></label>
<label>해당 페이지 URL<input name="sourceUrl" required placeholder="스토어/저장소 주소"></label>
<button>추가</button></form>
<p class="muted">입력한 URL 에서 식별자(확장 ID, 패키지명 등)만 읽어 공식 공개 페이지/API 를 조회합니다. 수집 실패 시 마지막 성공값이 유지됩니다.</p>

<h3>자가 입력 지표 (배지: 자가 입력, 순위 가중치 낮음)</h3>
<form method="post" action="${base}/metrics" class="card"><input type="hidden" name="type" value="self">
<label>지표<select name="kind">${Object.entries(SELF_KINDS).map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}</select></label>
<label>값(숫자)<input name="value" inputmode="numeric" required></label>
<button>저장</button></form>`);
}

export function privacyPage(config) {
  return layout(config, '개인정보 처리방침', html`
<h1>개인정보 처리방침</h1>
<p class="muted">※ 초안 템플릿입니다. 운영 전 운영자 정보를 채우고 필요 시 전문가 검토를 받으세요.</p>
<h2>1. 수집하는 개인정보</h2><p>메이커 등록 시 <b>이메일 주소</b> 하나만 수집합니다. 서비스명·URL·카테고리는 서비스 정보이며 순위표에 공개됩니다. 이메일은 공개되지 않습니다.</p>
<h2>2. 이용 목적</h2><p>등록 승인 여부 안내, 운영 문의 및 분쟁 대응에만 사용합니다. 광고·마케팅 목적으로 사용하지 않습니다.</p>
<h2>3. 보유 및 이용 기간</h2><p>등록 삭제 요청 시 또는 서비스 운영 종료 시까지 보관하며, 이후 지체 없이 파기합니다.</p>
<h2>4. 제3자 제공 및 위탁</h2><p>제3자에게 제공하지 않습니다. 서비스 구동을 위해 호스팅 사업자의 서버에 저장될 수 있습니다.</p>
<h2>5. 자동 수집 장치</h2><p>쿠키·분석 도구·광고 추적을 사용하지 않습니다. 접속 로그(IP 등)는 호스팅 사업자가 보안 목적으로 일시 기록할 수 있습니다.</p>
<h2>6. 이용자의 권리</h2><p>언제든 열람·정정·삭제를 요청할 수 있습니다.</p>
<h2>7. 문의</h2><p>${config.contactEmail ? config.contactEmail : '(운영자 연락처를 CONTACT_EMAIL 환경변수로 설정하세요)'}</p>`);
}

export function messagePage(config, title, text) {
  return layout(config, title, html`<h1>${title}</h1><p>${text}</p>`);
}

export function adminPage(config, services, csrf, msg) {
  const form = (action, id, label, cls = '') => html`<form method="post" action="/admin/${action}/${id}" class="inline"><input type="hidden" name="csrf" value="${csrf}"><button class="${cls}">${label}</button></form>`;
  const row = (s) => html`<tr><td>${s.name}<br><small><a href="${s.url}" rel="nofollow noopener" target="_blank">${s.url}</a></small></td>
<td>${s.category}<br><small>${s.email}</small></td><td>${fmtTime(s.createdAt)}</td><td>${isVerified(s) ? '소유자 인증' : '미인증'}</td><td>${s.metrics.length}</td>
<td>${s.status === 'pending' ? form('approve', s.id, '승인') : form('unapprove', s.id, '승인 취소')} ${form('recollect', s.id, '지금 수집')} ${form('delete', s.id, '삭제', 'danger')}</td></tr>`;
  const table = (list) => (list.length ? html`<table><thead><tr><th>서비스</th><th>카테고리/이메일</th><th>등록</th><th>인증</th><th>지표</th><th></th></tr></thead><tbody>${list.map(row)}</tbody></table>` : html`<p class="muted">없음</p>`);
  return layout(config, '관리자', html`<h1>관리자</h1>${msg ? html`<p class="ok">${msg}</p>` : ''}
<h2>승인 대기 (${services.filter((s) => s.status === 'pending').length})</h2>${table(services.filter((s) => s.status === 'pending'))}
<h2>승인됨 (${services.filter((s) => s.status === 'approved').length})</h2>${table(services.filter((s) => s.status === 'approved'))}
<p><a href="/admin/export.json">데이터 백업 내려받기(JSON, 이메일 포함)</a></p>`);
}

export const CSS = `
:root{--bg:#fafafa;--fg:#1c1c1e;--muted:#6b7280;--line:#e5e7eb;--card:#fff;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#111214;--fg:#eee;--muted:#9aa0a6;--line:#2a2c30;--card:#1a1c1f;--accent:#7aa2ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
header,footer,main{max-width:960px;margin:0 auto;padding:12px 16px}header{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line)}
.brand{font-weight:700;font-size:1.2rem;text-decoration:none;color:var(--fg)}nav a{margin-left:14px}a{color:var(--accent)}
footer{color:var(--muted);font-size:.85rem;border-top:1px solid var(--line);margin-top:32px}
.muted,small{color:var(--muted)}small{font-size:.8rem}.warn{color:#b45309;display:block}.error{color:#b91c1c}.ok{color:#15803d}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}.rank{font-weight:700;width:2.5em}
.metrics{list-style:none;margin:0;padding:0}.metrics li{margin-bottom:6px}.mlabel{color:var(--muted);margin-right:6px}
.badge{display:inline-block;font-size:.72rem;padding:1px 8px;border-radius:99px;border:1px solid;white-space:nowrap}
.badge.auto{color:#047857;border-color:#047857}.badge.owner{color:#1d4ed8;border-color:#1d4ed8}.badge.self{color:#6b7280;border-color:#6b7280;border-style:dashed}.badge.none{color:var(--muted);border-color:var(--line)}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.tabs a{padding:4px 12px;border:1px solid var(--line);border-radius:99px;text-decoration:none;font-size:.9rem}.tabs a.on{background:var(--accent);color:#fff;border-color:var(--accent)}.tabs.sub a{font-size:.8rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
label{display:block;margin-bottom:12px;font-size:.9rem}input,select{display:block;width:100%;padding:8px;margin-top:4px;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:6px}
label.check input{display:inline;width:auto}button{font:inherit;padding:8px 16px;border:0;border-radius:6px;background:var(--accent);color:#fff;cursor:pointer}
button.link{background:none;color:var(--accent);padding:0;text-decoration:underline}button.danger{background:#b91c1c}form.inline{display:inline}
code{background:var(--card);border:1px solid var(--line);padding:1px 6px;border-radius:4px;word-break:break-all}.empty{padding:40px 0;text-align:center;color:var(--muted)}
@media (max-width:600px){header{flex-direction:column;align-items:flex-start}nav a{margin:0 14px 0 0}}
`;
