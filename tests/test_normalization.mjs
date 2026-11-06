import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const contentPath = path.resolve(here, "../src/content.js");
const source = fs.readFileSync(contentPath, "utf8");

function extractFunction(name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`${name} not found`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} closing brace not found`);
}

const fnSource = extractFunction("normalizeCourseName");
const normalizeCourseName = new Function(`${fnSource}; return normalizeCourseName;`)();

const cases = [
  [
    "パワーエレクトロニクス特論（2・木2） (2026年度前期後)",
    "パワーエレクトロニクス特論"
  ],
  ["電力システム工学特論（水1・水2）", "電力システム工学特論"],
  ["情報処理基礎及び同演習（金3・金4）", "情報処理基礎及び同演習"],
  ["Ｓｕｓｔａｉｎａｂｌｅ　Ｃｙｂｅｒ－Ｐｈｙｓｉｃａｌ　Ｓｙｓｔｅｍｓ", "Sustainable Cyber-Physical Systems"]
];

const codeRegexSource = source.match(/const COURSE_CODE_RE = (\/[^;]+\/[a-z]*);/)?.[1];
if (!codeRegexSource) throw new Error("COURSE_CODE_RE not found");
const extractCourseCodes = new Function([
  `const COURSE_CODE_RE = ${codeRegexSource};`,
  extractFunction("normalizeCode"),
  extractFunction("uniqueBy"),
  extractFunction("extractCourseCodes"),
  "return extractCourseCodes;"
].join("\n"))();

const webclassUrl = "https://webclass.tcu.ac.jp/webclass/course.php/26sba132209/?acs_=4ce3c8c9";
const urlCourseCodes = extractCourseCodes(webclassUrl);
if (urlCourseCodes.length !== 1 || urlCourseCodes[0] !== "sba132209") {
  throw new Error(`year-prefixed WebClass URL should yield sba132209: ${urlCourseCodes}`);
}
for (const code of ["sbz003310", "smbz2301", "ymba102021"]) {
  const codes = extractCourseCodes(`https://webclass.tcu.ac.jp/webclass/course.php/26${code}/`);
  if (codes.length !== 1 || codes[0] !== code) {
    throw new Error(`year-prefixed URL should yield ${code}: ${codes}`);
  }
  if (extractCourseCodes(code)[0] !== code) {
    throw new Error(`plain timetable course code should still be recognized: ${code}`);
  }
}
const timetable = JSON.parse(fs.readFileSync(path.resolve(here, "../data/timetable-2026.json"), "utf8"));
for (const course of timetable.courses) {
  const codes = extractCourseCodes(`https://webclass.tcu.ac.jp/webclass/course.php/26${course.courseCode}/`);
  if (codes.length !== 1 || codes[0] !== course.courseCode) {
    throw new Error(`course code extraction failed for ${course.courseCode}: ${codes}`);
  }
}
const expectedCourse = { courseCode: "sba132209", courseName: "対象授業" };
const findCourseByCode = new Function(
  "state",
  "extractCourseCodes",
  "normalizeCode",
  "normalizeCourseName",
  "aggregateCandidates",
  `${extractFunction("findCourse")}; return findCourse;`
)({ codeIndex: new Map([["sba132209", expectedCourse]]) }, extractCourseCodes, (value) => String(value || "").toLowerCase(), normalizeCourseName, () => null);
if (findCourseByCode(webclassUrl) !== expectedCourse) {
  throw new Error("the WebClass URL should resolve directly to its timetable course");
}
const unrelatedCourse = { courseCode: "saa132209", courseName: "電子回路" };
const makeCourseFinder = (numericCodeIndex, courses = [unrelatedCourse]) => new Function(
  "state",
  "extractCourseCodes",
  "normalizeCode",
  "normalizeCourseName",
  "aggregateCandidates",
  "uniqueBy",
  `${extractFunction("findCourse")}; return findCourse;`
)({
  codeIndex: new Map(courses.map((course) => [course.courseCode, course])),
  numericCodeIndex,
  aliasIndex: new Map(),
  searchAliases: courses.map((course) => [normalizeCourseName(course.courseName), [course]])
}, extractCourseCodes, (value) => String(value || "").toLowerCase(), normalizeCourseName, (courses) => courses[0], (values, key = (value) => String(value)) => [...new Map(values.map((value) => [key(value), value])).values()]);
const findCourseWithCollidingSuffix = makeCourseFinder(new Map([[
  "132209",
  [unrelatedCourse, { courseCode: "yab132209", courseName: "別の授業" }]
]]));
if (findCourseWithCollidingSuffix(`電子回路 ${webclassUrl}`) !== null) {
  throw new Error("a colliding numeric suffix must not fall back to a same-name course");
}
const findCourseWithUniqueSuffix = makeCourseFinder(new Map([["132209", [unrelatedCourse]]]));
if (findCourseWithUniqueSuffix(`電子回路 ${webclassUrl}`) !== unrelatedCourse) {
  throw new Error("a unique numeric suffix plus an exact title should resolve the course");
}
const actualCodeMatches = timetable.courses.filter((course) => course.courseCode.match(/\d{4,6}$/)?.[0] === "132209");
const actualCourse = timetable.courses.find((course) => course.courseCode === "sba132209");
const findActualCourse = makeCourseFinder(new Map([["132209", actualCodeMatches]]), actualCodeMatches);
if (actualCodeMatches.length < 2 || findActualCourse(`電子回路 ${webclassUrl}`) !== actualCourse) {
  throw new Error("the exact fall code must resolve despite a spring course sharing its numeric suffix");
}

