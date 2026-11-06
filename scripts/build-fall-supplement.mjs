import fs from 'node:fs/promises';

// Manually verified rows from the official September 10 timetable, including
// paired meetings in its remarks column. The October 6 change list contains
// none of these eight lecture codes. Do not derive rooms from course names.
const source = {
  id: 'undergraduate-setagaya-fall-supplement',
  document: '2026年度 学部授業時間表（世田谷キャンパス・後期、9/10更新）',
  url: 'https://www.asc.tcu.ac.jp/wp-content/uploads/2026/04/63645e5e27f2b67bd54fe4fbf71e6ed9.pdf',
  fileName: '63645e5e27f2b67bd54fe4fbf71e6ed9.pdf',
  sha256: 'c007f318b8e2574a15a799a2f503e5b8082d666b7ad10275ffd5fef9dc0ef705',
  level: '学部',
  scope: '世田谷キャンパス・学部（8科目の補完）',
  pagesUsed: [7, 8, 56, 61]
};

const rows = [
  ['sba133105', '電磁気学概論', '平野 拓一', '22C', ['水1', '水2'], '後期前', [8], '電通'],
  ['sba131205', '微分積分学(2a)', '笹尾 哲', '11F', ['月2'], '後期前', [7], '電通'],
  ['sba132209', '電磁気学基礎', '須藤 誠一', '13L', ['火2', '金2'], '後期前', [7], '電通'],
  ['sba134205', '線形代数学(2a)', '出耒 光夫', '12H', ['木2'], '後期前', [8], '電通'],
  ['sba131309', '物理学及び演習(1)', '三原 国子', '1BL', ['月3', '月4', '木3', '木4'], '後期前', [7, 8], '電通'],
  ['sba132314', 'プログラミング基礎(a)', '千葉 邦子', '12L', ['火3'], '後期前', [7], '電通'],
  ['sbz004435', 'プログラミング基礎', '白鳥 成彦', '12M', ['木4'], '後期', [56], '共通'],
  ['sba005510', 'ことづくり', '岸 和幸', 'PBL教室', ['金5'], '後期前', [61], '共通']
];

const courses = rows.map(([courseCode, courseName, teacher, room, slots, termBlock, pages, department]) => ({
  academicYear: 2026,
  courseCode,
  courseName,
  aliases: courseCode === 'sba005510' ? ['ことづくり(1)', 'ことづくり/ことづくり(1)'] : [],
  instructors: [teacher],
  level: '学部',
  semester: '後期',
  semesters: ['後期'],
  termBlock,
  termBlocks: [termBlock],
  campuses: ['世田谷キャンパス'],
  departments: [{ code: department, label: department === '電通' ? '電気電子通信工学科' : '共通科目', sourceGroup: '世田谷キャンパス・学部' }],
  category: department === '電通' && /電磁気/.test(courseName) ? '専門科目' : '基礎科目',
  scheduleTypes: ['通常'],
  meetings: slots.map((slot) => ({ day: slot[0], period: Number(slot.slice(1)), room, rooms: [room], termBlock, campus: '世田谷キャンパス', timeProfile: 'standard' })),
  source: { document: source.document, url: source.url, pages },
  sources: [{ id: source.id, document: source.document, url: source.url, pages }],
  notes: []
}));

await fs.writeFile(new URL('../data/timetable-2026-fall-supplement.json', import.meta.url), JSON.stringify({
  schemaVersion: 2,
  dataset: {
    id: source.id,
    academicYear: 2026,
    title: '2026年度 世田谷・学部 後期 補完（8科目）',
    verifiedAt: '2026-10-13',
    source,
    changesChecked: {
      updatedAt: '2026-10-06',
      url: 'https://www.asc.tcu.ac.jp/wp-content/uploads/2026/10/d392d80dc3181badce8f10a145b92871-1.pdf',
      sha256: '39cfdb15159ffbbb0bb29689f7b3236af9907923af600a8db3c93aab2ba3d7ed',
      affectedCourseCodes: []
    }
  },
  courses
}, null, 2) + '\n', 'utf8');
console.log(`Generated ${courses.length} source-verified fall courses`);
