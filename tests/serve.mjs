import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeadlineScenarios } from './fixtures/deadline-scenarios.mjs';

const files = new Map([
  ['/tests/enrollment.html', 'text/html; charset=utf-8'],
  ['/tests/deadlines.html', 'text/html; charset=utf-8'],
  ['/tests/deadline-matrix.html', 'text/html; charset=utf-8'],
  ['/tests/deadline-matrix.mjs', 'text/javascript; charset=utf-8'],
  ['/tests/fixtures/deadline-matrix-dashboard.mjs', 'text/javascript; charset=utf-8'],
  ['/src/deadlines.js', 'text/javascript; charset=utf-8'],
  ['/src/content.js', 'text/javascript; charset=utf-8'],
  ['/src/dataset.js', 'text/javascript; charset=utf-8'],
  ['/src/content.css', 'text/css; charset=utf-8'],
  ['/data/timetable-2026.json', 'application/json; charset=utf-8'],
  ['/data/timetable-2026-fall-supplement.json', 'application/json; charset=utf-8']
]);

export async function startTestServer(port = 8765) {
  const scenarios = await buildDeadlineScenarios();
  const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const pathname = url.pathname;
  if (pathname === '/tests/deadline-scenarios.json') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(scenarios));
    return;
  }
  if (pathname === '/webclass/course.php/26sba132209/login') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html lang="ja"><meta charset="utf-8"><title>コース移動テスト</title><h1>電磁気学基礎（移動先テスト）</h1><p>時間割の科目名リンクから移動できました。</p></html>');
    return;
  }
  if (pathname === '/webclass/ip_mods.php/plugin/score_summary_table/dashboard') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(url.searchParams.has('matrix')
      ? '<!doctype html><html lang="ja"><meta charset="utf-8"><body><script type="module" src="/tests/fixtures/deadline-matrix-dashboard.mjs"></script></body></html>'
      : await fs.readFile(new URL('./fixtures/deadline-dashboard.html', import.meta.url)));
    return;
  }
  const type = files.get(pathname);
  if (!type) {
    response.writeHead(404).end();
    return;
  }
  try {
    const data = await fs.readFile(new URL('..' + pathname, import.meta.url));
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(data);
  } catch {
    response.writeHead(500).end();
  }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startTestServer();
  console.log(`Browser tests: http://127.0.0.1:${server.address().port}/tests/deadline-matrix.html`);
}
