const configuration = await fetch('/tests/deadline-scenarios.json').then(response => response.json());
// Fix the calendar date while retaining elapsed time for the real loader's
// timeout. Expected membership below is declared by the fixture, not computed
// using the production parser or production filtering functions.
Date.now = () => configuration.fixedNow + performance.now();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const waitUntil = async (condition, timeout = 26000) => {
  const deadline = performance.now() + timeout;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert(condition(), '読み込みの完了を待つ');
};
const element = (tag, text) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  return node;
};
const results = [];
let transactions = 0;
const selectedId = new URLSearchParams(location.search).get('case');
const scenarios = configuration.scenarios.filter(scenario => !selectedId || scenario.id === selectedId);

function expectedMaterials(scenario) {
  const byKey = new Map();
  for (const course of scenario.courses) {
    if (!course.enrolled || course.absent) continue;
    for (const table of course.tables) {
      if (table.delay < 0) continue;
      for (const row of table.rows) {
        if (!row.include) continue;
        const key = `${course.id}:${row.title}:${row.deadline}`;
        byKey.set(key, {
          title: row.title, courseName: course.name, deadline: row.deadline,
          href: new URL(row.expectedHref || course.href, location.href).href
        });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.deadline - b.deadline || a.courseName.localeCompare(b.courseName, 'ja') || a.title.localeCompare(b.title, 'ja'));
}

for (const scenario of scenarios) {
  let repetitions = 0;
  try {
    WCV_DEADLINES.destroy();
    document.getElementById('fixture').replaceChildren();
    globalThis.matrixScenario = scenario;
    globalThis.matrixLoad = 0;
    const row = element('div');
    row.className = 'row';
    const sidebar = element('aside');
    sidebar.className = 'col-sm-3';
    if (!scenario.noDashboard) {
      const dashboard = element('a', '課題実施状況一覧');
      dashboard.href = `/webclass/ip_mods.php/plugin/score_summary_table/dashboard?matrix=${scenario.id}`;
      sidebar.append(dashboard);
    }
    const main = element('div');
    main.className = 'col-sm-9';
    if (!scenario.noSchedule) {
      const schedule = element('table');
      schedule.id = 'schedule-table';
      const cell = schedule.insertRow().insertCell();
      for (const course of scenario.courses.filter(course => course.enrolled)) {
        for (let index = 0; index < (scenario.duplicateLinks ? 2 : 1); index++) {
          const anchor = element('a', course.name);
          anchor.href = course.href;
          cell.append(anchor, document.createTextNode(' '));
        }
      }
      // A foreign-origin course link must not alter the target enrollment.
      const foreign = element('a', '外部サイトの同名科目');
      foreign.href = 'https://example.invalid/webclass/course.php/26foreign/login';
      cell.append(foreign);
      main.append(schedule);
    }
    row.append(sidebar, main);
    document.getElementById('fixture').append(row);
    const enrolled = scenario.courses.filter(course => course.enrolled);
    const shouldExist = !scenario.disabled && !scenario.noDashboard && !scenario.noSchedule && enrolled.length > 0;
    WCV_DEADLINES.sync({ enabled: true, showDeadlineList: !scenario.disabled });
    if (!shouldExist) {
      assert(!document.getElementById('wcv-deadlines') && !document.querySelector('iframe'), '対象外の画面・設定ではパネルも取得フレームも作らない');
    } else {
      const expected = expectedMaterials(scenario);
      for (let repetition = 0; repetition < scenario.repeats; repetition++) {
        if (repetition) document.querySelector('.wcv-deadline-refresh').click();
        await waitUntil(() => document.querySelector('.wcv-deadline-refresh')?.disabled === false);
        repetitions++;
        transactions++;
        assert(!document.querySelector('iframe'), '完了後に取得フレームを残さない');
        const actual = [...document.querySelectorAll('.wcv-deadline-item')].map(item => ({
          title: item.querySelector('.wcv-deadline-title').textContent,
          courseName: item.querySelector('.wcv-deadline-course').textContent,
          deadline: Date.parse(item.querySelector('time').dateTime),
          href: item.querySelector('.wcv-deadline-open').href
        }));
        assert(JSON.stringify(actual) === JSON.stringify(expected), `教材の欠落・混入・科目・締切順・リンクを検証（期待${expected.length}件／実際${actual.length}件）\n期待: ${JSON.stringify(expected)}\n実際: ${JSON.stringify(actual)}`);
        assert(document.querySelector('.wcv-deadline-count').textContent === `${expected.length}件`, '件数が実際の表示と一致');
        const panel = document.getElementById('wcv-deadlines');
        assert(!panel.textContent.includes('架空の成績') && !panel.querySelector('img'), '成績情報とHTMLとしての教材名を出力しない');
        const diagnostics = panel.querySelector('.wcv-deadline-diagnostics');
        diagnostics.open = true;
        await waitUntil(() => panel.querySelectorAll('.wcv-deadline-diagnostic-course').length === enrolled.length);
        for (const course of enrolled) {
          const section = [...panel.querySelectorAll('.wcv-deadline-diagnostic-course')].find(node => node.dataset.courseId === course.id.toLowerCase());
          assert(section, `${course.name}の診断が存在する`);
          const incomplete = course.absent || course.tables.some(table => table.delay < 0);
          if (incomplete) assert(!section.textContent.includes('教材行・教材なしの表示を確認済み'), '未読込の科目を取得済みと表示しない');
        }
        const hasIncomplete = enrolled.some(course => course.absent || course.tables.some(table => table.delay < 0));
        const status = panel.querySelector('.wcv-deadline-status').textContent;
        assert(hasIncomplete ? /確認でき|取得でき/.test(status) : status.includes(`${enrolled.length}科目中${enrolled.length}科目`), '完全取得と未取得を区別');
      }
    }
    results.push({ id: scenario.id, label: scenario.label, passed: true, enrolled: enrolled.length, repetitions });
  } catch (error) {
    results.push({ id: scenario.id, label: scenario.label, passed: false, repetitions, error: error.message });
  }
  document.getElementById('results').append(element('li', `${results.at(-1).passed ? 'PASS' : 'FAIL'}: ${scenario.label}${results.at(-1).error ? ' — ' + results.at(-1).error : ''}`));
}
WCV_DEADLINES.destroy();
const failed = results.filter(result => !result.passed);
const report = { scenarios: results.length, passed: results.length - failed.length, failed: failed.length, transactions, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, source: configuration.source, results };
const artifact = element('script', JSON.stringify(report));
artifact.id = 'matrix-report';
artifact.type = 'application/json';
document.body.append(artifact);
document.body.dataset.testStatus = failed.length ? 'failed' : 'passed';
document.getElementById('test-result').textContent = `${failed.length ? 'FAIL' : 'PASS'}: ${report.passed}/${report.scenarios}パターン・${transactions}回の取得`;
