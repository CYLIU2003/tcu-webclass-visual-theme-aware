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

for (const [actualText, canonicalText] of cases) {
  const actual = normalizeCourseName(actualText);
  const expected = normalizeCourseName(canonicalText);
  if (actual !== expected) {
    console.error({ actualText, canonicalText, actual, expected });
    process.exit(1);
  }
}

console.log(`OK: ${cases.length} normalization cases`);
