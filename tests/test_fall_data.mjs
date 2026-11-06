import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const context = vm.createContext({
  console,
  chrome: { runtime: { getURL: (path) => path } },
  fetch: async (path) => ({ ok: true, json: async () => JSON.parse(await fs.readFile(new URL('../' + path, import.meta.url), 'utf8')) })
});
vm.runInContext(await fs.readFile(new URL('../src/dataset.js', import.meta.url), 'utf8'), context);
const source = await fs.readFile(new URL('../src/content.js', import.meta.url), 'utf8');
vm.runInContext(source.replace(/  if \(document.readyState === "loading"\)[\s\S]*$/, '  globalThis.helpers = { state, loadDataset, rebuildIndexes, findCourse, courseForContext, mergeCourses };\n})();'), context);
const { state, loadDataset, rebuildIndexes, findCourse, courseForContext, mergeCourses } = context.helpers;
state.dataset = await loadDataset();
state.courses = state.dataset.courses;
rebuildIndexes();

const expected = [
  ['sba133105', '電磁気学概論', '平野 拓一', '22C', ['水1', '水2']],
  ['sba131205', '微分積分学(2a)', '笹尾 哲', '11F', ['月2']],
  ['sba132209', '電磁気学基礎', '須藤 誠一', '13L', ['火2', '金2']],
  ['sba134205', '線形代数学(2a)', '出耒 光夫', '12H', ['木2']],
  ['sba131309', '物理学及び演習(1)', '三原 国子', '1BL', ['月3', '月4', '木3', '木4']],
  ['sba132314', 'プログラミング基礎(a)', '千葉 邦子', '12L', ['火3']],
  ['sbz004435', 'プログラミング基礎', '白鳥 成彦', '12M', ['木4']],
  ['sba005510', 'ことづくり(1)', '岸 和幸', 'PBL教室', ['金5']]
];
for (const [code, name, teacher, room, meetings] of expected) {
  const title = code === 'sba005510' ? 'ことづくり/ことづくり(1)' : name;
  const term = code === 'sbz004435' ? '後期' : '後期前半';
  const text = `https://webclass.tcu.ac.jp/webclass/course.php/26${code}/login » ${title}(${meetings.join('・')}、${teacher.split(' ')[0]}、2026年度${term})_${code}新着メッセージ(3)`;
  const course = courseForContext(findCourse(text), text);
  assert.equal(course.courseName, name);
  assert.equal(course.courseCode, code);
  assert.equal(course.unmatched, undefined);
  assert.equal(course.isUserOverride, undefined, 'official supplements are not user overrides');
  assert.equal(course.instructors.join(','), teacher);
  assert.equal(course.meetings.map((meeting) => meeting.day + meeting.period).join(','), meetings.join(','));
  assert.ok(course.meetings.every((meeting) => meeting.room === room));
  assert.ok(course.source.pages.length && course.source.url.startsWith('https://www.asc.tcu.ac.jp/'));
}
assert.equal(findCourse('電子回路 https://webclass.tcu.ac.jp/webclass/course.php/26sba132209/login').courseName, '電磁気学基礎', 'exact fall code wins over a spring code with the same numeric suffix');
assert.equal(findCourse('https://webclass.tcu.ac.jp/webclass/course.php/26saa132209/login').courseName, '電子回路', 'existing spring data remains available');
assert.equal(state.courses.length, 3736);
assert.equal(state.dataset.dataset.scope.uniqueCourses, state.courses.length);
assert.equal(state.dataset.dataset.scope.sourceDocuments.length, 18);
const override = mergeCourses(state.courses, [{ courseName: '電磁気学基礎', courseCode: 'sba132209', meetings: [{ day: '火', period: 2, room: '変更教室' }] }]).find((course) => course.courseCode === 'sba132209');
assert.equal(override.meetings[0].room, '変更教室', 'user corrections retain priority');

const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
assert.ok(manifest.content_scripts[0].js.indexOf('src/dataset.js') < manifest.content_scripts[0].js.indexOf('src/content.js'));
assert.ok(manifest.web_accessible_resources[0].resources.includes('data/timetable-2026.json'));
console.log('OK: all 8 real fall codes, teachers, rooms and 13 meetings; loader, spring data and user overrides');
