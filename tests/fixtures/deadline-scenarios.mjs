import fs from 'node:fs/promises';

export const FIXED_NOW = Date.parse('2026-10-15T12:00:00+09:00');
const DAY = 86400000;
const format = timestamp => new Date(timestamp + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ');

function random(seed) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function shuffled(values, rng) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(rng() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function materials(course) {
  const row = (title, days, status, include, extra = {}) => {
    const deadline = days == null ? null : FIXED_NOW + days * DAY;
    return { title, deadline, rawDeadline: deadline == null ? '-' : format(deadline), status, include, ...extra };
  };
  return [
    row('レポート提出', 1, '未提出', true),
    row('予習問題', 2, '-', true, { executed: '2026-10-14 09:00', score: '100' }),
    row('回答済みの小テスト', 3, '回答済み', false),
    row('提出済みのレポート', 3, '提出済', false),
    row('期限切れの課題', -1, '-', false),
    row('7日より先の課題', 9, '-', false),
    row('締切未設定の教材', null, '-', false),
    row('日付が不正な教材', null, '-', false, { rawDeadline: '2026-02-30 23:59' }),
    row('再挑戦できる演習', 3, '不合格', true),
    row('7日目の課題', 7, '未回答', true),
    row('教材への直接リンク', 4, '-', true, {
      href: `/webclass/material.php?course=${course.id}&item=11`,
      expectedHref: `/webclass/material.php?course=${course.id}&item=11`
    }),
    row('別コースの授業評価アンケート (link)', 10, '-', false, {
      href: '/webclass/course.php/evaluation/login'
    })
  ];
}

export async function buildDeadlineScenarios() {
  const dataset = JSON.parse(await fs.readFile(new URL('../../data/timetable-2026.json', import.meta.url), 'utf8'));
  const groups = new Map();
  for (const course of dataset.courses) {
    for (const department of course.departments) {
      const key = `${course.level}/${department.sourceGroup}/${department.code}`;
      if (!groups.has(key)) groups.set(key, course);
    }
  }
  const selected = new Map([...groups.values()].map(course => [course.courseCode, course]));
  for (const course of dataset.courses.filter(course => course.level === '大学院').slice(0, 12)) selected.set(course.courseCode, course);
  for (const course of dataset.courses) {
    if (selected.size >= 80) break;
    selected.set(course.courseCode, course);
  }
  const pool = [...selected.values()].map(course => ({
    id: `26${course.courseCode}`, name: course.courseName, level: course.level,
    groups: course.departments.map(department => `${department.sourceGroup}/${department.label}`)
  }));
  const scenarios = [];
  function add(id, label, count, options = {}) {
    const rng = random(options.seed || scenarios.length + 31);
    const candidates = options.graduate ? pool.filter(course => course.level === '大学院') : pool;
    const courses = shuffled(candidates, rng).slice(0, count).map((course, index) => ({
      ...course, enrolled: true, href: `/webclass/course.php/${course.id}/login?lang=ja`,
      tables: [{ layout: options.layout || 'normal', delay: 200 + index * 130, rows: materials(course) }]
    }));
    // Previous-year and unenrolled courses must never enter the result.
    const other = { id: '26unregistered999', name: '未履修の模擬科目', enrolled: false };
    other.tables = [{ layout: 'normal', delay: 100, rows: materials(other) }];
    const previous = { id: courses[0]?.id.replace(/^26/, '25') || '25previous999', name: '前年度の模擬科目', enrolled: false };
    previous.tables = [{ layout: 'normal', delay: 100, rows: materials(previous) }];
    const scenario = { id, label, seed: options.seed || scenarios.length + 31, repeats: options.repeats || 1, courses: [...courses, other, previous], ...options };
    scenarios.push(scenario);
    return { scenario, courses, rng };
  }
  add('single', '別の科目を1科目履修', 1);
  const custom = add('unknown-code', '時間割データにないコースID', 1).courses[0];
  custom.id = '26custom-course-01';
  custom.name = 'データ未登録の模擬科目';
  custom.href = `/webclass/course.php/${custom.id}/login`;
  custom.tables[0].rows = materials(custom);
  add('seven', '学科をまたぐ7科目', 7, { repeats: 2 });
  add('graduate', '大学院の科目', 8, { graduate: true });
  add('thirty', '30科目の履修', 30);
  const sameName = add('same-name', '同名の別コースを区別', 3).courses;
  sameName[0].name = sameName[1].name = '同名の模擬科目';
  add('reordered', '締切・状態の列順が異なる表', 7, { layout: 'reordered' });
  add('multi-header', '複数の見出し行', 7, { layout: 'multi-header' });
  add('direct-rows', 'tbodyの外にある教材行', 7, { layout: 'direct-rows' });
  add('header-in-body', '見出しがtbodyにある表', 4, { layout: 'header-in-body' });
  const empty = add('some-empty', '教材なしの科目が混在', 7).courses;
  empty[1].tables[0].rows = [];
  empty[4].tables[0].rows = [];
  for (const course of add('all-empty', '全科目が教材なし', 3).courses) course.tables[0].rows = [];
  for (const course of add('busy', '読み込み中表示が後から解除', 5).courses) course.tables[0].busyUntil = 3500;
  add('skeleton', '空の表から5秒後に教材が到着', 7, { repeats: 2 }).courses.at(-1).tables[0].delay = 5000;
  add('near-timeout', '19秒後に教材が到着', 3).courses.at(-1).tables[0].delay = 19000;
  const partial = add('partial-timeout', '一部の科目が未読込のまま', 5).courses;
  partial[2].tables[0].delay = -1;
  for (const course of add('all-timeout', '全科目が未読込のまま', 3).courses) course.tables[0].delay = -1;
  const absent = add('missing-course', '課題実施状況に科目自体がない', 5).courses;
  absent[1].absent = true;
  const split = add('multiple-tables', '同じ科目の二つの表が時間差で到着', 5).courses;
  for (const course of split) {
    const rows = course.tables[0].rows;
    course.tables = [
      { layout: 'normal', delay: 200, rows: rows.slice(0, 5) },
      { layout: 'normal', delay: 4000, rows: rows.slice(5) }
    ];
  }
  const splitTimeout = add('multiple-tables-timeout', '同科目の片方の表が未読込・更新で重複させない', 3, { repeats: 2 }).courses;
  for (const course of splitTimeout) {
    const rows = course.tables[0].rows;
    course.tables = [
      { layout: 'normal', delay: 200, rows: rows.slice(0, 5) },
      { layout: 'normal', delay: -1, rows: rows.slice(5) }
    ];
  }
  const duplicates = add('duplicates', '時間割リンクと教材行が重複', 7).scenario;
  duplicates.duplicateLinks = true;
  for (const course of duplicates.courses) course.tables[0].rows.push({ ...course.tables[0].rows[0] });
  const multipleDue = add('same-title', '同じ教材名でも締切が異なる', 2).courses;
  for (const course of multipleDue) course.tables[0].rows[1].title = course.tables[0].rows[0].title;
  const unsafe = add('link-safety', '外部リンク・ハッシュ・送信系リンク', 2).courses[0];
  for (const href of ['https://example.invalid/task', '#details', 'javascript:alert(1)', '/webclass/submit.php']) {
    unsafe.tables[0].rows.push({ title: `リンク確認 ${href}`, deadline: FIXED_NOW + DAY, rawDeadline: format(FIXED_NOW + DAY), status: '-', include: true, href, expectedHref: unsafe.href });
  }
  const escaped = add('escaped', '記号を含む科目名・教材名', 1).courses[0];
  escaped.name = 'データ <解析> & "演習"';
  escaped.tables[0].rows[0].title = '<img src=x onerror=alert(1)> & 教材';
  for (const course of add('date-format', '全角とスラッシュ区切りの締切', 7).courses) {
    course.tables[0].rows[0].rawDeadline = course.tables[0].rows[0].rawDeadline.replaceAll('-', '/').replace(/[0-9]/g, digit => String.fromCharCode(digit.charCodeAt(0) + 0xfee0));
  }
  add('disabled', '課題一覧の設定OFF', 7, { disabled: true });
  add('empty-enrollment', '履修科目が0件', 0);
  add('missing-dashboard', '課題実施状況へのリンクがない', 7, { noDashboard: true });
  add('missing-schedule', '時間割がないページ', 7, { noSchedule: true });
  for (let seed = 1; seed <= 32; seed++) {
    const sizes = [1, 7, 15, 30];
    const { courses, rng } = add(`seed-${seed}`, `組み合わせ・読込順 seed=${seed}`, sizes[(seed - 1) % sizes.length], { seed, repeats: 3 });
    const layouts = ['normal', 'reordered', 'multi-header', 'direct-rows', 'header-in-body'];
    for (const course of courses) {
      course.tables[0].layout = layouts[Math.floor(rng() * layouts.length)];
      course.tables[0].delay = Math.floor(rng() * 4800);
      if (rng() < 0.15) course.tables[0].rows = [];
    }
  }
  const tested = new Map(scenarios.flatMap(scenario => scenario.courses.filter(course => course.enrolled)).map(course => [course.id, course]));
  const sourceIds = new Set(dataset.courses.map(course => `26${course.courseCode}`));
  return { fixedNow: FIXED_NOW, scenarios, source: {
    courseCount: dataset.courses.length, sampledCourseCount: pool.length, departmentGroups: groups.size,
    testedCourseCount: tested.size, testedSourceCourseCount: [...tested.keys()].filter(id => sourceIds.has(id)).length,
    testedGraduateCount: [...tested.values()].filter(course => course.level === '大学院').length
  } };
}
