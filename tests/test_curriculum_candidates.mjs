import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../src/curriculum.js';

const db = JSON.parse(fs.readFileSync(new URL('../data/curriculum-candidates.json', import.meta.url)));
const match = globalThis.WCV_CURRICULUM.match;
assert.equal(match(db, {plan: ''}, 'ひらめきづくり(1)').length, 0);
assert.equal(match(db, {plan: '2026-information-science'}, 'ひらめきづくり(1)').length, 0);
assert.equal(match(db, {plan: '2024-hirameki-engineering'}, 'ひらめきづくり（１）')[0].kind, 'required');
assert.equal(match(db, {plan: '2023-hirameki-engineering'}, 'ひらめきづくり(1)')[0].admissionYear, 2023);
assert.equal(match(db, {plan: '2022-hirameki-engineering'}, 'ひらめきづくり(1)')[0].credits, 2);
assert.equal(match(db, {plan: '2024-hirameki-engineering'}, 'ひらめきづくり(1)')[0].credits, 1);
assert.equal(match(db, {plan: '2025-hirameki-engineering'}, 'ひらめきづくり(1)')[0].kind, 'required');
assert.equal(match(db, {plan: '2025-hirameki-other'}, 'ひらめきづくり(1)')[0].kind, 'conditional');
assert.equal(match(db, {plan: '2025-hirameki-other'}, 'Next PBL(2)')[0].sourceId, 'hirameki-2025-other');
assert.equal(match(db, {plan: '2026-information-science'}, 'プログラミング(1)')[0].scope, 'information-science');
assert.equal(match(db, {plan: '2026-information-science'}, '数学演習(1a)')[0].kind, 'choice');
assert.match(match(db, {plan: '2026-information-science'}, '数学演習(1a)')[0].note, /△3/);
assert.deepEqual(match(db, {plan: '2026-information-science'}, '数学演習(1a)')[0].relatedPages, [7]);
assert.equal(match(db, {plan: '2026-information-science'}, '物理学(1)').length, 0); // 一般と国際で区分が異なる
assert.equal(match(db, {plan: '2026-information-science', teaching: false}, '教育原論').length, 0);
assert.equal(match(db, {plan: '2026-information-science', teaching: true}, '教育原論')[0].scope, 'teaching-engineering-information');
assert.equal(match(db, {plan: '2026-information-science', teaching: true}, '教育原論')[0].freeCreditCandidate, true);
assert.equal(match(db, {plan: '2026-information-science', teaching: true}, '教育心理学')[0].kind, 'choice');
assert.equal(match(db, {plan: '2024-hirameki-engineering', teaching: true}, '教育原論').length, 0);
assert.equal(match(db, {plan: '2026-information-science', hirameki: false}, 'ことづくり').length, 0);
assert.equal(match(db, {plan: '2026-information-science', hirameki: true}, 'ことづくり')[0].kind, 'conditional');
assert.equal(match(db, {plan: '2024-hirameki-engineering', hirameki: true}, 'ことづくり').length, 0);
assert.equal(match(db, {plan: '2026-information-science'}, 'プログラミング(10)').length, 0);
assert.equal(new Set(db.records.map(r => r.id)).size, db.records.length);
for (const row of db.records) {
  assert.equal(row.reviewStatus, 'visually-reviewed-source-unmatched-offering');
  assert.ok(db.sources.find(source => source.id === row.sourceId));
}
console.log('PASS: curriculum profile isolation, conditional teaching and unverified title matching');

const programs = JSON.parse(fs.readFileSync(new URL('../data/undergraduate-programs.json', import.meta.url)));
const programMatches = WCV_CURRICULUM.programMatches;
assert.equal(Object.keys(programs.profiles).length, 89);
assert.ok(Object.values(programs.profiles).every(profile => profile.tap?.url.includes('#page=')));
const allPrograms = {cohort:'2026:情報科学科', hirameki:'yes', teaching:'yes', tap:'yes'};
assert.equal(programMatches(programs, db, allPrograms, 'ことづくり')[0].scope, 'hirameki-2026');
assert.equal(programMatches(programs, db, allPrograms, '教育原論')[0].kind, 'required');
assert.equal(programMatches(programs, db, allPrograms, 'Communication Skills（1）')[0].kind, 'recognition');
assert.equal(programMatches(programs, db, {...allPrograms, tap:'no'}, 'Communication Skills(1)').length, 0);
assert.equal(programMatches(programs, db, {...allPrograms, teaching:''}, '教育原論').length, 0);
assert.equal(programMatches(programs, db, {...allPrograms, cohort:'2024:機械工学科', hirameki:'no'}, 'ひらめきづくり(1)').length, 0);
const design = {cohort:'2026:デザイン・データ科学科', tap:'yes'};
assert.equal(programMatches(programs, db, design, 'English III-A')[0].kind, 'recognition');
assert.equal(programMatches(programs, db, design, 'Communication Skills(1)').length, 0);
console.log('PASS: undergraduate program consent, cohort-specific TAP and source links');

await import('../src/planner-academic.js');
const { calculate, progressionCutoff, readGradeRows } = WCV_PLANNER_ACADEMIC;
const past = { year: 2024, code: 'saa001102', name: 'ドイツ語', grade: '可', units: 100,
  graduation: 'yes', progression: 'yes' };
const retake = { ...past, year: 2025, grade: '優' };
assert.equal(calculate([past, retake], 'graduation', null).conflicts.length, 2);
assert.equal(calculate([past, retake], 'graduation', null).total, 0);
assert.equal(calculate([{ ...past, grade: '不可' }, retake], 'graduation', null).total, 100);
assert.equal(calculate([{ ...past, grade: '不可' }, retake], 'progression', 2024).total, 0);
assert.equal(progressionCutoff(2023, 3), 2024);
assert.equal(progressionCutoff(2023, 4), 2025);
assert.equal(progressionCutoff(2023, 3, 2025), 2025);
assert.equal(calculate([{...retake, graduation: ''}], 'graduation', null).total, 0);
assert.deepEqual(readGradeRows('科目名\t修得期\t評価\t単位\n統計\t２０２５年度後期\t認定\t１．５'),
  [{year: 2025, name: '統計', code: null, grade: '認定', units: 150}]);
assert.equal(readGradeRows('科目名\t修得期\t評価\t単位\n統計\t2025\t履修中\t')[0].units, null);
assert.throws(() => readGradeRows('年度\t授業名\t評価\t単位\n2025\t統計\t90\t2'));
console.log('PASS: retake holds, progression cutoff and official grade labels');
