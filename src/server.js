import http from 'node:http';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { createApp } from './app.js';
import { safeFetch } from './ssrf.js';
import { refreshAll } from './metrics.js';

const config = loadConfig();
const store = new Store(path.join(config.dataDir, 'data.json'));
const { handler } = createApp({ store, config, fetcher: safeFetch });

// 예기치 못한 오류로 서버가 죽지 않도록
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

const server = http.createServer(handler);
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(config.port, () => {
  console.log(`listening on :${config.port}`);
  if (!config.adminPassword) console.warn('ADMIN_PASSWORD 가 설정되지 않아 관리자 화면이 비활성화되어 있습니다.');
});

// 주기적 자동 수집 (겹쳐 실행되지 않도록 보호)
let running = false;
async function collect() {
  if (running) return;
  running = true;
  try {
    const r = await refreshAll(store, { fetcher: safeFetch, githubToken: config.githubToken });
    console.log(`[collect] 성공 ${r.ok} / 실패 ${r.failed}`);
  } catch (e) {
    console.error('[collect]', e);
  } finally {
    running = false;
  }
}
setTimeout(collect, 30_000);
setInterval(collect, config.collectIntervalHours * 3_600_000);