for (const [actualText, canonicalText] of cases) {
  const actual = normalizeCourseName(actualText);
  const expected = normalizeCourseName(canonicalText);
  if (actual !== expected) {
    console.error({ actualText, canonicalText, actual, expected });
    process.exit(1);
  }
}

const matchingHelpers = new Function([
  extractFunction("normalizeCourseName"),
  extractFunction("uniqueBy"),
  extractFunction("extractTermHints"),
  extractFunction("extractMeetingHints"),
  extractFunction("filterCandidates"),
  extractFunction("shortInstructors"),
  extractFunction("instructorLabel"),
  "return { filterCandidates, instructorLabel };"
].join("\n"))();

globalThis.Element = class MockElement {
  constructor(tagName, text, context = null) {
    this.tagName = tagName.toUpperCase();
    this.innerText = text;
    this.textContent = text;
    this.context = context;
  }
  matches(selector) {
    return selector === "a" && this.tagName === "A";
  }
  closest() {
    return this.context;
  }
};
const elementContextText = new Function([
  "const elementText = (element) => element.innerText || element.textContent || '';",
  extractFunction("elementContextText"),
  "return elementContextText;"
].join("\n"))();

const candidates = [
  { courseName: "同名科目", courseCode: "aaa000001", instructors: ["先生A"], meetings: [{ day: "月", period: 2 }] },
  { courseName: "同名科目", courseCode: "aaa000002", instructors: ["先生B"], meetings: [{ day: "火", period: 3 }] }
];
const periodMatch = matchingHelpers.filterCandidates(candidates, "同名科目 月曜日 2限");
if (periodMatch.length !== 1 || periodMatch[0].courseCode !== "aaa000001") {
  throw new Error("meeting context should select the matching class");
}
const teacherMatch = matchingHelpers.filterCandidates([
  candidates[0],
  { ...candidates[1], meetings: [{ day: "月", period: 2 }] }
], "同名科目 月2 先生A");
if (teacherMatch.length !== 1 || teacherMatch[0].courseCode !== "aaa000001") {
  throw new Error("instructor context should select the matching class");
}
if (matchingHelpers.filterCandidates(candidates, "同名科目").length !== 2) {
  throw new Error("a title without class context should remain ambiguous");
}
if (matchingHelpers.instructorLabel({ instructorAmbiguous: true }) !== "時限・講義コードでクラス特定が必要") {
  throw new Error("multiple possible instructors should not be presented as certain");
}

const row = new globalThis.Element("tr", "同名科目 月曜日 2限 先生A");
const link = new globalThis.Element("a", "同名科目", row);
if (elementContextText(link) !== row.innerText) {
  throw new Error("course links should expose their row context for matching");
}

console.log(`OK: ${cases.length} normalization cases, class matching and row context`);
