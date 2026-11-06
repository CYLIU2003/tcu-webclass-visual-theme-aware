import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../src/deadlines.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL, Intl, console });
vm.runInContext(source.replace('globalThis.WCV_DEADLINES = Object.freeze({ sync, destroy });', 'globalThis.helpers = { parseDeadline, courseId, completedStatus, selectTasks, exclusionReason };'), context);
const { parseDeadline, courseId, completedStatus, selectTasks, exclusionReason } = context.helpers;
assert.equal(parseDeadline('2026-10-15 23:59'), Date.parse('2026-10-15T23:59:00+09:00'));
assert.equal(parseDeadline('２０２６/１０/１５ ０９:００'), Date.parse('2026-10-15T09:00:00+09:00'));
assert.equal(parseDeadline('2028-02-29 00:00'), Date.parse('2028-02-29T00:00:00+09:00'));
for (const invalid of ['', '-', '2026-02-29 23:59', '2026-02-30 23:59', '2026-10-15 24:00', '2026-10-15 23:60', '2026-13-01 00:00']) assert.equal(parseDeadline(invalid), null, invalid);
assert.equal(courseId('/webclass/course.php/26sba132209/login', 'https://webclass.tcu.ac.jp/'), '26sba132209');
assert.equal(courseId('https://example.com/webclass/course.php/26sba132209/login', 'https://webclass.tcu.ac.jp/'), '');
assert.equal(courseId('javascript:alert(1)', 'https://webclass.tcu.ac.jp/'), '');
assert.ok(completedStatus('提出済み') && completedStatus('合格') && completedStatus('回答済'));
assert.ok(!completedStatus('未提出') && !completedStatus('未回答') && !completedStatus('不合格') && !completedStatus('-'));
const now = Date.parse('2026-10-15T12:00:00+09:00');
const DAY = 86400000;
const tasks = [
  { title: 'expired', courseName: 'A', deadline: now - 1, status: '未提出' },
  { title: 'later', courseName: 'A', deadline: now + 8 * DAY, status: '未提出' },
  { title: 'completed', courseName: 'A', deadline: now + DAY, status: '提出済み' },
  { title: 'unknown', courseName: 'A', deadline: now + 2 * DAY, status: '-' },
  { title: 'urgent', courseName: 'A', deadline: now + 3600000, status: '未提出' },
  { title: 'boundary', courseName: 'A', deadline: now + 7 * DAY, status: '未回答' }
];
assert.equal(selectTasks(tasks, now).map((task) => task.title).join(','), 'urgent,unknown,boundary');
assert.equal(selectTasks(tasks, now).some((task) => task.title === 'later' || task.title === 'completed'), false, 'only pending tasks within one week are included');
const electromagnetismRows = [
  ['第1,2回課題提出: ベクトル、線積分・重積分', '2026-10-07 00:00', '-'],
  ['第3,4回課題提出: 電気力線', '2026-10-14 00:00', '-'],
  ['第5,6回課題提出: 電界・静電遮蔽', '2026-10-21 00:00', '-'],
  ['2026年度授業評価アンケート（中間） (link)', '2026-10-22 23:59', '-']
].map(([title, deadline, status]) => ({ title, deadline: parseDeadline(deadline), status, courseName: '電磁気学概論' }));
assert.equal(selectTasks(electromagnetismRows, now).map(task => task.title).join(','), '第5,6回課題提出: 電界・静電遮蔽', 'the reported pending assignment is within seven days; executed dates and scores do not determine completion');
assert.equal(exclusionReason(electromagnetismRows[2], now), '表示対象');
assert.equal(exclusionReason(electromagnetismRows[0], now), '期限切れのため対象外');
assert.equal(exclusionReason(electromagnetismRows[3], now), '締切が7日より先のため対象外');
assert.equal(exclusionReason({ deadline: null, rawDeadline: '-' }, now), '締切なし');
assert.equal(exclusionReason({ deadline: null, rawDeadline: '2026-10-2100:00' }, now), '締切の形式を読み取れません');
assert.equal(exclusionReason({ deadline: now + DAY, status: '提出済み' }, now), '提出・実施済みのため対象外');
console.log('OK: JST dates, invalid dates, exact course IDs, completion status and fixed seven-day deadline order');
