(() => {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    onboardingSeen: false,
    enabled: true,
    restyle: true,
    modernizeNativeLayout: true,
    showInlineMetadata: true,
    showEnhancedTimetable: false,
    showSidebarTools: true,
    showFloatingPanel: true,
    showSourceLabel: true,
    debug: false,
    userCourses: []
  });

  const UI_IDS = Object.freeze({
    launcher: "wcv-launcher",
    panel: "wcv-panel",
    courseCard: "wcv-course-info-card",
    enhancedTimetable: "wcv-enhanced-timetable",
    sidebarTools: "wcv-sidebar-tools",
    nativeCourseCount: "wcv-native-course-count"
  });

  const COURSE_CODE_RE = /[a-z]{3,4}\d{4,6}/gi;
  const DAYS = ["月", "火", "水", "木", "金", "土", "日"];
  const NAVIGATION_WORDS = new Set([
    "コース", "教材", "成績", "出席", "その他", "メンバー", "コース管理",
    "学生としてログインする", "ログアウト", "トップ", "お知らせ", "メッセージ",
    "マニュアル・サンプルファイル", "コースの追加", "参加可能なコース",
    "戻る", "閉じる", "開始", "終了"
  ]);

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    dataset: null,
    historicalEvidence: [],
    historicalDataSummary: null,
    databaseStatus: null,
    courses: [],
    codeIndex: new Map(),
    aliasIndex: new Map(),
    searchAliases: [],
    annotatedElements: new WeakSet(),
    detectedCourses: new Map(),
    currentCourse: null,
    observer: null,
    rescanTimer: null,
    ownMutationDepth: 0,
    nativeOriginals: new Map(),
    nativeAddedClasses: new Map(),
    nativeDetectedCourses: new Map(),
    themeSignature: ""
  };

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }


  function parseRgbColor(value) {
    const match = String(value || "").match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (!match) return null;
    return {
      r: Math.max(0, Math.min(255, Number(match[1]))),
      g: Math.max(0, Math.min(255, Number(match[2]))),
      b: Math.max(0, Math.min(255, Number(match[3]))),
      a: match[4] == null ? 1 : Math.max(0, Math.min(1, Number(match[4])))
    };
  }

  function mixRgb(base, target, amount) {
    const ratio = Math.max(0, Math.min(1, Number(amount) || 0));
    return {
      r: Math.round(base.r + (target.r - base.r) * ratio),
      g: Math.round(base.g + (target.g - base.g) * ratio),
      b: Math.round(base.b + (target.b - base.b) * ratio),
      a: 1
    };
  }

  function rgbCss(color) {
    return `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`;
  }

  function relativeLuminance(color) {
    const channels = [color.r, color.g, color.b].map((value) => {
      const normalized = value / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function detectThemeColor() {
    const selectors = [
      "header .navbar.navbar-default",
      "header .navbar",
      ".navbar-default",
      ".bgc_main",
      "header"
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const color = parseRgbColor(getComputedStyle(element).backgroundColor);
      if (!color || color.a < 0.25) continue;
      const luminance = relativeLuminance(color);
      if (luminance > 0.92) continue;
      return color;
    }
    return { r: 112, g: 0, b: 112, a: 1 };
  }

  function applyThemeTokens() {
    if (state.themeSignature) return;
    const theme = detectThemeColor();
    const signature = `${theme.r},${theme.g},${theme.b}`;
    state.themeSignature = signature;
    const root = document.documentElement.style;
    const white = { r: 255, g: 255, b: 255 };
    const black = { r: 0, g: 0, b: 0 };
    root.setProperty("--wcv-theme", rgbCss(theme));
    root.setProperty("--wcv-theme-rgb", `${Math.round(theme.r)}, ${Math.round(theme.g)}, ${Math.round(theme.b)}`);
    root.setProperty("--wcv-theme-dark", rgbCss(mixRgb(theme, black, 0.2)));
    root.setProperty("--wcv-theme-darker", rgbCss(mixRgb(theme, black, 0.34)));
    root.setProperty("--wcv-theme-soft", rgbCss(mixRgb(theme, white, 0.94)));
    root.setProperty("--wcv-theme-soft-2", rgbCss(mixRgb(theme, white, 0.87)));
    root.setProperty("--wcv-theme-border", rgbCss(mixRgb(theme, white, 0.7)));
    root.setProperty("--wcv-on-theme", relativeLuminance(theme) > 0.48 ? "#172033" : "#ffffff");
  }

  function rememberNativeElement(element) {
    if (!(element instanceof Element) || state.nativeOriginals.has(element)) return;
    state.nativeOriginals.set(element, {
      html: element.innerHTML,
      className: element.getAttribute("class"),
      style: element.getAttribute("style"),
      title: element.getAttribute("title"),
      ariaLabel: element.getAttribute("aria-label"),
      annotated: element.getAttribute("data-wcv-annotated")
    });
  }

  function addNativeClass(element, ...classNames) {
    if (!(element instanceof Element)) return;
    if (!state.nativeAddedClasses.has(element)) state.nativeAddedClasses.set(element, new Set());
    const bucket = state.nativeAddedClasses.get(element);
    for (const className of classNames.filter(Boolean)) {
      if (!element.classList.contains(className)) {
        element.classList.add(className);
        bucket.add(className);
      }
    }
  }

  function restoreNativeEnhancements() {
    document.getElementById(UI_IDS.sidebarTools)?.remove();
    document.getElementById(UI_IDS.nativeCourseCount)?.remove();
    document.querySelectorAll(".wcv-native-injected").forEach((element) => element.remove());
    for (const [element, original] of state.nativeOriginals.entries()) {
      if (!element?.isConnected) continue;
      element.innerHTML = original.html;
      if (original.className == null) element.removeAttribute("class");
      else element.setAttribute("class", original.className);
      if (original.style == null) element.removeAttribute("style");
      else element.setAttribute("style", original.style);
      if (original.title == null) element.removeAttribute("title");
      else element.setAttribute("title", original.title);
      if (original.ariaLabel == null) element.removeAttribute("aria-label");
      else element.setAttribute("aria-label", original.ariaLabel);
      if (original.annotated == null) element.removeAttribute("data-wcv-annotated");
      else element.setAttribute("data-wcv-annotated", original.annotated);
      element.removeAttribute("data-wcv-native-enhanced");
      element.removeAttribute("data-wcv-native-period-enhanced");
      element.removeAttribute("data-wcv-course-code");
    }
    for (const [element, classes] of state.nativeAddedClasses.entries()) {
      if (!element?.isConnected) continue;
      for (const className of classes) element.classList.remove(className);
    }
    state.nativeOriginals.clear();
    state.nativeAddedClasses.clear();
    state.nativeDetectedCourses = new Map();
  }

  function normalizeCourseName(value) {
    if (typeof value !== "string") return "";
    return value
      .normalize("NFKC")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\b20\d{2}\s*年度?/gi, "")
      .replace(/[（(][^）)]*(?:前期|後期|通年|クラス|曜日|月|火|水|木|金|土|日|\d限|\d時限)[^）)]*[）)]/g, "")
      .replace(/[（(](?:\d+|[a-zA-Z]|[月火水木金土日]\d)(?:[・,，／/\s]+(?:\d+|[a-zA-Z]|[月火水木金土日]\d))*[）)]/g, "")
      .replace(/(?:前期前|前期後|後期前|後期後|前期|後期|通年)$/g, "")
      .replace(/[\s　\-‐‑‒–—―_・･:：,，.。/／\\\[\]【】「」『』（）()]/g, "")
      .toLocaleLowerCase("ja-JP")
      .trim();
  }

  function normalizeCode(value) {
    return String(value || "").trim().toLowerCase();
  }

  function normalizeExactCourseTitle(value) {
    if (typeof value !== "string") return "";
    return value
      .normalize("NFKC")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[\s　\-‐‑‒–—―_・･:：,，.。/／\\\[\]【】「」『』]/g, "")
      .toLocaleLowerCase("ja-JP")
      .trim();
  }

  function uniqueBy(values, keyFunction = (value) => String(value)) {
    const seen = new Set();
    const result = [];
    for (const value of values || []) {
      if (value == null || value === "") continue;
      const key = keyFunction(value);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(value);
    }
    return result;
  }

  function cloneCourse(course) {
    return {
      ...course,
      aliases: Array.isArray(course?.aliases) ? [...course.aliases] : [],
      instructors: Array.isArray(course?.instructors) ? [...course.instructors] : [],
      meetings: Array.isArray(course?.meetings)
        ? course.meetings.map((meeting) => ({
            ...meeting,
            rooms: Array.isArray(meeting.rooms) ? [...meeting.rooms] : []
          }))
        : [],
      departments: Array.isArray(course?.departments)
        ? course.departments.map((department) => ({ ...department }))
        : [],
      campuses: Array.isArray(course?.campuses) ? [...course.campuses] : [],
      scheduleTypes: Array.isArray(course?.scheduleTypes) ? [...course.scheduleTypes] : [],
      notes: Array.isArray(course?.notes) ? [...course.notes] : [],
      sources: Array.isArray(course?.sources) ? course.sources.map((source) => ({ ...source })) : []
    };
  }

  function mergeCourses(baseCourses, userCourses) {
    const merged = new Map();
    const nameKeys = new Map();

    for (const rawCourse of baseCourses || []) {
      if (!rawCourse?.courseName) continue;
      const course = cloneCourse(rawCourse);
      const key = course.courseCode ? `code:${normalizeCode(course.courseCode)}` : `name:${normalizeCourseName(course.courseName)}`;
      merged.set(key, course);
      const name = normalizeCourseName(course.courseName);
      if (name) {
        if (!nameKeys.has(name)) nameKeys.set(name, []);
        nameKeys.get(name).push(key);
      }
    }

    for (const rawOverride of userCourses || []) {
      if (!rawOverride?.courseName) continue;
      const override = cloneCourse(rawOverride);
      const codeKey = override.courseCode ? `code:${normalizeCode(override.courseCode)}` : "";
      const name = normalizeCourseName(override.courseName);
      const nameMatches = nameKeys.get(name) || [];
      const key = (codeKey && merged.has(codeKey))
        ? codeKey
        : (nameMatches.length === 1 ? nameMatches[0] : (codeKey || `override:${name}:${merged.size}`));
      const previous = merged.get(key) || {};

      merged.set(key, {
        ...previous,
        ...override,
        aliases: uniqueBy([...(previous.aliases || []), ...(override.aliases || [])]),
        instructors: override.instructors?.length ? override.instructors : previous.instructors || [],
        meetings: override.meetings?.length ? override.meetings : previous.meetings || [],
        departments: override.departments?.length ? override.departments : previous.departments || [],
        campuses: override.campuses?.length ? override.campuses : previous.campuses || [],
        scheduleTypes: override.scheduleTypes?.length ? override.scheduleTypes : previous.scheduleTypes || [],
        notes: override.notes?.length ? override.notes : previous.notes || [],
        source: override.source || previous.source,
        isUserOverride: true
      });
    }

    return [...merged.values()];
  }

  function rebuildIndexes() {
    state.codeIndex = new Map();
    state.aliasIndex = new Map();

    for (const course of state.courses) {
      const code = normalizeCode(course.courseCode);
      if (code) state.codeIndex.set(code, course);
      const names = [course.courseName, ...(course.aliases || [])].filter(Boolean);
      for (const name of names) {
        const normalized = normalizeCourseName(name);
        if (!normalized || normalized.length < 3) continue;
        if (!state.aliasIndex.has(normalized)) state.aliasIndex.set(normalized, []);
        const bucket = state.aliasIndex.get(normalized);
        if (!bucket.includes(course)) bucket.push(course);
      }
    }

    state.searchAliases = [...state.aliasIndex.entries()]
      .filter(([alias]) => alias.length >= 5)
      .sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0], "ja"));
  }

  function extractCourseCodes(rawText) {
    const values = String(rawText || "").match(COURSE_CODE_RE) || [];
    return uniqueBy(values.map(normalizeCode));
  }

  function extractTermHints(rawText) {
    const text = String(rawText || "").normalize("NFKC");
    const exact = text.match(/前期前|前期後|後期前|後期後|通年/g) || [];
    if (exact.length) return uniqueBy(exact);
    const semester = text.match(/前期|後期|通年/g) || [];
    return uniqueBy(semester);
  }

  function extractMeetingHints(rawText) {
    const text = String(rawText || "").normalize("NFKC");
    const result = [];
    const pattern = /([月火水木金土日])(?:曜(?:日)?)?\s*([1-9])(?:限|時限)?/g;
    for (const match of text.matchAll(pattern)) {
      result.push({ day: match[1], period: Number(match[2]) });
    }
    return uniqueBy(result, (item) => `${item.day}-${item.period}`);
  }

  function filterCandidates(candidates, rawText) {
    let filtered = uniqueBy(candidates, (course) => course.courseCode || `${course.courseName}:${course.source?.document || ""}`);
    const termHints = extractTermHints(rawText);
    if (termHints.length) {
      const narrowed = filtered.filter((course) => termHints.some((hint) => {
        if (hint === "前期" || hint === "後期" || hint === "通年") {
          return (course.semesters || [course.semester]).includes(hint);
        }
        return (course.termBlocks || [course.termBlock]).includes(hint);
      }));
      if (narrowed.length) filtered = narrowed;
    }

    const meetingHints = extractMeetingHints(rawText);
    if (meetingHints.length) {
      const narrowed = filtered.filter((course) => meetingHints.some((hint) =>
        (course.meetings || []).some((meeting) => meeting.day === hint.day && Number(meeting.period) === hint.period)
      ));
      if (narrowed.length) filtered = narrowed;
    }

    if (filtered.length > 1) {
      const normalizedRaw = normalizeCourseName(rawText);
      const scored = filtered.map((course) => {
        let score = 0;
        if (normalizeCourseName(course.courseName) === normalizedRaw) score += 20;
        for (const instructor of course.instructors || []) {
          const normalizedInstructor = normalizeCourseName(instructor);
          if (normalizedInstructor.length >= 3 && normalizedRaw.includes(normalizedInstructor)) score += 8;
        }
        for (const className of course.classes || []) {
          const normalizedClass = normalizeCourseName(className);
          if (normalizedClass && normalizedRaw.includes(normalizedClass)) score += 2;
        }
        return { course, score };
      });
      const best = Math.max(...scored.map((item) => item.score));
      if (best > 0) {
        const narrowed = scored.filter((item) => item.score === best).map((item) => item.course);
        if (narrowed.length) filtered = narrowed;
      }
    }

    return filtered;
  }

  function aggregateCandidates(candidates, rawText, aliasKey) {
    const filtered = filterCandidates(candidates, rawText);
    if (!filtered.length) return null;
    if (filtered.length === 1) return filtered[0];

    const broad = filtered.length > 20;
    const material = broad ? filtered.slice(0, 20) : filtered;
    const first = material[0];
    const meetings = broad ? [] : uniqueBy(
      material.flatMap((course) => course.meetings || []).map((meeting) => ({
        ...meeting,
        rooms: Array.isArray(meeting.rooms) ? [...meeting.rooms] : (meeting.room ? [meeting.room] : [])
      })),
      (meeting) => `${meeting.day}-${meeting.period}-${meeting.termBlock || ""}-${(meeting.rooms || []).join("|")}-${meeting.campus || ""}`
    );
    const departments = uniqueBy(
      material.flatMap((course) => course.departments || []),
      (department) => `${department.code || ""}-${department.label || ""}-${department.sourceGroup || ""}`
    );
    const courseCodes = uniqueBy(filtered.map((course) => course.courseCode).filter(Boolean));
    const names = uniqueBy(filtered.map((course) => course.courseName).filter(Boolean));

    return {
      ...cloneCourse(first),
      courseName: names[0] || first.courseName,
      aliases: uniqueBy(material.flatMap((course) => [course.courseName, ...(course.aliases || [])])),
      courseCode: "",
      courseCodes,
      instructors: broad ? [] : uniqueBy(material.flatMap((course) => course.instructors || [])),
      meetings,
      departments,
      campuses: uniqueBy(material.flatMap((course) => course.campuses || [])),
      scheduleTypes: uniqueBy(material.flatMap((course) => course.scheduleTypes || [])),
      notes: broad ? [] : uniqueBy(material.flatMap((course) => course.notes || [])),
      sources: broad ? [] : uniqueBy(material.flatMap((course) => course.sources || []), (source) => `${source.id || ""}-${source.document || ""}-${source.page || ""}`),
      source: { document: "複数の時間割表", pages: [] },
      ambiguous: true,
      broadAmbiguous: broad,
      candidateCount: filtered.length,
      _matchKey: `ambiguous:${aliasKey}:${courseCodes.join(",")}`
    };
  }

  function findCourse(rawText) {
    const sourceText = String(rawText || "");
    for (const code of extractCourseCodes(sourceText)) {
      const direct = state.codeIndex.get(code);
      if (direct) return direct;
    }

    const normalized = normalizeCourseName(sourceText);
    if (!normalized || normalized.length < 3) return null;

    const exact = state.aliasIndex.get(normalized);
    if (exact?.length) return aggregateCandidates(exact, sourceText, normalized);

    let bestLength = 0;
    let bestAliases = [];
    for (const [alias, candidates] of state.searchAliases) {
      if (bestLength && alias.length < bestLength) break;
      if (!normalized.includes(alias)) continue;
      if (!bestLength) bestLength = alias.length;
      if (alias.length === bestLength) bestAliases.push([alias, candidates]);
    }
    if (!bestAliases.length) return null;

    const candidates = uniqueBy(bestAliases.flatMap(([, bucket]) => bucket), (course) => course.courseCode || course.courseName);
    return aggregateCandidates(candidates, sourceText, bestAliases.map(([alias]) => alias).join("+"));
  }

  function courseKey(course) {
    if (course?._matchKey) return course._matchKey;
    if (course?.courseCode) return normalizeCode(course.courseCode);
    return `name:${normalizeCourseName(course?.courseName || "")}`;
  }

  function shortInstructors(instructors, maxVisible = 2) {
    const list = uniqueBy(Array.isArray(instructors) ? instructors.filter(Boolean) : []);
    if (!list.length) return "未登録";
    if (list.length <= maxVisible) return list.join("・");
    return `${list.slice(0, maxVisible).join("・")} ほか${list.length - maxVisible}名`;
  }

  function meetingRooms(meeting) {
    return uniqueBy([...(meeting?.rooms || []), meeting?.room].filter(Boolean));
  }

  function humanizeRoom(room, compact = true) {
    const value = String(room || "").replace(/\s+/g, " ").trim();
    if (!value || value === "-") return "教室未定";
    if (/[,、/／]|実験室|研究室|体育|フォーラム|ワークショップ|PBL|サテライト|支援センター|設計製図室|会議室/i.test(value)) {
      return value;
    }
    let match = value.match(/^([1-9])([1-9])([A-Z])$/i);
    if (match) return `${match[1]}号館${match[2]}階・${value}${compact ? "" : "教室"}`;
    match = value.match(/^([1-9])B([A-Z])$/i);
    if (match) return `${match[1]}号館地下・${value}${compact ? "" : "教室"}`;
    return value;
  }

  function roomForMeeting(meeting, compact = true) {
    const rooms = meetingRooms(meeting).map((room) => humanizeRoom(room, compact));
    if (!rooms.length) return "教室未定";
    return rooms.length > 1 ? `${rooms.join(" / ")}（クラス別）` : rooms[0];
  }

  function periodTime(meeting) {
    const profiles = state.dataset?.dataset?.periodProfiles || {};
    const profileId = meeting?.timeProfile || "standard";
    const profile = profiles[profileId] || profiles.standard;
    const period = profile?.periods?.[String(meeting?.period)];
    if (!period) return "";
    return `${period.start}〜${period.end}`;
  }

  function specialTimeLabel(meeting) {
    if (meeting?.startsAtNine) return "9:00開始";
    if (meeting?.timeProfile === "joint-nuclear") return `${periodTime(meeting)}（共同原子力）`;
    return "";
  }

  function meetingLabel(meeting, includeRoom = false, includeTerm = false) {
    if (!meeting) return "";
    const parts = [];
    if (includeTerm && meeting.termBlock) parts.push(meeting.termBlock);
    parts.push(`${meeting.day || "?"}${meeting.period || "?"}`);
    const special = specialTimeLabel(meeting);
    if (special) parts.push(special);
    if (includeRoom) parts.push(roomForMeeting(meeting));
    return parts.join(" ");
  }

  function irregularScheduleLabel(course) {
    const types = course?.scheduleTypes || [];
    if (types.includes("intensive")) return "集中講義（日程は備考参照）";
    if (types.includes("all-year")) return "通年・時間外／日程別途";
    if ((course?.termBlocks || []).some((value) => String(value).includes("集中"))) return "集中講義（日程別途）";
    return "曜日・時限は別途指定";
  }

  function meetingsLabel(course, includeRoom = false) {
    if (course?.broadAmbiguous) return `同名科目候補 ${course.candidateCount}件（講義コードで要確認）`;
    const meetings = Array.isArray(course?.meetings) ? course.meetings : [];
    if (!meetings.length) return irregularScheduleLabel(course);
    const includeTerm = uniqueBy(meetings.map((meeting) => meeting.termBlock).filter(Boolean)).length > 1;
    const label = meetings.map((meeting) => meetingLabel(meeting, includeRoom, includeTerm)).join(" / ");
    return course?.ambiguous ? `候補 ${course.candidateCount}件: ${label}` : label;
  }

  function roomsLabel(course) {
    if (course?.broadAmbiguous) return "講義コードでクラス特定が必要";
    const rooms = uniqueBy((course?.meetings || []).flatMap(meetingRooms).map((room) => humanizeRoom(room)));
    if (!rooms.length) return (course?.meetings || []).length ? "教室未定" : "教室未定／時間外";
    const label = rooms.join(" / ");
    return course?.ambiguous ? `${label}（候補）` : label;
  }

  function campusesLabel(course) {
    const campuses = uniqueBy([
      ...(course?.campuses || []),
      ...(course?.meetings || []).map((meeting) => meeting.campus).filter(Boolean)
    ]);
    return campuses.length ? campuses.join(" / ") : "未登録";
  }

  function departmentsLabel(course) {
    const labels = uniqueBy((course?.departments || []).map((department) => department.label || department.code).filter(Boolean));
    if (!labels.length) return course?.level || "未登録";
    if (labels.length <= 3) return `${course?.level ? `${course.level}・` : ""}${labels.join(" / ")}`;
    return `${course?.level ? `${course.level}・` : ""}${labels.slice(0, 3).join(" / ")} ほか${labels.length - 3}`;
  }

  function sourceLabel(course) {
    if (course?.isUserOverride) return "ユーザー設定";
    if (course?.ambiguous) return `調査用候補 ${course.candidateCount}件`;
    const pages = course?.source?.pages;
    if (Array.isArray(pages) && pages.length) return `調査用・時間割表 p.${pages.join("・")}`;
    return "2026年度・調査用データ";
  }

  function datasetScopeLabel() {
    const scope = state.dataset?.dataset?.scope;
    if (!scope) return "2026年度全学時間割";
    return `調査用 ${scope.uniqueCourses || 0}科目・${scope.sourceDocuments?.length || 0}資料・${scope.timetablePages || 0}頁`;
  }

  function createTextElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text == null ? "" : String(text);
    return element;
  }

  function withOwnMutation(callback) {
    state.ownMutationDepth += 1;
    try {
      return callback();
    } finally {
      queueMicrotask(() => {
        state.ownMutationDepth = Math.max(0, state.ownMutationDepth - 1);
      });
    }
  }

  function applyRestyle(enabled) {
    applyThemeTokens();
    document.documentElement.classList.toggle("wcv-enabled", Boolean(enabled));
    document.body?.classList.toggle("wcv-restyle", Boolean(enabled));
  }

  function getCandidateElements() {
    const selectors = [
      "a", ".course", ".course-name", ".course_name", ".course-title", ".course_title",
      "[data-course-name]", "[data-course-code]", "td", "th", "h1", "h2", "h3"
    ];
    return Array.from(document.querySelectorAll(selectors.join(","))).slice(0, 3500);
  }

  function elementText(element) {
    if (!(element instanceof Element)) return "";
    const text = element.getAttribute("data-course-name") || element.innerText || element.textContent || "";
    return text.replace(/\s+/g, " ").trim();
  }

  function elementFingerprint(element) {
    if (!(element instanceof Element)) return "";
    const attributes = [
      element.getAttribute("data-course-name"),
      element.getAttribute("data-course-code"),
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("href"),
      element.id,
      elementText(element)
    ];
    return attributes.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function shouldConsiderElement(element, text) {
    if (!(element instanceof HTMLElement)) return false;
    if (!text || text.length < 3 || text.length > 260) return false;
    if (element.closest(".wcv-root, .wcv-inline-meta, #wcv-course-info-card, .wcv-native-course-card")) return false;
    if (NAVIGATION_WORDS.has(elementText(element))) return false;
    if (element.matches("script, style, textarea, input, select, option, button")) return false;
    if (element.tagName !== "A" && element.querySelector("a, [data-course-name], [data-course-code]")) return false;
    if (element.querySelector(".wcv-inline-meta, [data-wcv-annotated='true']")) return false;
    return true;
  }

  function createInlineMetadata(course) {
    const wrapper = document.createElement("span");
    wrapper.className = "wcv-inline-meta wcv-root";
    wrapper.setAttribute("role", "note");
    wrapper.setAttribute(
      "aria-label",
      `担当教員 ${course.broadAmbiguous ? "講義コードで要確認" : shortInstructors(course.instructors, 3)}、教室 ${roomsLabel(course)}、開講 ${meetingsLabel(course)}`
    );

    if (course.ambiguous) {
      wrapper.append(createTextElement(
        "span",
        "wcv-inline-chip wcv-inline-candidate",
        `同名候補 ${course.candidateCount}件`
      ));
    }
    wrapper.append(
      createTextElement("span", "wcv-inline-chip wcv-inline-room", `教室 ${roomsLabel(course)}`),
      createTextElement(
        "span",
        "wcv-inline-chip wcv-inline-teacher",
        `担当 ${course.broadAmbiguous ? "講義コードで要確認" : shortInstructors(course.instructors)}`
      ),
      createTextElement("span", "wcv-inline-chip wcv-inline-schedule", meetingsLabel(course))
    );
    return wrapper;
  }

  // コース画面内のリンクは全てURLに講義コードを含むため、行ごとのバッジは付けない（基本情報カードで表示）
  function isInsideCoursePage() {
    return /\/webclass\/course\.php\/[^/]+\//.test(location.pathname);
  }

  function injectInlineMetadata(element, course) {
    if (!state.settings.showInlineMetadata) return;
    if (isInsideCoursePage()) return;
    if (state.annotatedElements.has(element) || element.dataset?.wcvAnnotated === "true") return;
    const existing = element.nextElementSibling?.classList.contains("wcv-inline-meta") || element.querySelector(":scope > .wcv-inline-meta");
    if (existing) {
      state.annotatedElements.add(element);
      return;
    }

    withOwnMutation(() => {
      const metadata = createInlineMetadata(course);
      if (element.tagName === "A" || element.matches("h1, h2, h3")) element.insertAdjacentElement("afterend", metadata);
      else element.append(metadata);
      element.dataset.wcvAnnotated = "true";
      element.classList.add("wcv-course-hit");
      state.annotatedElements.add(element);
    });
  }

  function scanCourseElements() {
    const detected = new Map(state.nativeDetectedCourses);
    for (const element of getCandidateElements()) {
      const fingerprint = elementFingerprint(element);
      if (!shouldConsiderElement(element, fingerprint)) continue;
      const course = findCourse(fingerprint);
      if (!course) continue;
      detected.set(courseKey(course), course);
      injectInlineMetadata(element, course);
    }
    state.detectedCourses = detected;
  }

  function findCurrentCourse() {
    const selectors = [
      "[data-course-name]", "[data-course-code]", "#course_name", "#courseName",
      ".course-name", ".course_name", ".course-title", ".course_title",
      "main h1", "main h2", "#main h1", "#main h2",
      ".breadcrumb li:last-child", ".bread_crumb li:last-child", "h1", "h2"
    ];
    const candidates = [];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) candidates.push(elementFingerprint(element));
    }
    candidates.push(document.title || "", location.href || "");
    for (const candidate of candidates) {
      const course = findCourse(candidate);
      if (course) return course;
    }
    if (state.detectedCourses.size === 1) return [...state.detectedCourses.values()][0];
    return null;
  }

  function createDefinitionRow(label, value, modifier = "") {
    const row = document.createElement("div");
    row.className = `wcv-definition-row ${modifier}`.trim();
    row.append(
      createTextElement("dt", "wcv-definition-label", label),
      createTextElement("dd", "wcv-definition-value", value)
    );
    return row;
  }

  function notesLabel(course) {
    const notes = uniqueBy(course?.notes || []);
    if (!notes.length) return "";
    const joined = notes.slice(0, 3).join(" / ");
    return notes.length > 3 ? `${joined} ほか${notes.length - 3}件` : joined;
  }

  function courseCodeLabel(course) {
    if (course?.courseCode) return course.courseCode;
    const codes = course?.courseCodes || [];
    if (!codes.length) return "未特定";
    if (codes.length <= 4) return codes.join(" / ");
    return `${codes.slice(0, 4).join(" / ")} ほか${codes.length - 4}件`;
  }

  function findHistoricalReferences(course) {
    const codes = new Set(uniqueBy([course?.courseCode, ...(course?.courseCodes || [])]
      .map(normalizeCode).filter(Boolean)));
    const names = new Set(uniqueBy([course?.courseName, ...(course?.aliases || [])]
      .map(normalizeExactCourseTitle).filter(Boolean)));
    return state.historicalEvidence
      .map((record) => {
        const sameCode = codes.has(normalizeCode(record.courseCode));
        const titleKey = normalizeExactCourseTitle(record.courseName);
        const sameTitle = Boolean(titleKey) && names.has(titleKey);
        return sameCode || sameTitle ? { ...record, matchKind: sameCode ? "same-code" : "same-title" } : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a.matchKind === b.matchKind ? 0 : a.matchKind === "same-code" ? -1 : 1)
        || b.academicYear - a.academicYear
        || Number(b.reviewStatus === "visually-reviewed-provisional") - Number(a.reviewStatus === "visually-reviewed-provisional")
        || String(a.courseCode).localeCompare(String(b.courseCode), "ja")
        || (a.sourceLocations?.[0]?.page || 0) - (b.sourceLocations?.[0]?.page || 0));
  }

  function historicalSourcePageUrl(record, page) {
    try {
      const url = new URL(record?.source?.url || "");
      if (url.protocol !== "https:" || !["asc.tcu.ac.jp", "www.asc.tcu.ac.jp"].includes(url.hostname)) return "";
      const pageNumber = Number(page);
      if (!Number.isInteger(pageNumber) || pageNumber < 1) return "";
      url.hash = `page=${pageNumber}`;
      return url.href;
    } catch (_error) {
      return "";
    }
  }

  function createHistoricalEvidenceSection(course) {
    const records = findHistoricalReferences(course);
    if (!records.length) return null;

    const section = document.createElement("section");
    section.className = "wcv-history-evidence";
    section.setAttribute("aria-label", "過年度時間割PDFの掲載行候補");
    section.append(
      createTextElement("h3", "wcv-history-heading", `過年度PDFの関連行候補（${records.length}件）`),
      createTextElement(
        "p",
        "wcv-history-caveat",
        "対象は2022〜2025年度の公式時間割PDFです。目視確認済みは一部のみで、他は自動抽出候補です。科目名・担当・教室をPDFで確認してください。科目の継続や現在の開講を示すものではありません。"
      )
    );

    const list = document.createElement("ul");
    list.className = "wcv-history-list";
    const sameCode = records.filter((record) => record.matchKind === "same-code");
    const sameTitle = records.filter((record) => record.matchKind === "same-title");
    const chooseDistinct = (items, keyOf, limit) => {
      const chosen = [];
      const seen = new Set();
      for (const item of items) {
        const key = keyOf(item);
        if (seen.has(key)) continue;
        seen.add(key);
        chosen.push(item);
        if (chosen.length >= limit) break;
      }
      return chosen;
    };
    const initialRecords = [
      ...chooseDistinct(sameCode, (record) => record.academicYear, 4),
      ...chooseDistinct(sameTitle, (record) => record.courseCode, 4)
    ];
    const included = new Set(initialRecords);
    for (const record of records) {
      if (initialRecords.length >= 8) break;
      if (!included.has(record)) {
        initialRecords.push(record);
        included.add(record);
      }
    }
    const remainingRecords = records.filter((record) => !included.has(record));
    const displayOrder = [...initialRecords, ...remainingRecords];

    const renderRecord = (record) => {
      const item = document.createElement("li");
      item.className = "wcv-history-record";
      const head = document.createElement("div");
      head.className = "wcv-history-record-head";
      const visuallyReviewed = record.reviewStatus === "visually-reviewed-provisional";
      const reviewLabel = visuallyReviewed
        ? "PDF目視確認済み・参考"
        : record.parseStatus === "cell-anchored-row"
          ? "PDF抽出候補・未確認"
          : record.parseStatus === "positional-inference"
            ? "配置推定・要確認"
            : "要確認の抽出候補";
      head.append(
        createTextElement("strong", "wcv-history-year", `${record.academicYear}年度`),
        createTextElement(
          "span",
          "wcv-history-match",
          record.matchKind === "same-code" ? "同一講義コード・科目の継続は未判定" : "同名・別コード（科目同一性は未判定）"
        ),
        createTextElement("span", `wcv-history-status${visuallyReviewed ? " is-reviewed" : ""}`, reviewLabel)
      );
      item.append(head, createTextElement("div", "wcv-history-title", record.courseName || "科目名の抽出候補なし"));
      item.append(createTextElement("div", "wcv-history-meta", `講義コード：${record.courseCode}`));
      const teachers = visuallyReviewed
        ? (Array.isArray(record.instructors) && record.instructors.length ? record.instructors.join("・") : "担当教員欄の目視記録なし")
        : (record.instructorText || "担当教員の抽出候補なし");
      item.append(createTextElement("div", "wcv-history-meta", `${visuallyReviewed ? "担当（目視確認）" : "担当候補（抽出）"}：${teachers}`));

      const room = visuallyReviewed
        ? (record.roomStatus === "listed"
          ? (record.room && record.room !== "-" ? `教室（目視確認）：${record.room}` : "教室欄（目視確認）：『-』")
          : record.roomStatus === "blank-in-source" ? "教室欄（目視確認）：空欄" : "教室の目視記録なし")
        : (record.room ? `教室候補（抽出）：${record.room}` : "教室の抽出候補なし");
      item.append(createTextElement("div", "wcv-history-meta", room));

      const schedules = (Array.isArray(record.scheduleCandidates) ? record.scheduleCandidates : [])
        .map((candidate) => [
          candidate.termCandidate ? `開講期 ${candidate.termCandidate}` : "",
          candidate.dayCandidate ? `曜日 ${candidate.dayCandidate}` : "",
          candidate.periodCandidate ? `時限 ${candidate.periodCandidate}` : ""
        ].filter(Boolean).join(" / "))
        .filter(Boolean);
      if (schedules.length) {
        const scheduleLabel = schedules.length > 1 ? `時間割欄候補（PDF抽出・${schedules.length}通り）` : "時間割欄候補（PDF抽出）";
        item.append(createTextElement("div", "wcv-history-meta", `${scheduleLabel}：${schedules.join(" ／ ")}`));
      }

      const sourceLinks = document.createElement("div");
      sourceLinks.className = "wcv-history-sources";
      const locations = Array.isArray(record.sourceLocations) ? record.sourceLocations : [];
      for (const location of locations.slice(0, 4)) {
        const sourceUrl = historicalSourcePageUrl(record, location.page);
        if (sourceUrl) {
          const sourceLink = createTextElement("a", "wcv-history-source", `PDF p.${location.page} ↗`);
          sourceLink.href = sourceUrl;
          sourceLink.target = "_blank";
          sourceLink.rel = "noopener noreferrer";
          sourceLink.title = record.source?.title || "教学課の時間割PDF";
          sourceLink.setAttribute("aria-label", `${record.academicYear}年度 ${record.courseCode} の時間割PDF ${location.page}ページを開く`);
          sourceLinks.append(sourceLink);
        } else {
          sourceLinks.append(createTextElement("span", "wcv-history-source", `PDF p.${location.page}`));
        }
      }
      if (locations.length > 4) sourceLinks.append(createTextElement("span", "wcv-history-meta", `ほか${locations.length - 4}頁`));
      if (sourceLinks.childElementCount) item.append(sourceLinks);
      return item;
    };

    for (const record of initialRecords) list.append(renderRecord(record));
    section.append(list);
    let shownCount = initialRecords.length;
    if (displayOrder.length > shownCount) {
      const expand = document.createElement("button");
      expand.type = "button";
      expand.className = "wcv-history-expand";
      const updateExpandLabel = () => {
        const remaining = displayOrder.length - shownCount;
        expand.textContent = `次の最大40件を表示（残り${remaining}件）`;
      };
      updateExpandLabel();
      expand.setAttribute("aria-expanded", "false");
      expand.addEventListener("click", () => {
        const nextRecords = displayOrder.slice(shownCount, shownCount + 40);
        nextRecords.forEach((record) => list.append(renderRecord(record)));
        shownCount += nextRecords.length;
        expand.setAttribute("aria-expanded", "true");
        if (shownCount >= displayOrder.length) expand.remove();
        else updateExpandLabel();
      });
      section.append(expand);
    }
    return section;
  }

  function createCourseInfoCard(course) {
    const card = document.createElement("section");
    card.id = UI_IDS.courseCard;
    card.className = "wcv-course-info-card wcv-root";
    card.setAttribute("aria-label", "授業基本情報");

    const head = document.createElement("div");
    head.className = "wcv-course-card-head";
    const titleBlock = document.createElement("div");
    titleBlock.className = "wcv-course-card-title-block";
    titleBlock.append(
      createTextElement(
        "div",
        "wcv-course-card-kicker",
        `${course.academicYear || 2026}年度 ${course.termBlock || course.semester || ""} ・ ${campusesLabel(course)}`.trim()
      ),
      createTextElement("h2", "wcv-course-card-title", course.courseName)
    );
    if (course.ambiguous) {
      titleBlock.append(createTextElement(
        "span",
        "wcv-course-candidate-badge",
        course.broadAmbiguous
          ? `同名科目 ${course.candidateCount}件 - 講義コードで特定が必要`
          : `同名科目候補 ${course.candidateCount}件を統合表示`
      ));
    }

    const badge = createTextElement("span", "wcv-source-badge", sourceLabel(course));
    if (!state.settings.showSourceLabel) badge.hidden = true;
    head.append(titleBlock, badge);

    // 主要3項目は常時表示、補助項目は「詳細」で開く
    const keyList = document.createElement("dl");
    keyList.className = "wcv-definition-list wcv-key-list";
    keyList.append(
      createDefinitionRow("担当教員", course.broadAmbiguous ? "講義コードでクラスを特定してください" : shortInstructors(course.instructors, 5), "wcv-teacher-row"),
      createDefinitionRow("教室", roomsLabel(course), "wcv-room-row"),
      createDefinitionRow("曜日・時限", meetingsLabel(course, roomsLabel(course).includes(" / ")), "wcv-schedule-row")
    );

    const more = document.createElement("div");
    more.className = "wcv-course-more";
    more.id = "wcv-course-more";
    more.hidden = true;
    const moreList = document.createElement("dl");
    moreList.className = "wcv-definition-list wcv-more-list";
    moreList.append(
      createDefinitionRow("キャンパス", campusesLabel(course), "wcv-campus-row"),
      createDefinitionRow("対象", departmentsLabel(course), "wcv-department-row"),
      createDefinitionRow(course.ambiguous ? "講義コード候補" : "講義コード", courseCodeLabel(course), "wcv-code-row")
    );
    const noteText = notesLabel(course);
    if (noteText) moreList.append(createDefinitionRow("備考", noteText, "wcv-note-row"));
    const note = createTextElement(
      "p",
      "wcv-course-card-note",
      "現在の授業情報は2026年度時間割の調査用スナップショットです。現行資料との全件照合と履修要覧の要件登録は未完了です。休講・教室変更はWebClassのお知らせを優先してください。"
    );
    more.append(moreList);
    const historical = createHistoricalEvidenceSection(course);
    if (historical) more.append(historical);
    more.append(note);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "wcv-course-card-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", "wcv-course-more");
    toggle.textContent = "詳細を見る";
    toggle.addEventListener("click", () => {
      const open = more.hidden;
      more.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "閉じる" : "詳細を見る";
    });
    head.append(toggle);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "wcv-course-card-close";
    close.setAttribute("aria-label", "授業情報カードを閉じる");
    close.textContent = "×";
    close.addEventListener("click", () => card.remove());
    card.append(close, head, keyList, more);
    return card;
  }

  function findSafeMainContainer() {
    // コース画面では、教材一覧と同じ幅のコンテナに入れて枠を揃える
    const contents = document.querySelector(".cm-contentsList");
    const aligned = contents?.closest(".container, .container-fluid");
    if (aligned instanceof HTMLElement && aligned.offsetWidth > 360) return aligned;
    for (const selector of ["main", "#main", "#content", ".main-content", ".page-content", ".container-fluid", ".container"]) {
      const element = document.querySelector(selector);
      if (element instanceof HTMLElement && element.offsetWidth > 360) return element;
    }
    return document.body;
  }

  function injectCurrentCourseCard(course) {
    const existing = document.getElementById(UI_IDS.courseCard);
    if (!course) {
      existing?.remove();
      return;
    }
    if (existing?.dataset.courseKey === courseKey(course)) return;
    existing?.remove();
    withOwnMutation(() => {
      const card = createCourseInfoCard(course);
      card.dataset.courseKey = courseKey(course);
      const container = findSafeMainContainer();
      if (container === document.body) document.body.insertBefore(card, document.body.firstElementChild);
      else container.prepend(card);
    });
  }

  function createPanelCourseItem(course) {
    const item = document.createElement("article");
    item.className = "wcv-panel-course";
    const title = createTextElement("h3", "wcv-panel-course-title", course.courseName);
    if (course.ambiguous) title.append(createTextElement("span", "wcv-panel-candidate", `${course.candidateCount}候補`));
    const meta = document.createElement("div");
    meta.className = "wcv-panel-course-meta";
    meta.append(
      createTextElement("div", "wcv-panel-meta-line wcv-panel-room", `教室  ${roomsLabel(course)}`),
      createTextElement("div", "wcv-panel-meta-line wcv-panel-teacher", `担当  ${course.broadAmbiguous ? "講義コードで要確認" : shortInstructors(course.instructors, 3)}`),
      createTextElement("div", "wcv-panel-meta-line wcv-panel-time", `開講  ${meetingsLabel(course)}`),
      createTextElement("div", "wcv-panel-meta-line wcv-panel-campus", `場所  ${campusesLabel(course)}`)
    );
    item.append(title, meta);
    return item;
  }

  function updatePanelContents() {
    const panel = document.getElementById(UI_IDS.panel);
    if (!panel) return;
    const body = panel.querySelector(".wcv-panel-body");
    const count = panel.querySelector(".wcv-panel-count");
    if (!body || !count) return;
    const courses = state.currentCourse ? [state.currentCourse] : [...state.detectedCourses.values()].slice(0, 10);
    const signature = courses.map(courseKey).join("|");
    if (body.dataset.signature === signature) {
      const nextCount = `${courses.length}件`;
      if (count.textContent !== nextCount) count.textContent = nextCount;
      return;
    }
    body.dataset.signature = signature;
    body.replaceChildren();
    count.textContent = `${courses.length}件`;
    if (!courses.length) {
      const empty = document.createElement("div");
      empty.className = "wcv-panel-empty";
      empty.append(
        createTextElement("strong", "", "この画面では授業名を検出できませんでした。"),
        createTextElement("p", "", "講義コードが表示される画面では最優先で照合します。表記差は設定画面の別名・上書きJSONで補正できます。")
      );
      body.append(empty);
      return;
    }
    for (const course of courses) body.append(createPanelCourseItem(course));
  }

  function ensureFloatingPanel() {
    const launcher = document.getElementById(UI_IDS.launcher);
    const panel = document.getElementById(UI_IDS.panel);
    if (!state.settings.showFloatingPanel) {
      launcher?.remove();
      panel?.remove();
      return;
    }
    if (launcher && panel) {
      updatePanelContents();
      return;
    }

    withOwnMutation(() => {
      const newLauncher = document.createElement("button");
      newLauncher.id = UI_IDS.launcher;
      newLauncher.className = "wcv-launcher wcv-root";
      newLauncher.type = "button";
      newLauncher.setAttribute("aria-controls", UI_IDS.panel);
      newLauncher.setAttribute("aria-expanded", "false");
      newLauncher.innerHTML = '<span class="wcv-launcher-icon" aria-hidden="true"></span><span>授業情報</span>';

      const newPanel = document.createElement("aside");
      newPanel.id = UI_IDS.panel;
      newPanel.className = "wcv-panel wcv-root";
      newPanel.hidden = true;
      newPanel.setAttribute("aria-label", "検出した授業情報");

      const header = document.createElement("div");
      header.className = "wcv-panel-header";
      const heading = document.createElement("div");
      heading.append(
        createTextElement("div", "wcv-panel-eyebrow", "WebClass補助表示・全学科版"),
        createTextElement("h2", "wcv-panel-title", "授業情報")
      );
      const count = createTextElement("span", "wcv-panel-count", "0件");
      const close = document.createElement("button");
      close.type = "button";
      close.className = "wcv-panel-close";
      close.setAttribute("aria-label", "授業情報パネルを閉じる");
      close.textContent = "×";
      header.append(heading, count, close);

      const body = document.createElement("div");
      body.className = "wcv-panel-body";
      const footer = document.createElement("div");
      footer.className = "wcv-panel-footer";
      const source = createTextElement("span", "", datasetScopeLabel());
      const settingsButton = document.createElement("button");
      settingsButton.type = "button";
      settingsButton.className = "wcv-panel-settings";
      settingsButton.textContent = "表示設定";
      settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
      footer.append(source, settingsButton);
      newPanel.append(header, body, footer);

      const setOpen = (open) => {
        newPanel.hidden = !open;
        newLauncher.setAttribute("aria-expanded", String(open));
        if (open) updatePanelContents();
      };
      newLauncher.addEventListener("click", () => setOpen(newPanel.hidden));
      close.addEventListener("click", () => setOpen(false));
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !newPanel.hidden) setOpen(false);
      });
      document.body.append(newLauncher, newPanel);
      updatePanelContents();
    });
  }


  function nativeMainColumns() {
    const row = document.querySelector("main#js-main > .container > .row");
    if (!row) return {};
    const direct = Array.from(row.children).filter((element) => element instanceof HTMLElement);
    return {
      row,
      sidebar: direct.find((element) => element.matches(".col-sm-3, .col-md-3")) || null,
      content: direct.find((element) => element.matches(".col-sm-9, .col-md-9")) || null
    };
  }

  function categoryLabel(course) {
    return course?.category || "授業";
  }

  function nativeMeetingFor(course, day, period) {
    const meetings = course?.meetings || [];
    return meetings.find((meeting) => meeting.day === day && Number(meeting.period) === Number(period))
      || meetings.find((meeting) => Number(meeting.period) === Number(period))
      || meetings[0]
      || null;
  }

  function nativePeriodLabel(period) {
    const profile = state.dataset?.dataset?.periodProfiles?.standard?.periods?.[String(period)];
    return profile ? `${profile.start}〜${profile.end}` : "";
  }

  function compactStatusText(text) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    const unread = normalized.match(/新着メッセージ\s*\((\d+)\)/);
    if (unread) return `新着 ${unread[1]}`;
    if (/締切が近い課題/.test(normalized)) return "締切間近";
    return normalized.replace(/[。.]$/, "").slice(0, 24);
  }

  function createNativeMetaLine(className, label, value) {
    const line = document.createElement("span");
    line.className = `wcv-native-card-meta-line ${className}`;
    line.append(
      createTextElement("span", "wcv-native-card-meta-label", label),
      createTextElement("span", "wcv-native-card-meta-value", value)
    );
    return line;
  }

  function enhanceNativeCourseAnchor(anchor, course, day, period) {
    if (!(anchor instanceof HTMLAnchorElement) || !course) return;
    if (anchor.dataset.wcvNativeEnhanced === "true") return;
    rememberNativeElement(anchor);

    const rawStatus = Array.from(anchor.querySelectorAll(".course-new-message, .course-contents-info, .badge"))
      .map((element) => element.textContent)
      .map(compactStatusText)
      .filter(Boolean);
    const meeting = nativeMeetingFor(course, day, period);
    const room = meeting ? roomForMeeting(meeting) : roomsLabel(course);
    const teacher = course.broadAmbiguous ? "講義コードで要確認" : shortInstructors(course.instructors, 2);

    anchor.innerHTML = "";
    addNativeClass(anchor, "wcv-native-course-card", categoryClass(course));
    anchor.dataset.wcvNativeEnhanced = "true";
    anchor.dataset.wcvAnnotated = "true";
    anchor.dataset.wcvCourseCode = course.courseCode || "";
    anchor.setAttribute("aria-label", `${course.courseName}、教室 ${room}、担当 ${teacher}`);
    anchor.title = `${course.courseName}\n教室: ${room}\n担当: ${teacher}\n講義コード: ${course.courseCode || "未特定"}`;

    const top = document.createElement("span");
    top.className = "wcv-native-card-top";
    top.append(
      createTextElement("span", "wcv-native-card-title", course.courseName),
      createTextElement("span", "wcv-native-card-category", categoryLabel(course))
    );

    const meta = document.createElement("span");
    meta.className = "wcv-native-card-meta";
    meta.append(
      createNativeMetaLine("wcv-native-card-room", "教室", room),
      createNativeMetaLine("wcv-native-card-teacher", "担当", teacher)
    );
    if (meeting?.campus && !String(room).includes("キャンパス")) {
      meta.append(createNativeMetaLine("wcv-native-card-campus", "場所", meeting.campus.replace("キャンパス", "")));
    }

    const statuses = uniqueBy(rawStatus);
    const statusWrap = document.createElement("span");
    statusWrap.className = "wcv-native-card-statuses";
    for (const status of statuses.slice(0, 3)) {
      const kind = /締切/.test(status) ? "wcv-native-status-deadline" : "wcv-native-status-new";
      statusWrap.append(createTextElement("span", `wcv-native-status ${kind}`, status));
    }

    anchor.append(top, meta);
    if (statuses.length) anchor.append(statusWrap);
  }

  function enhanceNativeScheduleTable() {
    const table = document.querySelector("#schedule-table");
    state.nativeDetectedCourses = new Map();
    if (!table) return;
    addNativeClass(table, "wcv-native-schedule-table");
    addNativeClass(table.closest(".table-responsive") || table.parentElement, "wcv-native-schedule-viewport");
    const dayHeaders = Array.from(table.querySelectorAll("thead th")).slice(1).map((header) => {
      const match = String(header.textContent || "").match(/[月火水木金土日]/);
      return match ? match[0] : "";
    });

    for (const row of table.querySelectorAll("tbody tr")) {
      const period = Number(row.dataset.class_order || String(row.firstElementChild?.textContent || "").match(/\d+/)?.[0]);
      const cells = Array.from(row.children);
      if (cells[0] && Number.isInteger(period) && cells[0].dataset.wcvNativePeriodEnhanced !== "true") {
        rememberNativeElement(cells[0]);
        cells[0].innerHTML = "";
        addNativeClass(cells[0], "wcv-native-period-cell");
        cells[0].dataset.wcvNativePeriodEnhanced = "true";
        cells[0].append(
          createTextElement("strong", "", `${period}限`),
          createTextElement("span", "", nativePeriodLabel(period))
        );
      }
      cells.slice(1).forEach((cell, index) => {
        addNativeClass(cell, "wcv-native-schedule-cell");
        const day = dayHeaders[index] || "";
        for (const anchor of cell.querySelectorAll("a[href*='/webclass/course.php/']")) {
          const course = findCourse(`${anchor.href} ${anchor.textContent || ""}`);
          if (!course) continue;
          state.nativeDetectedCourses.set(courseKey(course), course);
          enhanceNativeCourseAnchor(anchor, course, day, period);
        }
      });
    }
  }

  function enhanceNativeMobileSchedule() {
    const schedule = document.querySelector(".schedule-list");
    if (!schedule) return;
    addNativeClass(schedule, "wcv-native-mobile-schedule");
    let day = "";
    let period = null;
    for (const child of Array.from(schedule.children)) {
      if (child.classList.contains("list-group-label-item")) {
        day = String(child.textContent || "").match(/[月火水木金土日]/)?.[0] || day;
        continue;
      }
      if (child.classList.contains("class-order")) {
        period = Number(String(child.textContent || "").match(/\d+/)?.[0]);
        continue;
      }
      if (child.matches("a[href*='/webclass/course.php/']")) {
        const course = findCourse(`${child.href} ${child.textContent || ""}`);
        if (course) {
          state.nativeDetectedCourses.set(courseKey(course), course);
          enhanceNativeCourseAnchor(child, course, day, period);
        }
      }
    }
  }

  function createSidebarToggle(key, title, description) {
    const label = document.createElement("label");
    label.className = "wcv-sidebar-toggle";
    const text = document.createElement("span");
    text.append(
      createTextElement("strong", "", title),
      createTextElement("small", "", description)
    );
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(state.settings[key]);
    input.addEventListener("change", () => chrome.storage.local.set({ [key]: input.checked }));
    label.append(input, createTextElement("span", "wcv-sidebar-switch", ""), text);
    return label;
  }

  function ensureSidebarTools(sidebar) {
    const existing = document.getElementById(UI_IDS.sidebarTools);
    if (!state.settings.showSidebarTools || !sidebar) {
      existing?.remove();
      return;
    }
    if (existing) {
      const inputs = existing.querySelectorAll("input[data-setting]");
      for (const input of inputs) input.checked = Boolean(state.settings[input.dataset.setting]);
      return;
    }

    const root = document.createElement("div");
    root.id = UI_IDS.sidebarTools;
    root.className = "wcv-sidebar-tools wcv-root wcv-native-injected";
    const options = document.createElement("section");
    options.className = "wcv-sidebar-card";
    options.append(createTextElement("h4", "wcv-sidebar-title", "表示オプション"));
    for (const [key, title, description] of [
      ["modernizeNativeLayout", "時間割をカード表示", "元の時間割をそのまま読みやすく整える"],
      ["showInlineMetadata", "担当・教室を補足", "その他のコースにも授業情報を追加"],
      ["showEnhancedTimetable", "補助時間割を別表示", "検出科目を別の週間表でも確認"]
    ]) {
      const toggle = createSidebarToggle(key, title, description);
      toggle.querySelector("input").dataset.setting = key;
      options.append(toggle);
    }

    const legend = document.createElement("section");
    legend.className = "wcv-sidebar-card";
    legend.append(createTextElement("h4", "wcv-sidebar-title", "授業カテゴリ（色分け）"));
    const list = document.createElement("div");
    list.className = "wcv-sidebar-legend";
    for (const [className, label] of [
      ["wcv-category-specialist", "専門科目"],
      ["wcv-category-foundation", "基礎科目"],
      ["wcv-category-exercise", "実験・演習"],
      ["wcv-category-information", "情報・通信"]
    ]) list.append(createTextElement("span", className, label));
    legend.append(list);
    root.append(options, legend);
    sidebar.append(root);
  }

  function enhanceNativeCourseListArea(form) {
    if (!form) return;
    const heading = Array.from(form.children).find((element) => element.tagName === "H4" && /その他のコース/.test(element.textContent || ""));
    if (heading) addNativeClass(heading, "wcv-native-other-heading");
    const search = form.querySelector("#search_courses_left, #search_courses_right");
    if (search) addNativeClass(search, "wcv-native-course-search");
    for (const tree of form.querySelectorAll(".courseTree")) addNativeClass(tree, "wcv-native-course-tree");
    for (const levelTitle of form.querySelectorAll(".courseTree-levelTitle")) addNativeClass(levelTitle, "wcv-native-course-group-title");
    for (const item of form.querySelectorAll("ul.courseList > li")) addNativeClass(item, "wcv-native-course-list-item");
  }

  function updateNativeCourseCount() {
    const heading = document.querySelector("main#js-main h3.page-header");
    if (!heading || !/参加しているコース/.test(heading.textContent || "")) return;
    let badge = document.getElementById(UI_IDS.nativeCourseCount);
    if (!badge) {
      badge = createTextElement("span", "wcv-native-course-count wcv-native-injected", "");
      badge.id = UI_IDS.nativeCourseCount;
      heading.append(badge);
    }
    const scheduleCodes = uniqueBy(Array.from(document.querySelectorAll("#schedule-table a[href*='/webclass/course.php/']"))
      .flatMap((anchor) => extractCourseCodes(`${anchor.href} ${anchor.textContent || ""}`))
      .filter((code) => state.codeIndex.has(code)));
    const nextText = `${scheduleCodes.length}科目`;
    if (badge.textContent !== nextText) badge.textContent = nextText;
  }

  function enhanceNativeWebClassLayout() {
    if (!state.settings.modernizeNativeLayout) {
      restoreNativeEnhancements();
      return;
    }
    const { row, sidebar, content } = nativeMainColumns();
    if (!row || !content) return;
    addNativeClass(document.querySelector("main#js-main"), "wcv-native-main");
    addNativeClass(row.parentElement, "wcv-native-container");
    addNativeClass(row, "wcv-native-layout-row");
    addNativeClass(sidebar, "wcv-native-sidebar");
    addNativeClass(content, "wcv-native-content");
    addNativeClass(document.querySelector("header .navbar"), "wcv-native-navbar");
    for (const block of sidebar?.querySelectorAll(".side-block") || []) addNativeClass(block, "wcv-native-side-block");
    addNativeClass(content.querySelector("#UserTopInfo"), "wcv-native-notices");
    const heading = content.querySelector("h3.page-header");
    if (heading && /参加しているコース/.test(heading.textContent || "")) addNativeClass(heading, "wcv-native-course-heading");
    const form = content.querySelector("form[name='condition'], form.form-inline");
    if (form) {
      addNativeClass(form, "wcv-native-course-form");
      const directHeadings = Array.from(form.children).filter((element) => element.tagName === "H4");
      if (directHeadings[0]) addNativeClass(directHeadings[0], "wcv-native-semester-heading");
      if (directHeadings[1]) addNativeClass(directHeadings[1], "wcv-native-timetable-heading");
      const selectWrap = directHeadings[0]?.nextElementSibling;
      if (selectWrap) addNativeClass(selectWrap, "wcv-native-semester-controls");
      const tableViewport = form.querySelector("#schedule-table")?.closest(".table-responsive");
      const addCourse = tableViewport?.nextElementSibling?.nextElementSibling || tableViewport?.nextElementSibling;
      if (addCourse && /コースを追加/.test(addCourse.textContent || "")) addNativeClass(addCourse, "wcv-native-add-course");
      enhanceNativeCourseListArea(form);
    }
    ensureSidebarTools(sidebar);
    enhanceNativeScheduleTable();
    enhanceNativeMobileSchedule();
    updateNativeCourseCount();
  }

  function isLikelyTimetablePage() {
    const pageText = (document.body?.innerText || "").slice(0, 18000);
    if (/時間割|参加しているコース|コースリスト|履修中のコース/.test(pageText)) return true;
    return state.detectedCourses.size >= 3 && /webclass/i.test(document.title || "");
  }

  function categoryClass(course) {
    const category = course?.category || "";
    if (category.includes("実験") || category.includes("演習")) return "wcv-category-exercise";
    if (category.includes("基礎")) return "wcv-category-foundation";
    if (category.includes("情報") || category.includes("通信")) return "wcv-category-information";
    return "wcv-category-specialist";
  }

  function createTimetableCourseCard(course, meeting) {
    const card = document.createElement("article");
    card.className = `wcv-timetable-course-card ${categoryClass(course)}${course.ambiguous ? " wcv-timetable-ambiguous" : ""}`;
    card.dataset.courseCode = course.courseCode || courseKey(course);
    card.setAttribute("aria-label", `${course.courseName}、${meetingLabel(meeting, true)}、担当 ${shortInstructors(course.instructors, 4)}`);
    const title = createTextElement("h4", "wcv-timetable-course-title", course.courseName);
    const category = createTextElement("span", "wcv-timetable-category", course.ambiguous ? `${course.candidateCount}候補` : (course.category || "授業"));
    const meta = document.createElement("div");
    meta.className = "wcv-timetable-course-meta";
    meta.append(
      createTextElement("div", "wcv-timetable-room", `教室  ${roomForMeeting(meeting)}`),
      createTextElement("div", "wcv-timetable-teacher", `担当  ${course.broadAmbiguous ? "要特定" : shortInstructors(course.instructors, 2)}`)
    );
    const special = specialTimeLabel(meeting);
    if (special) meta.append(createTextElement("div", "wcv-timetable-special-time", `時刻  ${special}`));
    if (meeting.campus) meta.append(createTextElement("div", "wcv-timetable-campus", `場所  ${meeting.campus}`));
    card.append(title, category, meta);
    return card;
  }

  function createIrregularCourseItem(course) {
    const item = document.createElement("article");
    item.className = `wcv-irregular-course ${categoryClass(course)}`;
    item.append(
      createTextElement("h4", "wcv-irregular-title", course.courseName),
      createTextElement("div", "wcv-irregular-meta", `${irregularScheduleLabel(course)} / 担当 ${shortInstructors(course.instructors, 2)} / ${campusesLabel(course)}`)
    );
    return item;
  }

  function standardPeriods() {
    const profile = state.dataset?.dataset?.periodProfiles?.standard?.periods || {};
    return [1, 2, 3, 4, 5].map((period) => ({
      period,
      time: profile[String(period)] ? `${profile[String(period)].start}〜${profile[String(period)].end}` : ""
    }));
  }

  function createEnhancedTimetable(courses) {
    const section = document.createElement("section");
    section.id = UI_IDS.enhancedTimetable;
    section.className = "wcv-enhanced-timetable wcv-root";
    section.setAttribute("aria-label", "担当教員・教室つき時間割");

    const header = document.createElement("div");
    header.className = "wcv-enhanced-timetable-header";
    const titleBlock = document.createElement("div");
    titleBlock.append(
      createTextElement("div", "wcv-enhanced-eyebrow", "WebClass表示改善プロトタイプ・全学科版"),
      createTextElement("h2", "wcv-enhanced-title", "担当教員・教室つき時間割"),
      createTextElement("p", "wcv-enhanced-subtitle", "このページで検出した科目を、2026年度の学部・大学院時間割データと講義コード／科目名で照合しています。")
    );
    const summary = document.createElement("div");
    summary.className = "wcv-enhanced-summary";
    summary.append(
      createTextElement("strong", "", `${courses.length}科目`),
      createTextElement("span", "", datasetScopeLabel())
    );
    header.append(titleBlock, summary);

    const legend = document.createElement("div");
    legend.className = "wcv-enhanced-legend";
    for (const [className, label] of [
      ["wcv-category-specialist", "専門科目"],
      ["wcv-category-foundation", "基礎科目"],
      ["wcv-category-exercise", "実験・演習"],
      ["wcv-category-information", "情報・通信"]
    ]) legend.append(createTextElement("span", className, label));
    if (courses.some((course) => course.ambiguous)) {
      legend.append(createTextElement("span", "wcv-ambiguity-legend", "同名科目は候補表示"));
    }

    const regularCourses = courses.filter((course) => (course.meetings || []).length);
    const irregularCourses = courses.filter((course) => !(course.meetings || []).length);
    const hasSunday = regularCourses.some((course) => (course.meetings || []).some((meeting) => meeting.day === "日"));
    const days = hasSunday ? DAYS : DAYS.slice(0, 6);
    const viewport = document.createElement("div");
    viewport.className = "wcv-enhanced-grid-viewport";
    const grid = document.createElement("div");
    grid.className = "wcv-enhanced-grid";
    grid.style.setProperty("--wcv-day-count", String(days.length));
    grid.append(createTextElement("div", "wcv-grid-corner", ""));
    for (const day of days) grid.append(createTextElement("div", "wcv-grid-day", `${day}曜日`));

    const slotMap = new Map();
    for (const course of regularCourses) {
      for (const meeting of course.meetings || []) {
        if (!days.includes(meeting.day) || !Number.isInteger(Number(meeting.period))) continue;
        const key = `${meeting.day}-${Number(meeting.period)}`;
        if (!slotMap.has(key)) slotMap.set(key, []);
        slotMap.get(key).push({ course, meeting: { ...meeting, period: Number(meeting.period) } });
      }
    }

    for (const periodInfo of standardPeriods()) {
      const period = document.createElement("div");
      period.className = "wcv-grid-period";
      period.append(
        createTextElement("strong", "", `${periodInfo.period}限`),
        createTextElement("span", "", periodInfo.time)
      );
      grid.append(period);
      for (const day of days) {
        const cell = document.createElement("div");
        cell.className = "wcv-grid-cell";
        const entries = slotMap.get(`${day}-${periodInfo.period}`) || [];
        if (!entries.length) cell.classList.add("wcv-grid-empty");
        for (const { course, meeting } of entries.slice(0, 6)) cell.append(createTimetableCourseCard(course, meeting));
        if (entries.length > 6) cell.append(createTextElement("div", "wcv-grid-more", `ほか${entries.length - 6}件`));
        grid.append(cell);
      }
    }
    viewport.append(grid);

    const parts = [header, legend, viewport];
    if (irregularCourses.length) {
      const irregular = document.createElement("section");
      irregular.className = "wcv-irregular-section";
      irregular.append(
        createTextElement("h3", "wcv-irregular-heading", "集中講義・研究・日程別途"),
        createTextElement("p", "wcv-irregular-description", "曜日・時限が固定されていない科目は、通常時間割の下に分けて表示します。")
      );
      const list = document.createElement("div");
      list.className = "wcv-irregular-list";
      for (const course of irregularCourses.slice(0, 24)) list.append(createIrregularCourseItem(course));
      if (irregularCourses.length > 24) list.append(createTextElement("div", "wcv-irregular-more", `ほか${irregularCourses.length - 24}科目`));
      irregular.append(list);
      parts.push(irregular);
    }

    const footer = document.createElement("div");
    footer.className = "wcv-enhanced-footer";
    footer.append(
      createTextElement("span", "", "休講・教室変更などの最新情報は、WebClassのお知らせを優先してください。"),
      createTextElement("span", "wcv-enhanced-source", `2026年度全学データ: ${datasetScopeLabel()}`)
    );
    parts.push(footer);
    section.append(...parts);
    return section;
  }

  function injectEnhancedTimetable() {
    const existing = document.getElementById(UI_IDS.enhancedTimetable);
    const courses = [...state.detectedCourses.values()];
    const shouldShow = state.settings.showEnhancedTimetable && courses.length >= 2 && isLikelyTimetablePage();
    if (!shouldShow) {
      existing?.remove();
      return;
    }
    const signature = courses.map(courseKey).sort().join("|");
    if (existing?.dataset.signature === signature) return;
    existing?.remove();
    withOwnMutation(() => {
      const section = createEnhancedTimetable(courses);
      section.dataset.signature = signature;
      findSafeMainContainer().prepend(section);
    });
  }

  function removeInjectedUi({ keepAnnotations = false, keepNative = false } = {}) {
    document.getElementById(UI_IDS.launcher)?.remove();
    document.getElementById(UI_IDS.panel)?.remove();
    document.getElementById(UI_IDS.courseCard)?.remove();
    document.getElementById(UI_IDS.enhancedTimetable)?.remove();
    if (!keepNative) restoreNativeEnhancements();
    if (!keepAnnotations) {
      document.querySelectorAll(".wcv-inline-meta").forEach((element) => element.remove());
      document.querySelectorAll("[data-wcv-annotated='true']").forEach((element) => {
        element.removeAttribute("data-wcv-annotated");
        element.classList.remove("wcv-course-hit");
      });
      state.annotatedElements = new WeakSet();
    }
  }

  function clearInlineMetadata() {
    document.querySelectorAll(".wcv-inline-meta").forEach((element) => element.remove());
    document.querySelectorAll("[data-wcv-annotated='true']:not(.wcv-native-course-card)").forEach((element) => {
      element.removeAttribute("data-wcv-annotated");
      element.classList.remove("wcv-course-hit");
    });
    state.annotatedElements = new WeakSet();
  }

  // 初回だけ表示する案内。コースリスト画面（時間割がある画面）でのみ出す
  function ensureWelcomeBanner() {
    const existing = document.getElementById("wcv-welcome-banner");
    const show = state.settings.enabled && !state.settings.onboardingSeen && document.querySelector(".wcv-native-schedule-table");
    if (!show) {
      existing?.remove();
      return;
    }
    if (existing) return;
    withOwnMutation(() => {
      const banner = document.createElement("aside");
      banner.id = "wcv-welcome-banner";
      banner.className = "wcv-welcome-banner wcv-root";
      banner.setAttribute("role", "status");

      const text = document.createElement("div");
      text.className = "wcv-welcome-text";
      text.append(
        createTextElement("strong", "", "✓ 授業情報が表示されています"),
        createTextElement("span", "", "時間割の各科目に、教室と担当教員を追加しました。科目カードをクリックすると、これまで通りコースへ移動します。"),
        createTextElement("span", "wcv-welcome-sub", "オン/オフは、ブラウザー右上の拡張機能アイコンからいつでも切り替えられます。")
      );

      const actions = document.createElement("div");
      actions.className = "wcv-welcome-actions";
      const ok = createTextElement("button", "wcv-welcome-ok", "わかった");
      ok.type = "button";
      ok.addEventListener("click", () => {
        banner.remove();
        chrome.storage.local.set({ onboardingSeen: true });
      });
      const off = createTextElement("button", "wcv-welcome-off", "元の画面に戻す");
      off.type = "button";
      off.addEventListener("click", () => {
        banner.remove();
        chrome.storage.local.set({ onboardingSeen: true, enabled: false });
      });
      actions.append(ok, off);
      banner.append(text, actions);
      const host = document.querySelector(".wcv-native-content")
        || document.querySelector("#schedule-table")?.closest("form")
        || document.querySelector("main#js-main")
        || document.body;
      host.prepend(banner);
      ok.focus({ preventScroll: true });
    });
  }

  function runScan() {
    if (!state.settings.enabled) {
      applyRestyle(false);
      removeInjectedUi();
      document.getElementById("wcv-welcome-banner")?.remove();
      return;
    }
    applyRestyle(state.settings.restyle);
    enhanceNativeWebClassLayout();
    if (state.settings.showInlineMetadata) scanCourseElements();
    else {
      clearInlineMetadata();
      state.detectedCourses = new Map(state.nativeDetectedCourses);
    }
    injectEnhancedTimetable();
    state.currentCourse = findCurrentCourse();
    injectCurrentCourseCard(state.currentCourse);
    ensureFloatingPanel();
    ensureWelcomeBanner();
    document.documentElement.dataset.wcvReady = "true";
    document.documentElement.dataset.wcvDetectedCount = String(state.detectedCourses.size);
  }

  function scheduleScan(delay = 180) {
    clearTimeout(state.rescanTimer);
    state.rescanTimer = setTimeout(runScan, delay);
  }

  function startObserver() {
    state.observer?.disconnect();
    state.observer = new MutationObserver((mutations) => {
      if (state.ownMutationDepth > 0) return;
      const relevant = mutations.some((mutation) => {
        if (mutation.type === "characterData") return true;
        return [...mutation.addedNodes].some((node) => node instanceof Element && !node.closest?.(".wcv-root"));
      });
      if (relevant) scheduleScan(220);
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  async function loadDataset() {
    const response = await fetch(chrome.runtime.getURL("data/timetable-2026.json"));
    if (!response.ok) throw new Error(`時間割データの読込に失敗しました: ${response.status}`);
    return response.json();
  }

  async function loadHistoricalCourseData() {
    try {
      const response = await fetch(chrome.runtime.getURL("data/historical-course-row-evidence.json"));
      if (!response.ok) throw new Error(`過年度データの読込に失敗しました: ${response.status}`);
      const payload = await response.json();
      if (payload.schemaVersion !== 2 || !Array.isArray(payload.records)) {
        throw new Error("過年度データの形式が正しくありません。");
      }
      return payload;
    } catch (error) {
      console.warn("[TCU WebClass Visual] 過年度データを読み込めませんでした", error);
      return { summary: {}, database: {}, records: [] };
    }
  }

  async function initialize() {
    try {
      const [dataset, historicalData, stored] = await Promise.all([
        loadDataset(), loadHistoricalCourseData(), storageGet(DEFAULT_SETTINGS)
      ]);
      state.dataset = dataset;
      state.historicalEvidence = historicalData.records;
      state.historicalDataSummary = historicalData.summary;
      state.databaseStatus = historicalData.database;
      state.settings = { ...DEFAULT_SETTINGS, ...stored };
      state.courses = mergeCourses(dataset.courses || [], state.settings.userCourses || []);
      rebuildIndexes();
      runScan();
      startObserver();

      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") return;
        let needsRebuild = false;
        for (const [key, change] of Object.entries(changes)) {
          if (key in DEFAULT_SETTINGS) {
            state.settings[key] = change.newValue;
            if (key === "userCourses") needsRebuild = true;
          }
        }
        if (needsRebuild) {
          state.courses = mergeCourses(state.dataset?.courses || [], state.settings.userCourses || []);
          rebuildIndexes();
          removeInjectedUi();
        }
        scheduleScan(50);
      });

      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type === "wcv-get-status") {
          const scope = state.dataset?.dataset?.scope || {};
          sendResponse({
            ready: true,
            enabled: state.settings.enabled,
            detectedCount: state.detectedCourses.size,
            currentCourse: state.currentCourse?.courseName || null,
            currentAmbiguous: Boolean(state.currentCourse?.ambiguous),
            datasetTitle: state.dataset?.dataset?.title || null,
            datasetCourseCount: scope.uniqueCourses || state.courses.length,
            datasetSourceCount: scope.sourceDocuments?.length || 0,
            datasetPageCount: scope.timetablePages || 0,
            historicalExampleCount: state.historicalDataSummary?.groupedRows || 0,
            historicalSourceOccurrences: state.historicalDataSummary?.sourceOccurrences || 0,
            historicalReviewedOccurrences: state.historicalDataSummary?.visuallyReviewedOccurrences || 0,
            historicalAcademicYears: state.historicalDataSummary?.academicYears || [],
            curriculumStatus: state.databaseStatus?.curriculumStatus || "unavailable",
            currentCatalogStatus: state.databaseStatus?.currentCatalogStatus || "unavailable"
          });
          return true;
        }
        if (message?.type === "wcv-rescan") {
          removeInjectedUi();
          runScan();
          sendResponse({ ok: true, detectedCount: state.detectedCourses.size });
          return true;
        }
        return false;
      });
    } catch (error) {
      console.error("[TCU WebClass Visual] 初期化に失敗しました", error);
      document.documentElement.dataset.wcvError = "true";
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
