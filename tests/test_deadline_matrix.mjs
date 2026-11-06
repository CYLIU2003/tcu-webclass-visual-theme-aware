import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { startTestServer } from './serve.mjs';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const outputDirectory = path.join(workspace, 'tmp', 'deadline-matrix');
await fs.mkdir(outputDirectory, { recursive: true });
const profiles = await fs.mkdtemp(path.join(outputDirectory, 'profiles-'));
const exists = async candidate => candidate && await fs.access(candidate).then(() => true, () => false);
async function locate(candidates) {
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
}
const chrome = await locate([
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
]);
const edge = await locate([
  process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/microsoft-edge'
]);
const environments = [
  { id: 'chrome-desktop', executable: chrome, viewport: '1400,1000' },
  { id: 'chrome-mobile', executable: chrome, viewport: '390,844' },
  { id: 'edge-desktop', executable: edge, viewport: '1400,1000' }
].filter(environment => environment.executable);
const caseArgument = process.argv.indexOf('--case');
const selectedCase = caseArgument < 0 ? null : process.argv[caseArgument + 1];
if (caseArgument >= 0 && !selectedCase) throw new Error('--case requires a scenario ID');
if (!environments.length) throw new Error('Chrome/Edgeが見つかりません。CHROME_PATH または EDGE_PATH を設定してください。');
const server = await startTestServer(0);
const origin = `http://127.0.0.1:${server.address().port}`;
const summaries = [];

async function runPage(environment, page, suffix) {
  const profile = path.resolve(profiles, environment.id);
  const relative = path.relative(profiles, profile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Profile path is outside the test directory');
  const child = spawn(environment.executable, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    `--window-size=${environment.viewport}`, '--dump-dom', '--virtual-time-budget=900000',
    origin + page
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let html = '', errors = '', timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { html += data; });
  child.stderr.on('data', data => { errors += data; });
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  } finally { clearTimeout(timeout); }
  const prefix = path.join(outputDirectory, `${environment.id}-${suffix}`);
  await fs.writeFile(prefix + '.html', html);
  await fs.writeFile(prefix + '.log', errors);
  const status = html.match(/data-test-status="(.*?)"/)?.[1];
  const reportText = html.match(/<script[^>]*id="matrix-report"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  const report = reportText ? JSON.parse(reportText) : undefined;
  const result = { page, exitCode, timedOut, passed: exitCode === 0 && !timedOut && status === 'passed', report };
  await fs.writeFile(prefix + '.json', JSON.stringify(result, null, 2));
  return result;
}

try {
  for (const environment of environments) {
    console.log(`RUN ${environment.id} (${environment.viewport})`);
    const matrix = await runPage(environment, '/tests/deadline-matrix.html' + (selectedCase ? `?case=${encodeURIComponent(selectedCase)}` : ''), 'matrix');
    const existing = selectedCase ? [] : [
      await runPage(environment, '/tests/deadlines.html', 'regression'),
      await runPage(environment, '/tests/enrollment.html', 'enrollment')
    ];
    const passed = matrix.passed && existing.every(result => result.passed) && matrix.report?.scenarios > 0;
    const summary = { environment: environment.id, viewport: environment.viewport, executable: environment.executable, passed, matrix, existing };
    summaries.push(summary);
    console.log(`${passed ? 'PASS' : 'FAIL'} ${environment.id}: ${matrix.report?.passed ?? '?'}/${matrix.report?.scenarios ?? '?'} scenarios, ${matrix.report?.transactions ?? '?'} fetches`);
    for (const failure of matrix.report?.results.filter(result => !result.passed) || []) console.log(`  ${failure.id}: ${failure.error.slice(0, 500)}`);
  }
  const result = {
    completedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, node: process.version,
    deadlinesSourceSha256: createHash('sha256').update(await fs.readFile(path.join(workspace, 'src', 'deadlines.js'))).digest('hex'),
    selectedCase, passed: summaries.every(summary => summary.passed),
    unavailable: [!chrome && 'Chrome', !edge && 'Edge'].filter(Boolean), environments: summaries
  };
  await fs.writeFile(path.join(outputDirectory, 'results.json'), JSON.stringify(result, null, 2));
  console.log(`Results: ${path.join(outputDirectory, 'results.json')}`);
  if (!result.passed) process.exitCode = 1;
} finally {
  await new Promise(resolve => server.close(resolve));
  const target = path.resolve(profiles);
  const relative = path.relative(path.resolve(outputDirectory), target);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(target).startsWith('profiles-')) throw new Error('Refusing to remove an unexpected profile directory');
  await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
