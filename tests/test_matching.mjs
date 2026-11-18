import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');
const data = JSON.parse(fs.readFileSync(new URL('../data/timetable-2026.json', import.meta.url), 'utf8'));
const context = vm.createContext({ console });
vm.runInContext(source.replace(/  if \(document.readyState === "loading"\)[\s\S]*$/, '  globalThis.helpers = { state, rebuildIndexes, findCourse, standardPeriods };\n})();'), context);
const { state, rebuildIndexes, findCourse, standardPeriods } = context.helpers;
state.courses = data.courses;
state.dataset = data;
rebuildIndexes();
for (const course of data.courses) {
  assert.equal(findCourse(`https://webclass.tcu.ac.jp/webclass/course.php/26${course.courseCode}/`), course);
}
assert.equal(findCourse('電子回路 https://webclass.tcu.ac.jp/webclass/course.php/26sba132209/').courseCode, 'sba132209');
assert.equal(findCourse('https://webclass.tcu.ac.jp/webclass/course.php/26saa132209/').courseName, '電子回路');
const ambiguous = findCourse('Academic English(1)');
assert.ok(ambiguous.ambiguous);
assert.equal(ambiguous.meetings.length, 0, 'ambiguous classes must not populate slots across campuses');
assert.equal(standardPeriods([{ meetings: [{ day: '月', period: 7 }] }]).length, 7);
assert.equal(new Set(data.courses.map(course => course.courseCode)).size, data.courses.length);
console.log(`OK: ${data.courses.length} indexed URL matches, numeric fallback, ambiguity and late periods`);

vm.runInContext(fs.readFileSync(new URL('../src/enrollment-matching.js', import.meta.url), 'utf8'), context);
const matching = context.WCV_ENROLLMENT_MATCH;
const spring = {courseCode: 'abc1001', courseName: '演習', instructors: ['担当A'], meetings: [{day:'火',period:3,termBlock:'前期前'}]};
const fall = {...spring, courseCode:'abc1002', meetings:[{day:'火',period:3,termBlock:'後期後'}]};
const registration = {name:'演習（火3、担当A、2026年度後期後半）'};
assert.equal(matching.identify(registration, matching.createIndex([spring,fall]), 'all', 2026, true).course?.courseCode, fall.courseCode);
assert.equal(matching.identify(registration, matching.createIndex([spring]), 'all', 2026, true).course, undefined);
