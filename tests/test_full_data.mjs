import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
const data = read('timetable-2026.json');
const report = read('extraction-report.json');
const changes = read('timetable-changes-2026.json').changes;
const byCode = new Map(data.courses.map((course) => [course.courseCode, course]));
const withdrawn = new Set(report.withdrawnCourses.map((course) => course.courseCode));
const sourceIds = new Set(data.dataset.scope.sourceDocuments.map((source) => source.id));
assert.equal(byCode.size, data.courses.length);
assert.equal(sourceIds.size, 18);
assert.equal(report.sourceDiagnostics.length, 12);
assert.equal(changes.length, 238);
for (const source of report.sourceDiagnostics) {
  assert.deepEqual(source.unparsedCodes, [], `${source.source}: every PDF code must be extracted`);
  for (const code of source.selectedCodes) {
    assert.ok(byCode.has(code) || withdrawn.has(code), `${source.source}: omitted ${code}`);
  }
  for (const code of source.inventoryCodes) {
    assert.ok(source.selectedCodes.includes(code) || source.provisionalCodes.includes(code), `${source.source}: unexplained inventory code ${code}`);
  }
}
for (const course of data.courses) {
  assert.ok(course.courseName && course.source.url.startsWith('https://www.asc.tcu.ac.jp/'));
  assert.ok(course.source.pages.length);
  assert.ok(!course.instructors.some((teacher) => teacher.includes('→')), course.courseCode);
  for (const source of course.sources) assert.ok(sourceIds.has(source.id));
  for (const meeting of course.meetings) {
    assert.ok(!meeting.termBlock.includes('集中'), `${course.courseCode}: intensive courses must not become weekly slots`);
    assert.ok(meeting.sources.length);
  }
}
for (const change of changes) assert.notDeepEqual(change.status, ['absent-from-current-books']);
for (const code of withdrawn) assert.ok(!byCode.has(code));
for (const code of ['sba132316','sba132318','sba134206','sba131206','sba131313','sba132210','yaz627027','yaz617029','yaz627028']) {
  assert.ok(byCode.has(code), `previously missing/additional course ${code}`);
}
const slots = (code) => byCode.get(code).meetings.map((m) => `${m.day}${m.period}:${m.room}:${m.termBlock}`);
assert.deepEqual(slots('saz141401'), ['月3:1BJ / 各研究室:前期'], 'combined time/room correction must preserve other rooms and not create Monday 1');
assert.deepEqual(slots('yba611302'), ['火3:31E:後期前','火4:31E:後期前','金3:31E:後期前','金4:31E:後期前']);
assert.deepEqual(slots('sba272304'), ['火3:22C:後期前','火4:22C:後期前','金3:12K:後期前','金4:12K:後期前']);
assert.deepEqual(slots('sbz113201'), ['水2:PBL教室:後期前','水2:32A:後期後']);
assert.deepEqual(slots('saz001123'), ['月1:1BJ:前期前','月1:13P:前期後']);
assert.ok(byCode.get('smba030051').meetings.every((m) => m.room === '61A'));
assert.deepEqual(byCode.get('sbb001518').instructors, ['秦泉寺 久美']);
assert.deepEqual(byCode.get('sbb515315').meetings, []);
assert.deepEqual(byCode.get('sbb515315').instructors, []);
assert.deepEqual(byCode.get('sbb515315').termBlocks, ['後集中']);
assert.ok(byCode.get('smab020161').rooms.includes('10号館4階会議室1'), 'wrapped room stays together');
assert.equal(byCode.get('ymab102063').courseName, '特別講義(Applied Sustainable Systems)');
assert.ok(byCode.get('ymab102063').instructors.includes('アブドラ ノルハヤティ'));
assert.ok(byCode.get('saa001241').meetings.every((m) => m.room === '32A'), 'cross-listed older rooms must not be merged into primary timetable');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL('../data/timetable-2026.js', import.meta.url), 'utf8'), context);
assert.equal(JSON.stringify(context.window.WCV_TIMETABLE), JSON.stringify(data));
const html = fs.readFileSync(new URL('../demo/preview-standalone.html', import.meta.url), 'utf8');
assert.deepEqual(JSON.parse(html.match(/^window\.WCV_TIMETABLE = (.+);$/m)[1]), data);
console.log(`OK: ${byCode.size} courses; coverage of all 12 PDFs; 238 corrections, withdrawals, wrapped cells, cross-listings and demo parity`);
