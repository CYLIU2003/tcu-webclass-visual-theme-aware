(() => {
  "use strict";

  const origin = "https://websrv.tcu.ac.jp";
  const permission = { origins: [origin + "/*"] };
  const codePattern = /^[a-z]{3,4}\d{4,6}$/;
  const clean = (text) => String(text || "").normalize("NFKC")
    .replace(/[\s\u200B-\u200D\uFEFF]+/g, "").toLowerCase();
  const terms = { all: "全学期", 1: "前期", 2: "後期", 3: "前期前半", 4: "前期後半", 5: "後期前半", 6: "後期後半" };
  const halves = { 1: "前期", 2: "後期", 3: "前期", 4: "前期", 5: "後期", 6: "後期" };
  const halfOf = (value) => /前期/.test(value) ? "前期" : /後期/.test(value) ? "後期" : null;

  function registration(label) {
    const text = String(label || "").normalize("NFKC").replace(/^[»░■▶]+\s*/, "")
      .replace(/\s*_[a-z]{3,4}\d{4,6}\s*$/i, "").trim();
    // Only a trailing WebClass scheduling suffix is stripped. Preserve (1a),
    // (b) and other parenthesized parts of the official subject title.
    const extra = /\(([^()]*(?:20\d{2}年度)[^()]*)\)$/.exec(text);
    const context = extra && /前期|後期|通年|曜日|[月火水木金土日]\d/.test(extra[1]) ? extra[1] : "";
    const title = context ? text.slice(0, extra.index).trim() : text;
    const slots = [...context.matchAll(/([月火水木金土日])\s*(?:曜(?:日)?)?\s*([1-9])(?:時?限)?(?!\d)/g)]
      .map(([, day, period]) => day + period);
    return { title, context, slots };
  }

  function createIndex(courses) {
    const titles = new Map();
    const codes = new Map();
    for (const course of courses) {
      if (!codePattern.test(course.courseCode || "")) continue;
      if (!codes.has(course.courseCode)) codes.set(course.courseCode, course);
      for (const title of [course.courseName, ...(course.aliases || [])]) {
        const key = clean(title);
        if (!key) continue;
        if (!titles.has(key)) titles.set(key, new Map());
        titles.get(key).set(course.courseCode, course);
      }
    }
    return { titles, codes };
  }

  function identify(row, index, term, year, currentYear) {
    if (row.code) return { course: index.codes.get(row.code), candidates: [], method: "code" };
    const raw = registration(row.name);
    const printedYear = /20\d{2}(?=年度)/.exec(raw.context)?.[0];
    if (printedYear && Number(printedYear) !== year) return { candidates: [], method: "candidate" };
    const candidates = [...(index.titles.get(clean(raw.title))?.values() || [])];
    if (currentYear && raw.slots.length) {
      const context = clean(raw.context);
      const matchesTeacher = (course) =>
        course.instructors?.some((name) => clean(name) && context.includes(clean(name)));
      const printedTerm = context.match(/20\d{2}年度((?:前期|後期)[前後]?)/)?.[1];
      const displayedTerm = ({1:"前期", 2:"後期", 3:"前期前", 4:"前期後", 5:"後期前", 6:"後期後"})[term];
      const compatible = (a, b) => !a || !b || a === "通年" || b === "通年" || a.startsWith(b) || b.startsWith(a);
      const matchesSlot = (course) => course.meetings?.some((meeting) =>
        raw.slots.includes(meeting.day + meeting.period)
        && compatible(printedTerm, displayedTerm) && compatible(meeting.termBlock, displayedTerm)
        && compatible(meeting.termBlock, printedTerm));
      const plausible = candidates.filter((course) =>
        (!course.instructors?.length || matchesTeacher(course)) && (!course.meetings?.length || matchesSlot(course)));
      if (plausible.length === 1 && matchesTeacher(plausible[0]) && matchesSlot(plausible[0])) {
        return { course: plausible[0], candidates, method: "context" };
      }
    }
    return { candidates, method: "candidate" };
  }

  function semesterFor(term, course) {
    if (halves[term]) return halves[term];
    const terms = course?.termBlocks || [];
    if (terms.some((value) => /通年/.test(value))) return null;
    const present = new Set(terms.map(halfOf).filter(Boolean));
    return present.size === 1 ? [...present][0] : null;
  }

  function syllabusUrl(year, code, semester) {
    const url = new URL("/tcu_web_v3/slbssbdr.do", origin);
    url.search = new URLSearchParams({
      "value(kougicd)": code,
      "value(risyunen)": year,
      "value(semekikn)": semester
    });
    return url;
  }

  function validEvidence(evidence, year, code, titles, expectedHalf) {
    if (evidence?.year !== year || evidence.code !== code || !titles.some((title) => clean(title) === clean(evidence.title))
      || typeof evidence.term !== "string" || !evidence.source?.startsWith(origin + "/tcu_web_v3/slbssbdr.do?")
      || !Number.isInteger(evidence.units) || evidence.units < 0 || evidence.units > 3000) return false;
    return (!expectedHalf || evidence.term.includes(expectedHalf) || /通年/.test(evidence.term));
  }

  function parseSyllabus(html, url) {
    const template = document.createElement("template");
    template.innerHTML = html;
    const root = template.content;
    const value = (id) => root.querySelector(`input[id="${id}"]`)?.value;
    if (value("kougicd") !== url.searchParams.get("value(kougicd)")
      || value("risyunen") !== url.searchParams.get("value(risyunen)")
      || value("semekikn") !== url.searchParams.get("value(semekikn)")) return null;
    const rows = new Map();
    for (const row of root.querySelectorAll("table.syllabus_detail tr")) {
      const key = row.querySelector(":scope > .label_kougi")?.textContent;
      const content = row.querySelector(":scope > .kougi")?.textContent;
      if (key && content) rows.set(key.trim().split("/")[0].trim(), content.normalize("NFKC").trim());
    }
    const title = rows.get("授業科目名");
    const term = rows.get("学期");
    const credits = rows.get("単位数");
    if (!title || !term || rows.get("開講年度") !== value("risyunen") || !/^\d{1,2}(?:\.\d{1,2})?$/.test(credits || "")) return null;
    return {
      year: Number(value("risyunen")), code: value("kougicd"), title, term,
      units: Math.round(Number(credits) * 100), source: url.href
    };
  }

  async function lookup(year, code, titles, expectedHalf) {
    if (!codePattern.test(code) || !Number.isInteger(year)) return null;
    const order = expectedHalf === "後期" ? ["2", "1"] : ["1", "2"];
    const found = [];
    for (const semester of order) {
      const url = syllabusUrl(year, code, semester);
      const response = await fetch(url, {
        credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(9000)
      });
      if (!response.ok) {
        if (response.status === 404) continue;
        throw new Error("Syllabus request failed");
      }
      const evidence = parseSyllabus(await response.text(), url);
      if (validEvidence(evidence, year, code, titles, expectedHalf)) {
        if (expectedHalf) return evidence;
        found.push(evidence);
      }
    }
    return found.length && found.every((entry) => entry.units === found[0].units) ? found[0] : null;
  }

  globalThis.WCV_ENROLLMENT_MATCH = { permission, terms, clean, registration, createIndex, identify, semesterFor, validEvidence, lookup };
})();
