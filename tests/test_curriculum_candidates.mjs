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
