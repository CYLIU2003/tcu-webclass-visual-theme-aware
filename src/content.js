(() => {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    onboardingSeen: false,
    enabled: true,
    restyle: true,
    appearance: "standard",
    modernizeNativeLayout: true,
    showInlineMetadata: true,
    showEnhancedTimetable: true,
    showDeadlineList: true,
    showSidebarTools: true,
    showFloatingPanel: true,
    showSourceLabel: true,
    debug: false,
    userCourses: [],
    curriculumPlan: "",
    webclassAdmissionYear: "",
    curriculumTeaching: false,
    curriculumHirameki: false
  });

  const UI_IDS = Object.freeze({
    launcher: "wcv-launcher",
    panel: "wcv-panel",
    courseCard: "wcv-course-info-card",
    enhancedTimetable: "wcv-enhanced-timetable",
    sidebarTools: "wcv-sidebar-tools",
    nativeCourseCount: "wcv-native-course-count"
  });

  const COURSE_CODE_RE = /(?:^|[^a-z0-9])\d{0,2}([a-z]{3,4}\d{4,6})(?![a-z0-9])/gi;
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
    currentFallEvidence: [],
    currentFallSummary: null,
    correctionEvents: [],
    correctionSummary: null,
    studyGuideNavigation: null,
    databaseStatus: null,
    curriculumCandidates: null,
    courses: [],
    officialCourseCodes: new Set(),
    codeIndex: new Map(),
    numericCodeIndex: new Map(),
    aliasIndex: new Map(),
    exactTitleIndex: new Map(),
    searchAliases: [],
    buildProvisionalFallCourse: null,
    correctionByCode: new Map(),
    fallCandidateByCode: new Map(),
    fallCandidateByTitle: new Map(),
    annotatedElements: new WeakSet(),
    detectedCourses: new Map(),
    currentCourse: null,
    panelSearchQuery: "",
    panelQuickMode: "detected",
    panelOpener: null,
    panelLayerFilter: "all",
    panelSearchLimit: 12,
    panelCorrectionLimit: 35,
    panelGuideFilter: "",
    todaySelectedDay: "",
    todayStripCollapsed: false,
    courseListFilter: "all",
    searchBlobCache: new WeakMap(),
    observer: null,
    rescanTimer: null,
    ownMutationDepth: 0,
    nativeOriginals: new Map(),
    nativeAddedClasses: new Map(),
    nativeDetectedCourses: new Map(),
    nativeScheduleEntries: [],
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
      // Keep the original nodes so their WebClass event listeners survive restoration.
      children: Array.from(element.childNodes),
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
      element.replaceChildren(...original.children);
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
    state.nativeScheduleEntries = [];
    document.querySelectorAll(".wcv-native-list-hidden").forEach((element) => element.classList.remove("wcv-native-list-hidden"));
    document.querySelectorAll(".wcv-jump-highlight").forEach((element) => element.classList.remove("wcv-jump-highlight"));
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
    state.numericCodeIndex = new Map();
    state.aliasIndex = new Map();
    state.exactTitleIndex = new Map();
    state.correctionByCode = new Map();
    state.fallCandidateByCode = new Map();
    state.fallCandidateByTitle = new Map();
    state.searchBlobCache = new WeakMap();
    state.buildProvisionalFallCourse = buildProvisionalFallCourse;

    for (const event of state.correctionEvents || []) {
      const code = normalizeCode(event?.courseCode);
      if (!code) continue;
      if (!state.correctionByCode.has(code)) state.correctionByCode.set(code, []);
      state.correctionByCode.get(code).push(event);
    }

    for (const record of state.currentFallEvidence || []) {
      const code = normalizeCode(record?.courseCode);
      if (code) {
        if (!state.fallCandidateByCode.has(code)) state.fallCandidateByCode.set(code, []);
        state.fallCandidateByCode.get(code).push(record);
      }
      const titleKey = normalizeExactCourseTitle(record?.courseName);
      if (titleKey) {
        if (!state.fallCandidateByTitle.has(titleKey)) state.fallCandidateByTitle.set(titleKey, []);
        state.fallCandidateByTitle.get(titleKey).push(record);
      }
    }

    for (const course of state.courses) {
      const code = normalizeCode(course.courseCode);
      // ベースカタログで教室や担当が未記載の場合、2026後期PDFや過年度DBの同一講義コード行から補完する
      if (code && state.fallCandidateByCode.has(code)) {
        const fallRows = state.fallCandidateByCode.get(code) || [];
        const reviewedFall = fallRows.find((r) => r.reviewStatus === "visually-reviewed-provisional") || fallRows[0];
        if ((!course.instructors || !course.instructors.length) && reviewedFall) {
          const fallbackTeachers = reviewedFall.instructors?.length
            ? reviewedFall.instructors
            : uniqueBy(fallRows.map((r) => r.instructorText).filter(Boolean));
          if (fallbackTeachers.length) course.instructors = fallbackTeachers;
        }
        const fallbackRooms = uniqueBy(fallRows.map((r) => r.room).filter((r) => r && r !== "-"));
        if (fallbackRooms.length) {
          for (const meeting of course.meetings || []) {
            if (!meeting.room || meeting.room === "-") {
              meeting.room = fallbackRooms[0];
              meeting.rooms = fallbackRooms;
            }
          }
        }
      }
      if (code) {
        state.codeIndex.set(code, course);
        const numericCode = code.match(/\d{4,6}$/)?.[0];
        if (numericCode) {
          if (!state.numericCodeIndex.has(numericCode)) state.numericCodeIndex.set(numericCode, []);
          state.numericCodeIndex.get(numericCode).push(course);
        }
      }
      const exactKey = normalizeExactCourseTitle(course.courseName);
      if (exactKey) {
        if (!state.exactTitleIndex.has(exactKey)) state.exactTitleIndex.set(exactKey, []);
        const exactBucket = state.exactTitleIndex.get(exactKey);
        if (!exactBucket.includes(course)) exactBucket.push(course);
      }
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

  function resolveCourseTitleByCode(rawCode, fallbackName = "") {
    if (fallbackName) return fallbackName;
    const code = normalizeCode(rawCode);
    if (!code) return "";
    const fromBase = state.codeIndex.get(code)?.courseName;
    if (fromBase) return fromBase;
    const fromFall = state.fallCandidateByCode.get(code)?.find((r) => r.courseName)?.courseName;
    if (fromFall) return fromFall;
    return "";
  }

  function getCorrectionEventsForCourse(course) {
    if (!course) return [];
    const codes = uniqueBy([course.courseCode, ...(course.courseCodes || [])].map(normalizeCode).filter(Boolean));
    const events = [];
    for (const code of codes) {
      const bucket = state.correctionByCode.get(code) || [];
      events.push(...bucket);
    }
    return uniqueBy(events, (event) => event.eventId || `${event.source?.id || ""}-${event.sourcePage}-${event.courseCode}-${event.sourceExcerpt || ""}`);
  }

  function findCurrentFallReferences(course) {
    if (!course) return [];
    const codes = new Set(uniqueBy([course.courseCode, ...(course.courseCodes || [])].map(normalizeCode).filter(Boolean)));
    const names = new Set(uniqueBy([course.courseName, ...(course.aliases || [])].map(normalizeExactCourseTitle).filter(Boolean)));
    const matched = [];
    const seen = new Set();
    const pushRecord = (record, matchKind) => {
      const key = `${record.source?.id || ""}-${record.courseCode}-${record.courseName || ""}-${record.room || ""}-${record.instructorText || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      matched.push({ ...record, matchKind });
    };
    for (const code of codes) {
      for (const record of state.fallCandidateByCode.get(code) || []) {
        pushRecord(record, "same-code");
      }
    }
    for (const name of names) {
      for (const record of state.fallCandidateByTitle.get(name) || []) {
        const sameCode = codes.has(normalizeCode(record.courseCode));
        pushRecord(record, sameCode ? "same-code" : "same-title");
      }
    }
    return matched.sort((a, b) => (a.matchKind === b.matchKind ? 0 : a.matchKind === "same-code" ? -1 : 1)
      || Number(b.reviewStatus === "visually-reviewed-provisional") - Number(a.reviewStatus === "visually-reviewed-provisional")
      || String(a.courseCode).localeCompare(String(b.courseCode), "ja")
      || (a.sourceLocations?.[0]?.page || 0) - (b.sourceLocations?.[0]?.page || 0));
  }

  function buildProvisionalFallCourse(rawCode) {
    const code = normalizeCode(rawCode);
    if (!code || state.codeIndex.has(code)) return null;
    const fallRows = state.fallCandidateByCode.get(code) || [];
    const corrections = state.correctionByCode.get(code) || [];
    if (!fallRows.length && !corrections.length) return null;
    const reviewed = fallRows.find((row) => row.reviewStatus === "visually-reviewed-provisional");
    const primary = reviewed || fallRows[0] || null;
    const courseName = primary?.courseName || corrections.find((item) => item.courseName)?.courseName || `講義コード ${code}`;
    const instructors = reviewed?.instructors?.length
      ? reviewed.instructors
      : uniqueBy(fallRows.map((row) => row.instructorText).filter(Boolean));
    const meetings = [];
    for (const row of fallRows) {
      const room = row.room && row.room !== "-" ? row.room : "";
      const campus = row.source?.campus || "";
      for (const sched of row.scheduleCandidates || []) {
        if (sched.dayCandidate && sched.periodCandidate) {
          meetings.push({
            day: sched.dayCandidate,
            period: Number(sched.periodCandidate),
            termBlock: sched.termCandidate || "後期",
            room,
            rooms: room ? [room] : [],
            campus
          });
        }
      }
    }
    const campuses = uniqueBy([
      ...fallRows.map((row) => row.source?.campus).filter(Boolean),
      ...corrections.map((item) => item.source?.campus).filter(Boolean)
    ]);
    const pages = uniqueBy(fallRows.flatMap((row) => (row.sourceLocations || []).map((loc) => loc.page)).filter(Boolean));
    return {
      courseCode: code,
      courseCodes: [code],
      courseName,
      aliases: uniqueBy(fallRows.map((row) => row.courseName).filter(Boolean)),
      academicYear: 2026,
      semester: "後期",
      termBlock: "後期（PDF候補）",
      instructors,
      meetings: uniqueBy(meetings, (m) => `${m.day}-${m.period}-${m.termBlock}-${m.room}`),
      provisionalRooms: uniqueBy(fallRows.map((row) => row.room).filter((room) => room && room !== "-")),
      departments: [],
      campuses,
      scheduleTypes: [],
      notes: ["2026年度後期公式PDFまたは訂正表から抽出した未確定の候補行です。現在の時間割データには未収録のため、出典PDFの該当ページで内容を確認してください。"],
      source: {
        document: primary?.source?.title || corrections[0]?.source?.title || "2026年度 後期時間割PDF候補",
        pages
      },
      isProvisionalFallCandidate: true,
      provisionalReviewStatus: reviewed ? "visually-reviewed-provisional" : "unreviewed"
    };
  }

  function extractCourseCodes(rawText) {
    return uniqueBy(
      [...String(rawText || "").normalize("NFKC").matchAll(COURSE_CODE_RE)]
        .map((match) => normalizeCode(match[1]))
    );
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
    if (filtered.length <= 1) return filtered;

    const exactNorm = (val) => String(val || "").normalize("NFKC")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[\s　\-‐‑‒–—―_・･:：,，.。/／\\\[\]【】「」『』]/g, "")
      .toLocaleLowerCase("ja-JP")
      .trim();
    let primaryRaw = String(rawText || "").normalize("NFKC")
      .replace(/^[\s»«›‹░▒▓■□▪▫●○◆◇▶▷▸▹•·・:：\-‐‑–—―]+/g, "")
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/\/webclass\/\S+/gi, " ")
      .replace(/(?:^|[^a-z0-9])\d{0,2}[a-z]{3,4}\d{4,6}(?![a-z0-9])/gi, " ")
      .trim();
    primaryRaw = primaryRaw.replace(/\((?=[^)]*(?:20\d{2}|前期|後期|通年|[月火水木金土日]\s*[1-9]|曜|時限|限|クラス|組|セメ|学期|クォータ|Q|，|、))[^)]*\)\s*$/g, "").trim();
    const primaryTitle = exactNorm(primaryRaw);
    if (primaryTitle) {
      const exactTitleMatched = filtered.filter((course) => exactNorm(course.courseName) === primaryTitle);
      if (exactTitleMatched.length) filtered = exactTitleMatched;
    }

    const campusHints = ["世田谷", "横浜", "渋谷"].filter((campus) => String(rawText || "").includes(campus));
    if (campusHints.length && filtered.length > 1) {
      const narrowed = filtered.filter((course) => campusHints.some((hint) =>
        [...(course.campuses || []), ...(course.meetings || []).map((meeting) => meeting.campus || "")].some((campus) => String(campus).includes(hint))
      ));
      if (narrowed.length) filtered = narrowed;
    }

    const termHints = extractTermHints(rawText);
    if (termHints.length && filtered.length > 1) {
      const narrowed = filtered.filter((course) => termHints.some((hint) => {
        if (hint === "前期" || hint === "後期" || hint === "通年") {
          return (course.semesters || [course.semester]).includes(hint);
        }
        return (course.termBlocks || [course.termBlock]).includes(hint);
      }));
      if (narrowed.length) filtered = narrowed;
    }

    const meetingHints = extractMeetingHints(rawText);
    if (meetingHints.length && filtered.length > 1) {
      const narrowed = filtered.filter((course) => meetingHints.some((hint) =>
        (course.meetings || []).some((meeting) => meeting.day === hint.day && Number(meeting.period) === hint.period)
      ));
      if (narrowed.length) filtered = narrowed;
    }

    if (filtered.length > 1) {
      const normalizedRaw = normalizeCourseName(rawText);
      const exactRaw = exactNorm(rawText);
      const scored = filtered.map((course) => {
        let score = 0;
        const exactCourseTitle = exactNorm(course.courseName);
        if (primaryTitle && exactCourseTitle === primaryTitle) score += 20;
        else if (normalizeCourseName(course.courseName) === normalizedRaw) score += 12;

        const extraRaw = exactCourseTitle ? exactRaw.split(exactCourseTitle).join(" ") : exactRaw;
        for (const instructor of course.instructors || []) {
          const cleaned = String(instructor || "").normalize("NFKC").replace(/\(.*?\)|（.*?）/g, " ").trim();
          const fullToken = exactNorm(cleaned);
          if (fullToken.length >= 2 && extraRaw.includes(fullToken)) {
            score += 16;
            continue;
          }
          const parts = cleaned.split(/[\s　・･/／,、]+/).map(exactNorm).filter((p) => p.length >= 2);
          if (parts.some((token) => extraRaw.includes(token))) {
            score += 10;
          }
        }
        for (const meeting of course.meetings || []) {
          const rooms = [...(meeting?.rooms || []), meeting?.room].filter(Boolean);
          for (const room of rooms) {
            const roomToken = exactNorm(room);
            if (roomToken.length >= 2 && extraRaw.includes(roomToken)) score += 10;
          }
        }
        for (const classLabel of course.classes || []) {
          const token = normalizeCourseName(classLabel);
          if (token.length >= 2 && extraRaw.includes(token)) score += 4;
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

  function findSiblingOfferings(course) {
    if (!course) return [];
    if (Array.isArray(course.offerings) && course.offerings.length > 1) return course.offerings;
    const exactKey = normalizeExactCourseTitle(course.courseName);
    if (!exactKey) return [];
    const base = state.exactTitleIndex.get(exactKey) || [];
    const seenCodes = new Set(base.map((item) => normalizeCode(item.courseCode)).filter(Boolean));
    const fallExtras = (state.fallCandidateByTitle.get(exactKey) || [])
      .filter((record) => {
        const code = normalizeCode(record.courseCode);
        return code && !seenCodes.has(code) && !state.codeIndex.has(code);
      })
      .map((record) => buildProvisionalFallCourse(record.courseCode))
      .filter(Boolean);
    return uniqueBy([...base, ...fallExtras], (item) => item.courseCode || `${item.courseName}:${item.source?.document || ""}`);
  }

  function offeringSlotSummary(offering, day = "", period = null) {
    const meetings = Array.isArray(offering?.meetings) ? offering.meetings : [];
    const relevant = (day && Number.isInteger(Number(period)))
      ? meetings.filter((m) => m.day === day && Number(m.period) === Number(period))
      : [];
    const targetMeetings = relevant.length ? relevant : meetings;
    const slots = uniqueBy(targetMeetings.map((m) => `${m.termBlock || ""}${m.day || ""}${m.period || ""}`).filter(Boolean));
    const rooms = uniqueBy([
      ...targetMeetings.flatMap(meetingRooms).map((r) => humanizeRoom(r)),
      ...(offering?.provisionalRooms || []).map((r) => humanizeRoom(r))
    ].filter((r) => r && r !== "教室未定"));
    const teachers = uniqueBy(offering?.instructors || []);
    return {
      code: offering?.courseCode || "",
      slotLabel: slots.join("・") || offering?.termBlock || offering?.semester || "日程別途",
      roomLabel: rooms.join(" / ") || "教室未定",
      teacherLabel: teachers.length ? shortInstructors(teachers, 2) : "担当未定"
    };
  }

  function formatOfferingPairs(offerings, { day = "", period = null, maxVisible = 3, termHints = [] } = {}) {
    const list = Array.isArray(offerings) ? offerings : [];
    if (!list.length) return { roomSummary: "教室未定", teacherSummary: "未登録", pairSummary: "" };
    let scoped = list;
    if (day && Number.isInteger(Number(period))) {
      const slotMatched = list.filter((item) =>
        (item.meetings || []).some((m) => m.day === day && Number(m.period) === Number(period))
      );
      if (slotMatched.length) {
        scoped = slotMatched;
        if (termHints.length) {
          const termMatched = slotMatched.filter((item) =>
            (item.meetings || []).some((m) =>
              m.day === day && Number(m.period) === Number(period) && meetingMatchesTermHints(m, termHints)
            )
          );
          if (termMatched.length) scoped = termMatched;
        }
      }
    }
    const summaries = scoped.map((item) => offeringSlotSummary(item, day, period));
    const pairItems = uniqueBy(summaries.map((s) => {
      const slotPrefix = (!day && s.slotLabel && s.slotLabel !== "日程別途") ? `${s.slotLabel}: ` : "";
      return `${slotPrefix}${s.roomLabel}（${s.teacherLabel}）`;
    }));
    const roomItems = uniqueBy(summaries.map((s) => {
      const teacherTag = s.teacherLabel && s.teacherLabel !== "担当未定" ? `（${s.teacherLabel}）` : "";
      return `${s.roomLabel}${teacherTag}`;
    }));
    const teacherItems = uniqueBy(summaries.map((s) => {
      const roomTag = s.roomLabel && s.roomLabel !== "教室未定" ? `（${s.roomLabel}）` : "";
      return `${s.teacherLabel}${roomTag}`;
    }));
    const trimList = (arr) => arr.length <= maxVisible
      ? arr.join(" / ")
      : `${arr.slice(0, maxVisible).join(" / ")} ほか${arr.length - maxVisible}開講`;
    return {
      roomSummary: trimList(roomItems),
      teacherSummary: trimList(teacherItems),
      pairSummary: trimList(pairItems)
    };
  }

  function aggregateCandidates(candidates, rawText, aliasKey) {
    const filtered = filterCandidates(candidates, rawText);
    if (!filtered.length) return null;
    if (filtered.length === 1) return filtered[0];

    const material = filtered.slice(0, 30);
    const first = material[0];
    const allMeetings = uniqueBy(
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
    const instructors = uniqueBy(material.flatMap((course) => course.instructors || []));

    return {
      ...cloneCourse(first),
      courseName: names[0] || first.courseName,
      aliases: uniqueBy(material.flatMap((course) => [course.courseName, ...(course.aliases || [])])),
      courseCode: "",
      courseCodes,
      instructors,
      instructorAmbiguous: instructors.length > 1,
      meetings: [],
      allMeetings,
      offerings: filtered,
      departments,
      campuses: uniqueBy(material.flatMap((course) => course.campuses || [])),
      scheduleTypes: uniqueBy(material.flatMap((course) => course.scheduleTypes || [])),
      notes: uniqueBy(material.flatMap((course) => course.notes || [])),
      sources: uniqueBy(material.flatMap((course) => course.sources || []), (source) => `${source.id || ""}-${source.document || ""}-${source.page || ""}`),
      source: { document: "複数の時間割表", pages: [] },
      ambiguous: true,
      broadAmbiguous: filtered.length > 6,
      candidateCount: filtered.length,
      _matchKey: `ambiguous:${aliasKey}:${courseCodes.join(",")}`
    };
  }

  function findCourse(rawText, contextText = "") {
    const sourceText = String(rawText || "");
    const contextStr = typeof contextText === "object" && contextText !== null
      ? [
          contextText.semesterText || "",
          contextText.day && Number.isInteger(Number(contextText.period)) ? `${contextText.day}${contextText.period}` : ""
        ].filter(Boolean).join(" ")
      : String(contextText || "");
    const matchingText = `${sourceText} ${contextStr}`.trim();
    const codes = extractCourseCodes(sourceText);
    for (const code of codes) {
      const direct = state.codeIndex.get(code);
      if (direct) return direct;
      const provisional = state.buildProvisionalFallCourse?.(code);
      if (provisional) return provisional;
    }
    const normalizedSource = normalizeCourseName(sourceText);
    for (const code of codes) {
      const numericCode = code.match(/\d{4,6}$/)?.[0];
      const matches = numericCode ? state.numericCodeIndex?.get(numericCode) : null;
      if (matches?.length === 1) {
        const candidate = matches[0];
        const candidateTitle = normalizeCourseName(candidate.courseName);
        if (candidateTitle && normalizedSource.includes(candidateTitle)) return candidate;
      }
    }
    if (codes.length) return null;

    if (!normalizedSource || normalizedSource.length < 3) return null;

    const exact = state.aliasIndex.get(normalizedSource);
    if (exact?.length) return aggregateCandidates(exact, matchingText, normalizedSource);

    let bestLength = 0;
    let bestAliases = [];
    for (const [alias, candidates] of state.searchAliases) {
      if (bestLength && alias.length < bestLength) break;
      if (!normalizedSource.includes(alias)) continue;
      if (!bestLength) bestLength = alias.length;
      if (alias.length === bestLength) bestAliases.push([alias, candidates]);
    }
    if (!bestAliases.length) return null;

    const candidates = uniqueBy(bestAliases.flatMap(([, bucket]) => bucket), (course) => course.courseCode || course.courseName);
    return aggregateCandidates(candidates, matchingText, bestAliases.map(([alias]) => alias).join("+"));
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

  function instructorLabel(course, maxVisible = 2) {
    if (course?.instructorAmbiguous) return "時限・講義コードでクラス特定が必要";
    return shortInstructors(course?.instructors, maxVisible);
  }

  function meetingRooms(meeting) {
    const rooms = uniqueBy((meeting?.rooms || []).filter(Boolean));
    const combined = String(meeting?.room || "").trim();
    // The catalog also stores the joined display string in `room`.
    // Do not repeat it when the individual rooms are already present.
    if (combined && combined !== rooms.join(" / ")) rooms.push(combined);
    return uniqueBy(rooms);
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
    if (course?.broadAmbiguous) return `時限・講義コードでクラス特定が必要（候補${course.candidateCount}クラス）`;
    const meetings = Array.isArray(course?.meetings) && course.meetings.length
      ? course.meetings
      : (Array.isArray(course?.allMeetings) ? course.allMeetings : []);
    if (!meetings.length) {
      if (course?.ambiguous) return `時限・講義コードでクラス特定が必要（候補${course.candidateCount}クラス）`;
      return course?.isProvisionalFallCandidate ? "PDFの時間割欄を確認" : irregularScheduleLabel(course);
    }
    const includeTerm = uniqueBy(meetings.map((meeting) => meeting.termBlock).filter(Boolean)).length > 1;
    const shown = meetings.slice(0, 6);
    const suffix = meetings.length > 6 ? ` ほか${meetings.length - 6}枠` : "";
    const label = `${shown.map((meeting) => meetingLabel(meeting, includeRoom, includeTerm)).join(" / ")}${suffix}`;
    return course?.ambiguous ? `複数開講 ${course.candidateCount}クラス: ${label}` : label;
  }

  function roomsLabel(course, { day = "", period = null, maxVisible = 3, termHints = [] } = {}) {
    if (Array.isArray(course?.offerings) && course.offerings.length > 1) {
      const paired = formatOfferingPairs(course.offerings, { day, period, maxVisible, termHints });
      if (paired.roomSummary && paired.roomSummary !== "教室未定") return paired.roomSummary;
    }
    if (course?.isProvisionalFallCandidate) {
      const rooms = uniqueBy((course.provisionalRooms || []).map((room) => humanizeRoom(room)));
      return rooms.length ? rooms.join(" / ") : "PDFの教室欄を確認";
    }
    const rooms = uniqueBy([
      ...(course?.meetings || []).flatMap(meetingRooms).map((room) => humanizeRoom(room)),
      ...(course?.provisionalRooms || []).map((room) => humanizeRoom(room))
    ].filter((r) => r && r !== "教室未定"));
    if (!rooms.length) return (course?.meetings || []).length ? "教室未定" : "教室未定／時間外";
    const label = rooms.length <= maxVisible ? rooms.join(" / ") : `${rooms.slice(0, maxVisible).join(" / ")} ほか${rooms.length - maxVisible}室`;
    return course?.ambiguous ? `${label}（クラス別）` : label;
  }

  function instructorsLabel(course, { day = "", period = null, maxVisible = 3, termHints = [] } = {}) {
    if (Array.isArray(course?.offerings) && course.offerings.length > 1) {
      const paired = formatOfferingPairs(course.offerings, { day, period, maxVisible, termHints });
      if (paired.teacherSummary && paired.teacherSummary !== "未登録") return paired.teacherSummary;
    }
    return shortInstructors(course?.instructors, maxVisible);
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
    if (course?.isProvisionalFallCandidate) {
      return course.provisionalReviewStatus === "visually-reviewed-provisional"
        ? "2026後期PDF・目視確認済候補"
        : "2026後期PDF・抽出候補（未確認）";
    }
    if (course?.ambiguous) return `調査用候補 ${course.candidateCount}件`;
    const pages = course?.source?.pages;
    if (Array.isArray(pages) && pages.length) return `調査用・時間割表 p.${pages.join("・")}`;
    return "2026年度・調査用データ";
  }

  function datasetScopeLabel() {
    const scope = state.dataset?.dataset?.scope;
    if (!scope) return "2026年度全学時間割";
    const fallCount = state.currentFallSummary?.groupedRows || 0;
    const histCount = state.historicalDataSummary?.groupedRows || 0;
    if (fallCount || histCount) {
      return `調査用 ${scope.uniqueCourses || 0}科目＋後期PDF候補${fallCount}件・過年度${histCount}件`;
    }
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
    applyAppearance();
  }

  function applyAppearance() {
    const modern = state.settings.enabled && state.settings.restyle && state.settings.appearance === "modern";
    document.documentElement.classList.toggle("wcv-look-modern",
      modern && (isCourseContentPage() || isCourseListPage() || Boolean(document.querySelector(".cm-contentsList"))));
    syncSidebarAppearance(document.getElementById("wcv-sidebar-appearance"));
  }

  function syncSidebarAppearance(select) {
    if (!select) return;
    select.disabled = !state.settings.restyle;
    select.value = state.settings.appearance === "modern" ? "modern" : "standard";
  }

  function nativeTimetable() {
    return document.querySelector("table#schedule-table, table.schedule-table");
  }

  function isCourseListPage() {
    return Boolean(nativeTimetable()) || Array.from(document.querySelectorAll("h1, h2, h3, h4"))
      .some((heading) => !heading.closest(".wcv-root") && elementText(heading) === "参加しているコース");
  }

  function isCourseContentPage() {
    return /\/webclass\/course\.php(?:\/|$)/i.test(location.pathname);
  }

  function hasNativeScheduleGrid() {
    return Boolean(document.querySelector("#schedule-table thead th"));
  }

  function getCandidateElements() {
    if (isCourseContentPage()) return [];
    const schedule = nativeTimetable();
    if (schedule && !hasNativeScheduleGrid()) {
      return Array.from(schedule.querySelectorAll("a[href*='course.php'], [data-course-name], [data-course-code]"));
    }
    if (isCourseListPage() && !hasNativeScheduleGrid()) return [];
    const selectors = [
      "a", ".course", ".course-name", ".course_name", ".course-title", ".course_title",
      "[data-course-name]", "[data-course-code]", "td", "th", "h1", "h2", "h3"
    ];
    return Array.from(document.querySelectorAll(selectors.join(","))).slice(0, 3500);
  }

  function elementText(element) {
    if (!(element instanceof Element)) return "";
    const clone = element.cloneNode(true);
    clone.querySelectorAll(".wcv-root").forEach((node) => node.remove());
    const text = element.getAttribute("data-course-name") || clone.textContent || "";
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

  function elementContextText(element) {
    if (!(element instanceof Element) || !element.matches("a")) return "";
    const context = element.closest("td, tr, li");
    if (!context) return "";
    if (typeof context.querySelectorAll === "function" && context.querySelectorAll("a[href*='course.php']").length > 1) return "";
    const text = elementText(context);
    return text.length <= 260 ? text : "";
  }

  function meetingMatchesTermHints(meeting, termHints) {
    if (!meeting || !Array.isArray(termHints) || !termHints.length) return false;
    const tb = String(meeting.termBlock || "").replace(/半$/, "");
    return termHints.some((hint) => {
      const h = String(hint || "").replace(/半$/, "");
      if (h === "前期" || h === "後期") return tb.startsWith(h);
      return tb === h;
    });
  }

  function courseForContext(course, text) {
    const termHints = extractTermHints(text);
    if (!termHints.length || !Array.isArray(course?.meetings) || course.meetings.length <= 1) return course;
    const meetings = course.meetings.filter((meeting) => meetingMatchesTermHints(meeting, termHints));
    return meetings.length && meetings.length < course.meetings.length ? { ...course, meetings } : course;
  }

  function unmatchedCourse(element, fingerprint) {
    if (!(element instanceof Element) || !element.matches("a[href*='course.php']")) return null;
    const rawId = element.getAttribute("href")?.match(/\/course\.php\/([^/?#]+)/i)?.[1] || "";
    const text = elementText(element).replace(/^\s*»\s*/, "");
    const courseName = text.replace(/\s*[（(][^）)]*20\d{2}\s*年度[^）)]*[）)]\s*$/g, "").trim() || text || rawId;
    if (!courseName) return null;
    const context = `${fingerprint} ${elementContextText(element)}`;
    return {
      courseCode: "",
      courseName,
      category: "時間割データ未収録",
      instructors: [],
      meetings: extractMeetingHints(context).map((meeting) => ({ ...meeting, room: "", rooms: [] })),
      campuses: ["世田谷", "横浜", "渋谷"].filter((campus) => context.includes(campus)),
      scheduleTypes: ["unlisted"],
      webclassUrl: webclassCourseUrl(element),
      unlisted: true,
      _matchKey: `unmatched:${normalizeCode(rawId || courseName)}`
    };
  }

  function shouldConsiderElement(element, text) {
    if (!(element instanceof HTMLElement)) return false;
    if (!text || text.length < 3 || text.length > 260) return false;
    if (element.closest(".wcv-root, .wcv-inline-meta, #wcv-course-info-card, .wcv-native-course-card")) return false;
    if (element.closest("#other-courses, #notice, #UserTopInfo")) return false;
    if (NAVIGATION_WORDS.has(elementText(element))) return false;
    if (element.matches("script, style, textarea, input, select, option, button")) return false;
    if (element.tagName !== "A" && element.querySelector("a, [data-course-name], [data-course-code]")) return false;
    if (element.querySelector(".wcv-inline-meta, [data-wcv-annotated='true']")) return false;
    return true;
  }

  function selectedSemesterText() {
    return document.querySelector("select[name='semester'] option:checked")?.textContent?.trim() || "";
  }

  function createInlineMetadata(course) {
    const wrapper = document.createElement("span");
    wrapper.className = "wcv-inline-meta wcv-root";
    wrapper.setAttribute("role", "note");
    const roomText = roomsLabel(course, { maxVisible: 2 });
    const teacherText = instructorsLabel(course, { maxVisible: 2 });
    const siblings = findSiblingOfferings(course);
    wrapper.setAttribute(
      "aria-label",
      `担当教員 ${teacherText}、教室 ${roomText}、開講 ${meetingsLabel(course)}`
    );

    if (course.ambiguous || siblings.length > 1) {
      const count = course.ambiguous ? course.candidateCount : siblings.length;
      wrapper.append(createTextElement(
        "span",
        "wcv-inline-chip wcv-inline-candidate",
        course.ambiguous ? `複数開講 ${count}クラス` : `${ course.courseCode ? `${course.courseCode}・` : "" }全${count}開講`
      ));
    }
    const corrections = getCorrectionEventsForCourse(course);
    if (corrections.length) {
      wrapper.append(createTextElement(
        "span",
        "wcv-inline-chip wcv-inline-correction",
        `訂正表候補 ${corrections.length}件`
      ));
    }
    wrapper.append(
      createTextElement("span", "wcv-inline-chip wcv-inline-room", `教室 ${roomText}`),
      createTextElement(
        "span",
        "wcv-inline-chip wcv-inline-teacher",
        `担当 ${teacherText}`
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
    const semesterText = selectedSemesterText();
    const hasNativeSchedule = Boolean(document.querySelector("#schedule-table, .schedule-list"));
    for (const element of getCandidateElements()) {
      const fingerprint = elementFingerprint(element);
      if (!shouldConsiderElement(element, fingerprint)) continue;
      const context = elementContextText(element);
      const matched = findCourse(fingerprint, [context, semesterText].filter(Boolean).join(" "));
      const course = matched
        ? { ...courseForContext(matched, `${fingerprint} ${context}`), webclassUrl: webclassCourseUrl(element) }
        : (!hasNativeScheduleGrid() ? unmatchedCourse(element, fingerprint) : null);
      if (!course) continue;
      if (!hasNativeSchedule || element.closest("#schedule-table, .schedule-list")) {
        detected.set(courseKey(course), course);
      }
      if (!course.unlisted && state.settings.showInlineMetadata) {
        injectInlineMetadata(element, course);
      }
    }
    state.detectedCourses = detected;
  }

  function findCurrentCourse() {
    if (isCourseContentPage()) return null;
    if (isCourseListPage()) {
      for (const selector of ["[data-course-name]", "[data-course-code]"]) {
        const marker = document.querySelector(selector);
        if (marker && !marker.closest(".wcv-root, #schedule-table, .schedule-table, .schedule-list, #CourseTree, .course-tree")) {
          const fp = [
            marker.getAttribute("data-course-code"),
            marker.getAttribute("data-course-name"),
            elementText(marker)
          ].filter(Boolean).join(" ").trim();
          for (const code of extractCourseCodes(fp)) {
            const byCode = state.codeIndex.get(code) || buildProvisionalFallCourse(code);
            if (byCode) return byCode;
          }
          const matched = findCourse(fp, { semesterText: selectedSemesterText() });
          if (matched) return matched;
        }
      }
      return null;
    }
    const selectors = [
      "[data-course-name]", "[data-course-code]", "#course_name", "#courseName",
      ".course-name", ".course_name", ".course-title", ".course_title",
      "main h1", "main h2", "#main h1", "#main h2",
      ".breadcrumb li:last-child", ".bread_crumb li:last-child", "h1", "h2"
    ];
    const direct = findCourse(`${location.href} ${document.title}`);
    if (direct) return direct;
    const candidates = [];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && !element.closest(".wcv-root")) candidates.push(elementFingerprint(element));
    }
    candidates.push(document.title || "", location.href || "");
    const semesterText = selectedSemesterText();
    for (const candidate of candidates) {
      for (const code of extractCourseCodes(candidate)) {
        const byCode = state.codeIndex.get(code) || buildProvisionalFallCourse(code);
        if (byCode) return byCode;
      }
      const course = findCourse(candidate, { semesterText });
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
      const url = new URL(record?.source?.url || record?.url || "");
      if (url.protocol !== "https:" || !["asc.tcu.ac.jp", "www.asc.tcu.ac.jp"].includes(url.hostname)) return "";
      const pageNumber = Number(page);
      if (!Number.isInteger(pageNumber) || pageNumber < 1) return "";
      url.hash = `page=${pageNumber}`;
      return url.href;
    } catch (_error) {
      return "";
    }
  }

  function createCorrectionEvidenceSection(course) {
    const events = getCorrectionEventsForCourse(course);
    if (!events.length) return null;

    const section = document.createElement("section");
    section.className = "wcv-correction-evidence";
    section.setAttribute("aria-label", "2026年度時間割訂正表の関連候補");
    section.append(
      createTextElement("h3", "wcv-correction-heading", `2026年度 公式時間割訂正表の関連候補（${events.length}件・未適用）`),
      createTextElement(
        "p",
        "wcv-correction-caveat",
        "教学課公開の2026年度時間割訂正表PDFから抽出した候補イベントです。基本スナップショットには自動適用していないため、必ず訂正表PDF原文とWebClassのお知らせで確定内容を確認してください。"
      )
    );

    const list = document.createElement("ul");
    list.className = "wcv-correction-list";
    for (const event of events) {
      const item = document.createElement("li");
      item.className = "wcv-correction-record";
      const head = document.createElement("div");
      head.className = "wcv-correction-record-head";
      head.append(
        createTextElement("strong", "wcv-correction-date", event.changeDate ? `${event.changeDate} 訂正` : "訂正日未記載"),
        createTextElement("span", "wcv-correction-term", `2026年度・${event.source?.scope || "対象未特定"}`),
        createTextElement("span", "wcv-correction-status", "未適用・要PDF確認")
      );
      item.append(head);

      const badges = document.createElement("div");
      badges.className = "wcv-correction-badges";
      const categories = Array.isArray(event.categories) ? event.categories : [];
      if (categories.includes("withdrawal")) badges.append(createTextElement("span", "wcv-correction-chip is-danger", "非開講・開講中止候補"));
      if (categories.includes("room")) badges.append(createTextElement("span", "wcv-correction-chip", "教室変更候補"));
      if (categories.includes("instructor")) badges.append(createTextElement("span", "wcv-correction-chip", "担当教員変更候補"));
      if (categories.includes("meeting")) badges.append(createTextElement("span", "wcv-correction-chip", "曜日・時限・開講期変更候補"));
      if (categories.includes("audience")) badges.append(createTextElement("span", "wcv-correction-chip", "対象学科・学年変更候補"));
      if (categories.includes("language")) badges.append(createTextElement("span", "wcv-correction-chip", "開講言語変更候補"));
      if (badges.childElementCount) item.append(badges);

      const resolvedTitle = resolveCourseTitleByCode(event.courseCode, event.courseName);
      item.append(
        createTextElement("div", "wcv-correction-meta", `講義コード：${event.courseCode}${resolvedTitle ? `（${resolvedTitle}）` : ""}`),
        createTextElement("div", "wcv-correction-excerpt", `PDF抜粋：${event.sourceExcerpt || "抜粋なし"}`)
      );

      const sourceLinks = document.createElement("div");
      sourceLinks.className = "wcv-correction-sources";
      const sourceUrl = historicalSourcePageUrl(event, event.sourcePage);
      if (sourceUrl) {
        const link = createTextElement("a", "wcv-correction-source", `訂正表PDF p.${event.sourcePage} ↗`);
        link.href = sourceUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.title = event.source?.title || "教学課の時間割訂正表PDF";
        link.setAttribute("aria-label", `2026年度 ${event.courseCode} の時間割訂正表PDF ${event.sourcePage}ページを開く`);
        sourceLinks.append(link);
      } else if (event.sourcePage) {
        sourceLinks.append(createTextElement("span", "wcv-correction-source", `訂正表PDF p.${event.sourcePage}`));
      }
      if (sourceLinks.childElementCount) item.append(sourceLinks);
      list.append(item);
    }

    section.append(list);
    return section;
  }

  function createCurrentFallEvidenceSection(course) {
    const records = findCurrentFallReferences(course);
    if (!records.length) return null;

    const section = document.createElement("section");
    section.className = "wcv-fall-evidence";
    section.setAttribute("aria-label", "2026年度後期時間割PDFの掲載行候補");
    section.append(
      createTextElement("h3", "wcv-fall-heading", `2026年度 後期公式時間割PDFの関連行候補（${records.length}件）`),
      createTextElement(
        "p",
        "wcv-fall-caveat",
        "2026年度後期・通年の公式時間割PDF（6資料）から抽出した候補行です。未承認の抽出候補は確定カタログへ自動統合せず、出典PDFページ付きで区別表示しています。"
      )
    );

    const list = document.createElement("ul");
    list.className = "wcv-fall-list";

    const renderFallRecord = (record) => {
      const item = document.createElement("li");
      item.className = "wcv-fall-record";
      const head = document.createElement("div");
      head.className = "wcv-fall-record-head";
      const visuallyReviewed = record.reviewStatus === "visually-reviewed-provisional";
      const reviewLabel = visuallyReviewed
        ? "PDF目視確認済み・参考"
        : record.parseStatus === "cell-anchored-row"
          ? "PDF抽出候補・未確認"
          : "配置推定・要確認";
      head.append(
        createTextElement("strong", "wcv-fall-term", "2026後期PDF"),
        createTextElement(
          "span",
          "wcv-fall-match",
          record.matchKind === "same-code" ? "同一講義コード" : "同名・別コード候補"
        ),
        createTextElement(
          "span",
          "wcv-fall-snapshot",
          state.officialCourseCodes.has(normalizeCode(record.courseCode)) ? "現在の時間割データに収録" : "現在の時間割データに未収録"
        ),
        createTextElement("span", `wcv-fall-status${visuallyReviewed ? " is-reviewed" : ""}`, reviewLabel)
      );
      item.append(head, createTextElement("div", "wcv-fall-title", record.courseName || "科目名の抽出候補なし"));
      item.append(createTextElement(
        "div",
        "wcv-fall-meta",
        `講義コード：${record.courseCode}（${record.scope || "対象未特定"}）`
      ));

      const teachers = visuallyReviewed
        ? (Array.isArray(record.instructors) && record.instructors.length ? record.instructors.join("・") : "担当教員欄の目視記録なし")
        : (record.instructorText || "担当教員の抽出候補なし");
      item.append(createTextElement("div", "wcv-fall-meta", `${visuallyReviewed ? "担当（目視確認）" : "担当候補（抽出）"}：${teachers}`));

      const room = visuallyReviewed
        ? (record.roomStatus === "listed"
          ? (record.room && record.room !== "-" ? `教室（目視確認）：${record.room}` : "教室欄（目視確認）：『-』")
          : record.roomStatus === "blank-in-source" ? "教室欄（目視確認）：空欄" : "教室の目視記録なし")
        : (record.room ? `教室候補（抽出）：${record.room}` : "教室の抽出候補なし");
      item.append(createTextElement("div", "wcv-fall-meta", room));

      const schedules = (Array.isArray(record.scheduleCandidates) ? record.scheduleCandidates : [])
        .map((candidate) => [
          candidate.termCandidate ? `開講期 ${candidate.termCandidate}` : "",
          candidate.dayCandidate ? `曜日 ${candidate.dayCandidate}` : "",
          candidate.periodCandidate ? `時限 ${candidate.periodCandidate}` : ""
        ].filter(Boolean).join(" / "))
        .filter(Boolean);
      if (schedules.length) {
        const scheduleLabel = schedules.length > 1 ? `時間割欄候補（PDF抽出・${schedules.length}通り）` : "時間割欄候補（PDF抽出）";
        item.append(createTextElement("div", "wcv-fall-meta", `${scheduleLabel}：${schedules.join(" ／ ")}`));
      }

      const sourceLinks = document.createElement("div");
      sourceLinks.className = "wcv-fall-sources";
      const locations = Array.isArray(record.sourceLocations) ? record.sourceLocations : [];
      for (const location of locations.slice(0, 4)) {
        const sourceUrl = historicalSourcePageUrl(record, location.page);
        if (sourceUrl) {
          const sourceLink = createTextElement("a", "wcv-fall-source", `後期PDF p.${location.page} ↗`);
          sourceLink.href = sourceUrl;
          sourceLink.target = "_blank";
          sourceLink.rel = "noopener noreferrer";
          sourceLink.title = record.source?.title || "教学課の2026年度後期時間割PDF";
          sourceLink.setAttribute("aria-label", `2026年度後期 ${record.courseCode} の時間割PDF ${location.page}ページを開く`);
          sourceLinks.append(sourceLink);
        } else {
          sourceLinks.append(createTextElement("span", "wcv-fall-source", `後期PDF p.${location.page}`));
        }
      }
      if (locations.length > 4) sourceLinks.append(createTextElement("span", "wcv-fall-meta", `ほか${locations.length - 4}頁`));
      if (sourceLinks.childElementCount) item.append(sourceLinks);
      return item;
    };

    const initialLimit = 6;
    let shownCount = Math.min(records.length, initialLimit);
    for (const record of records.slice(0, shownCount)) list.append(renderFallRecord(record));
    section.append(list);

    if (records.length > shownCount) {
      const expand = document.createElement("button");
      expand.type = "button";
      expand.className = "wcv-fall-expand";
      const updateLabel = () => {
        expand.textContent = `2026後期PDF候補をさらに表示（残り${records.length - shownCount}件）`;
      };
      updateLabel();
      expand.addEventListener("click", () => {
        const nextSlice = records.slice(shownCount, shownCount + 20);
        nextSlice.forEach((record) => list.append(renderFallRecord(record)));
        shownCount += nextSlice.length;
        if (shownCount >= records.length) expand.remove();
        else updateLabel();
      });
      section.append(expand);
    }

    return section;
  }

  function findRelevantStudyGuides(course) {
    const nav = state.studyGuideNavigation;
    if (!nav || !Array.isArray(nav.guides) || !nav.guides.length) return { guides: [], tables: [] };

    const deptText = [
      course?.level || "",
      ...(course?.campuses || []),
      ...(course?.departments || []).map((dept) => `${dept.label || ""} ${dept.sourceGroup || ""} ${dept.code || ""}`)
    ].join(" ");

    const facultyMatchers = [
      { key: "理工学部", pattern: /理工|機械|電気|医用|応用化学|原子力|自然科学/ },
      { key: "建築都市デザイン学部", pattern: /建築|都市工/ },
      { key: "情報工学部", pattern: /情報科学|知能情報|情報工/ },
      { key: "環境学部", pattern: /環境/ },
      { key: "メディア情報学部", pattern: /メディア|社会メディア|情報システム/ },
      { key: "都市生活学部", pattern: /都市生活/ },
      { key: "人間科学部", pattern: /人間科学|児童/ },
      { key: "デザイン・データ科学部", pattern: /デザイン・データ|データ科学/ },
      { key: "大学院", pattern: /大学院|研究科|修士|博士/ }
    ];

    const matchedFaculties = facultyMatchers
      .filter((item) => item.pattern.test(deptText))
      .map((item) => item.key);

    const campusList = uniqueBy([
      ...(course?.campuses || []),
      ...(course?.meetings || []).map((m) => m.campus).filter(Boolean)
    ]);

    const specificGuides = nav.guides.filter((guide) => guide.kind === "study-guide" &&
      matchedFaculties.some((faculty) => String(guide.title || "").includes(faculty))
    );

    const campusAllGuides = nav.guides.filter((guide) => {
      const title = String(guide.title || "");
      if (guide.kind !== "study-guide" || !title.includes("全学部")) return false;
      if (!campusList.length) return true;
      return campusList.some((campus) => String(guide.campus || "").includes(campus.replace("キャンパス", "")));
    });

    const chosenGuides = uniqueBy([...specificGuides, ...campusAllGuides], (guide) => guide.id).slice(0, 2);
    const tables = matchedFaculties.includes("大学院")
      ? nav.guides.filter((guide) => guide.kind === "curriculum-table").slice(0, 3)
      : [];

    return { guides: chosenGuides, tables };
  }

  function createStudyGuideSection(course) {
    const nav = state.studyGuideNavigation;
    if (!nav || !Array.isArray(nav.guides) || !nav.guides.length) return null;
    const { guides, tables } = findRelevantStudyGuides(course);

    const section = document.createElement("section");
    section.className = "wcv-study-guide-evidence";
    section.setAttribute("aria-label", "2026年度履修要覧PDFの関連ページ案内");
    const summary = nav.summary || {};
    section.append(
      createTextElement("h3", "wcv-study-guide-heading", "2026年度 公式履修要覧・教育課程表PDFページ案内"),
      createTextElement(
        "p",
        "wcv-study-guide-caveat",
        `2026年度の資料案内です（学修要覧・履修要綱${summary.studyGuideCount || 0}冊）。所属と入学年度に合う資料を選び、履修条件は公式PDF本文で確認してください。キーワード索引は要件の判定には使えません。`
      )
    );

    const list = document.createElement("div");
    list.className = "wcv-study-guide-list";
    const priorityTerms = ["卒業要件", "修了要件", "必修", "選択", "授業科目", "単位", "履修条件", "教育課程"];

    for (const guide of guides) {
      const card = document.createElement("div");
      card.className = "wcv-study-guide-card";
      const head = document.createElement("div");
      head.className = "wcv-study-guide-card-head";
      head.append(
        createTextElement("strong", "wcv-study-guide-title", guide.title),
        createTextElement("span", "wcv-study-guide-meta", `全${guide.pageCount || "?"}頁`)
      );
      card.append(head);

      const termsWrap = document.createElement("div");
      termsWrap.className = "wcv-study-guide-terms";
      const pdfUrl = historicalSourcePageUrl({ url: guide.url }, 1);
      if (pdfUrl) {
        const topLink = createTextElement("a", "wcv-guide-source is-primary", "表紙・目次 p.1 ↗");
        topLink.href = pdfUrl;
        topLink.target = "_blank";
        topLink.rel = "noopener noreferrer";
        termsWrap.append(topLink);
      }

      const termPages = guide.termPages || {};
      const orderedTerms = [
        ...priorityTerms.filter((term) => Array.isArray(termPages[term]) && termPages[term].length),
        ...Object.keys(termPages).filter((term) => !priorityTerms.includes(term) && Array.isArray(termPages[term]) && termPages[term].length)
      ];

      for (const term of orderedTerms.slice(0, 6)) {
        const pages = termPages[term] || [];
        for (const pageNum of pages.slice(0, 2)) {
          const pageUrl = historicalSourcePageUrl({ url: guide.url }, pageNum);
          if (!pageUrl) continue;
          const link = createTextElement("a", "wcv-guide-source", `${term} p.${pageNum} ↗`);
          link.href = pageUrl;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.title = `${guide.title} - 「${term}」記載候補（${pageNum}ページ）`;
          termsWrap.append(link);
        }
      }
      if (termsWrap.childElementCount) card.append(termsWrap);
      list.append(card);
    }

    for (const table of tables) {
      const card = document.createElement("div");
      card.className = "wcv-study-guide-card";
      const head = document.createElement("div");
      head.className = "wcv-study-guide-card-head";
      head.append(
        createTextElement("strong", "wcv-study-guide-title", table.title),
        createTextElement("span", "wcv-study-guide-meta", "大学院教育課程表PDF")
      );
      card.append(head);
      const pageUrl = historicalSourcePageUrl({ url: table.url }, 1);
      if (pageUrl) {
        const termsWrap = document.createElement("div");
        termsWrap.className = "wcv-study-guide-terms";
        const link = createTextElement("a", "wcv-guide-source is-primary", "教育課程表PDF p.1 ↗");
        link.href = pageUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        termsWrap.append(link);
        card.append(termsWrap);
      }
      list.append(card);
    }

    section.append(list);
    const allGuides = document.createElement("details");
    allGuides.append(createTextElement("summary", "wcv-study-guide-title", "所属から2026年度の資料を選ぶ"));
    const links = document.createElement("div");
    links.className = "wcv-study-guide-terms";
    for (const guide of nav.guides) {
      const url = historicalSourcePageUrl({ url: guide.url }, 1);
      if (!url) continue;
      const link = createTextElement("a", "wcv-guide-source", `${guide.title} ↗`);
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      links.append(link);
    }
    allGuides.append(links);
    section.append(allGuides);
    const archive = createTextElement("a", "wcv-guide-source", "過年度の学部学修要覧一覧 ↗");
    archive.href = "https://www.asc.tcu.ac.jp/syllabus_archives/";
    archive.target = "_blank";
    archive.rel = "noopener noreferrer";
    section.append(archive);
    const gradArchive = createTextElement("a", "wcv-guide-source", "過年度の大学院履修要綱一覧 ↗");
    gradArchive.href = "https://www.asc.tcu.ac.jp/syllabus_grad_archives/";
    gradArchive.target = "_blank";
    gradArchive.rel = "noopener noreferrer";
    section.append(gradArchive);
    return section;
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
    const reviewedRecords = records.filter((record) => record.reviewStatus === "visually-reviewed-provisional");
    const distinctYears = uniqueBy(records.map((record) => record.academicYear).filter(Boolean)).sort((a, b) => b - a);
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
    const defaultDisplayOrder = [...initialRecords, ...remainingRecords];

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

    let activeOrder = defaultDisplayOrder;
    let shownCount = Math.min(8, activeOrder.length);
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "wcv-history-expand";
    const updateExpandLabel = () => {
      const remaining = activeOrder.length - shownCount;
      expand.textContent = `次の最大40件を表示（残り${remaining}件）`;
    };
    expand.setAttribute("aria-expanded", "false");
    expand.addEventListener("click", () => {
      const nextRecords = activeOrder.slice(shownCount, shownCount + 40);
      nextRecords.forEach((record) => list.append(renderRecord(record)));
      shownCount += nextRecords.length;
      expand.setAttribute("aria-expanded", "true");
      if (shownCount >= activeOrder.length) expand.remove();
      else updateExpandLabel();
    });

    const applyFilter = (nextOrder) => {
      activeOrder = nextOrder;
      shownCount = Math.min(8, activeOrder.length);
      list.replaceChildren();
      for (const record of activeOrder.slice(0, shownCount)) list.append(renderRecord(record));
      if (activeOrder.length > shownCount) {
        updateExpandLabel();
        expand.setAttribute("aria-expanded", "false");
        if (!expand.isConnected) section.append(expand);
      } else {
        expand.remove();
      }
    };

    if (records.length > 1 && (sameCode.length && sameTitle.length || reviewedRecords.length || distinctYears.length > 1)) {
      const filterBar = document.createElement("div");
      filterBar.className = "wcv-history-filters";
      filterBar.setAttribute("role", "group");
      filterBar.setAttribute("aria-label", "過年度候補の絞り込み");
      const filterDefs = [
        { id: "all", label: `すべて (${records.length})`, items: defaultDisplayOrder }
      ];
      if (sameCode.length && sameTitle.length) {
        filterDefs.push(
          { id: "same-code", label: `同一コード (${sameCode.length})`, items: sameCode },
          { id: "same-title", label: `同名・別コード (${sameTitle.length})`, items: sameTitle }
        );
      }
      if (reviewedRecords.length) {
        filterDefs.push({ id: "reviewed", label: `目視確認済み (${reviewedRecords.length})`, items: reviewedRecords });
      }
      if (distinctYears.length > 1) {
        for (const year of distinctYears) {
          const yearItems = records.filter((record) => record.academicYear === year);
          filterDefs.push({ id: `year-${year}`, label: `${year}年度 (${yearItems.length})`, items: yearItems });
        }
      }
      for (const def of filterDefs) {
        const btn = createTextElement("button", `wcv-history-filter-btn${def.id === "all" ? " is-active" : ""}`, def.label);
        btn.type = "button";
        btn.dataset.filter = def.id;
        btn.setAttribute("aria-pressed", String(def.id === "all"));
        btn.addEventListener("click", () => {
          for (const sibling of filterBar.querySelectorAll(".wcv-history-filter-btn")) {
            const active = sibling === btn;
            sibling.classList.toggle("is-active", active);
            sibling.setAttribute("aria-pressed", String(active));
          }
          applyFilter(def.items);
        });
        filterBar.append(btn);
      }
      section.append(filterBar);
    }

    for (const record of initialRecords) list.append(renderRecord(record));
    section.append(list);
    if (activeOrder.length > shownCount) {
      updateExpandLabel();
      section.append(expand);
    }
    return section;
  }

  function createMultiOfferingSection(course) {
    const offerings = findSiblingOfferings(course);
    if (offerings.length <= 1) return null;

    const section = document.createElement("section");
    section.className = "wcv-multi-offering-evidence";
    section.setAttribute("aria-label", "同名科目の全開講クラス・教場・担当教員一覧");
    section.append(
      createTextElement(
        "h3",
        "wcv-multi-offering-heading",
        `同じ授業の複数開講クラス一覧（全${offerings.length}開講・教場／担当先生）`
      ),
      createTextElement(
        "p",
        "wcv-multi-offering-caveat",
        "同じ授業名で複数の曜日・時限・クラスが開講されています。データベースから各開講枠の教場（教室）・担当先生・講義コードを一覧表示しています。"
      )
    );

    const list = document.createElement("div");
    list.className = "wcv-multi-offering-list";
    const currentCode = normalizeCode(course?.courseCode);

    const renderOfferingRow = (offering) => {
      const summary = offeringSlotSummary(offering);
      const isCurrent = Boolean(currentCode && normalizeCode(offering.courseCode) === currentCode);
      const row = document.createElement("div");
      row.className = `wcv-offering-row${isCurrent ? " is-current" : ""}`;
      const badgeText = isCurrent ? "現在のクラス" : (offering.isProvisionalFallCandidate ? "後期PDF候補" : "別開講枠");
      row.append(
        createTextElement("span", `wcv-offering-badge${isCurrent ? " is-current" : ""}`, badgeText),
        createTextElement("strong", "wcv-offering-slot", summary.slotLabel),
        createTextElement("span", "wcv-offering-room", `教場: ${summary.roomLabel}`),
        createTextElement("span", "wcv-offering-teacher", `担当: ${summary.teacherLabel}`),
        createTextElement("code", "wcv-offering-code", summary.code || "コード未定")
      );
      return row;
    };

    const initialLimit = 10;
    let shownCount = Math.min(offerings.length, initialLimit);
    for (const offering of offerings.slice(0, shownCount)) list.append(renderOfferingRow(offering));
    section.append(list);

    if (offerings.length > shownCount) {
      const expand = document.createElement("button");
      expand.type = "button";
      expand.className = "wcv-fall-expand";
      const updateLabel = () => {
        expand.textContent = `他クラスの教場・担当先生をさらに表示（残り${offerings.length - shownCount}開講）`;
      };
      updateLabel();
      expand.addEventListener("click", () => {
        const nextSlice = offerings.slice(shownCount, shownCount + 25);
        nextSlice.forEach((offering) => list.append(renderOfferingRow(offering)));
        shownCount += nextSlice.length;
        if (shownCount >= offerings.length) expand.remove();
        else updateLabel();
      });
      section.append(expand);
    }

    return section;
  }

  function curriculumMatches(course) {
    return globalThis.WCV_CURRICULUM?.match(state.curriculumCandidates, {
      plan: state.settings.curriculumPlan, teaching: state.settings.curriculumTeaching, hirameki: state.settings.curriculumHirameki
    }, course?.courseName) || [];
  }

  function curriculumLabel(row) {
    const scope = row.scope.startsWith("hirameki") ? "ひらめき" : row.scope.startsWith("teaching") ? "教職" : "学科";
    return `${scope}の同名資料・要確認`;
  }

  function curriculumSourceKind(row) {
    return row.kind === "choice" ? "資料上は選択必修" : row.kind === "required" ? "資料上は必修" : "資料に掲載";
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
    const campusText = campusesLabel(course);
    const kickerParts = [`${course.academicYear || 2026}年度 ${course.termBlock || course.semester || ""}`.trim()];
    if (campusText && campusText !== "未登録") kickerParts.push(campusText);
    titleBlock.append(
      createTextElement(
        "div",
        "wcv-course-card-kicker",
        kickerParts.join(" ・ ")
      ),
      createTextElement("h2", "wcv-course-card-title", course.courseName)
    );
    if (course.isProvisionalFallCandidate) {
      titleBlock.append(createTextElement(
        "span",
        "wcv-course-provisional-badge",
        course.provisionalReviewStatus === "visually-reviewed-provisional"
          ? "2026後期PDF候補（目視確認済み・基本スナップショット未収録）"
          : "2026後期PDF抽出候補（未確認・基本スナップショット未収録）"
      ));
    }
    const siblingOfferings = findSiblingOfferings(course);
    if (course.ambiguous) {
      titleBlock.append(createTextElement(
        "span",
        "wcv-course-candidate-badge",
        `複数開講 ${course.candidateCount}クラス（教場・担当先生をクラス別に表示）`
      ));
    } else if (siblingOfferings.length > 1) {
      titleBlock.append(createTextElement(
        "span",
        "wcv-course-candidate-badge",
        `全${siblingOfferings.length}開講中・講義コード ${course.courseCode} で特定済`
      ));
    }
    const corrections = getCorrectionEventsForCourse(course);
    if (corrections.length) {
      titleBlock.append(createTextElement(
        "span",
        "wcv-course-correction-badge",
        `2026時間割訂正表に候補 ${corrections.length}件（詳細で確認）`
      ));
    }

    const badge = createTextElement("span", "wcv-source-badge", sourceLabel(course));
    if (!state.settings.showSourceLabel) badge.hidden = true;
    head.append(titleBlock, badge);

    // 主要3項目は常時表示、補助項目は「詳細」で開く
    const keyList = document.createElement("dl");
    keyList.className = "wcv-definition-list wcv-key-list";
    keyList.append(
      createDefinitionRow(course.isProvisionalFallCandidate ? "担当教員候補" : "担当教員", instructorsLabel(course, { maxVisible: 4 }), "wcv-teacher-row"),
      createDefinitionRow(course.isProvisionalFallCandidate ? "教室候補" : "教室", roomsLabel(course, { maxVisible: 4 }), "wcv-room-row"),
      createDefinitionRow(course.isProvisionalFallCandidate ? "曜日・時限候補" : "曜日・時限", meetingsLabel(course, roomsLabel(course).includes(" / ")), "wcv-schedule-row")
    );

    const more = document.createElement("div");
    more.className = "wcv-course-more";
    more.id = "wcv-course-more";
    more.hidden = true;
    const moreList = document.createElement("dl");
    moreList.className = "wcv-definition-list wcv-more-list";
    const deptText = departmentsLabel(course);
    moreList.append(
      createDefinitionRow("キャンパス", campusText === "未登録" ? "指定なし（公式PDF参照）" : campusText, "wcv-campus-row"),
      createDefinitionRow("対象", deptText === "未登録" ? "指定なし（公式PDF参照）" : deptText, "wcv-department-row"),
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
    for (const row of curriculumMatches(course)) {
      const source = state.curriculumCandidates?.sources?.find(item => item.id === row.sourceId);
      if (!source) continue;
      const p = createTextElement("p", "wcv-curriculum-detail", `${curriculumLabel(row)}（${curriculumSourceKind(row)}、この開講科目との対応は未確認）：${row.note} `);
      const a = createTextElement("a", "", row.sourcePage ? `原資料（${row.sourcePage}ページ）` : "原表画像を開く");
      a.href = source.url + (row.sourcePage ? `#page=${row.sourcePage}` : "");
      a.target = "_blank"; a.rel = "noopener noreferrer";
      p.append(a);
      for (const page of row.relatedPages || []) {
        if (!Number.isInteger(page) || page < 1) continue;
        const detailLink = createTextElement("a", "", `選択単位の条件（${page}ページ）`);
        detailLink.href = `${source.url}#page=${page}`;
        detailLink.target = "_blank"; detailLink.rel = "noopener noreferrer";
        p.append(document.createTextNode(" ・ "), detailLink);
      }
      more.append(p);
    }
    const multiOfferingSection = createMultiOfferingSection(course);
    const correctionSection = createCorrectionEvidenceSection(course);
    const currentFallSection = createCurrentFallEvidenceSection(course);
    const historical = createHistoricalEvidenceSection(course);
    const studyGuideSection = createStudyGuideSection(course);

    const tabSections = [
      multiOfferingSection ? { id: "offerings", label: `開講クラス一覧 (${siblingOfferings.length})`, el: multiOfferingSection } : null,
      correctionSection ? { id: "correction", label: `2026訂正表 (${corrections.length})`, el: correctionSection } : null,
      currentFallSection ? { id: "fall", label: "2026後期PDF候補", el: currentFallSection } : null,
      historical ? { id: "history", label: "過年度PDF (2022–2025)", el: historical } : null,
      studyGuideSection ? { id: "guide", label: "履修要覧・課程表案内", el: studyGuideSection } : null
    ].filter(Boolean);

    if (tabSections.length >= 2) {
      const tabBar = document.createElement("div");
      tabBar.className = "wcv-more-tabs";
      tabBar.setAttribute("role", "tablist");
      tabBar.setAttribute("aria-label", "関連データベース表示の切り替え");
      const allTabs = [{ id: "all", label: `すべて表示 (${tabSections.length})` }, ...tabSections];
      for (const tabDef of allTabs) {
        const btn = createTextElement("button", `wcv-more-tab-btn${tabDef.id === "all" ? " is-active" : ""}`, tabDef.label);
        btn.type = "button";
        btn.dataset.sectionTab = tabDef.id;
        btn.setAttribute("aria-selected", String(tabDef.id === "all"));
        btn.addEventListener("click", () => {
          for (const sibling of tabBar.querySelectorAll(".wcv-more-tab-btn")) {
            const active = sibling === btn;
            sibling.classList.toggle("is-active", active);
            sibling.setAttribute("aria-selected", String(active));
          }
          for (const sec of tabSections) {
            sec.el.hidden = tabDef.id !== "all" && sec.id !== tabDef.id;
          }
        });
        tabBar.append(btn);
      }
      more.append(tabBar);
    }

    if (multiOfferingSection) more.append(multiOfferingSection);
    if (correctionSection) more.append(correctionSection);
    if (currentFallSection) more.append(currentFallSection);
    if (historical) more.append(historical);
    if (studyGuideSection) more.append(studyGuideSection);
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

  function copyTextWithFeedback(button, text, doneLabel = "コピー済 ✓") {
    const value = String(text || "").trim();
    if (!value) return;
    const prev = button.textContent;
    const finish = () => {
      button.textContent = doneLabel;
      button.classList.add("is-copied");
      setTimeout(() => {
        if (!button.isConnected) return;
        button.textContent = prev;
        button.classList.remove("is-copied");
      }, 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).then(finish).catch(() => {});
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    try { document.execCommand("copy"); finish(); } catch {}
    ta.remove();
  }

  function findCourseAnchorOnPage(course) {
    if (typeof document === "undefined" || !course) return null;
    const targetCode = normalizeCode(course.courseCode);
    const targetUrl = String(course.webclassUrl || "").trim();
    const candidates = Array.from(document.querySelectorAll(
      "#schedule-table a[href*='/webclass/course.php/'], .schedule-list a[href*='/webclass/course.php/'], ul.courseList a[href*='/webclass/course.php/']"
    ));
    const matches = candidates.filter((anchor) => {
      if (targetUrl && anchor.href === targetUrl) return true;
      const code = normalizeCode(anchor.dataset.wcvCourseCode)
        || extractCourseCodes(`${anchor.href} ${anchor.textContent || ""}`)[0]
        || "";
      return Boolean(targetCode && code && code === targetCode);
    });
    if (!matches.length) return null;
    return matches.find((anchor) => anchor.getClientRects().length > 0) || matches[0];
  }

  function jumpToCourseOnPage(course) {
    const anchor = findCourseAnchorOnPage(course);
    if (!anchor) return false;
    if (anchor.classList.contains("wcv-native-list-hidden") || anchor.closest(".wcv-native-list-hidden")) {
      state.courseListFilter = "all";
      document.querySelectorAll(".wcv-native-list-hidden").forEach((el) => el.classList.remove("wcv-native-list-hidden"));
    }
    document.querySelectorAll(".wcv-jump-highlight").forEach((el) => el.classList.remove("wcv-jump-highlight"));
    anchor.scrollIntoView({ behavior: "smooth", block: "center" });
    anchor.classList.add("wcv-jump-highlight");
    anchor.focus({ preventScroll: true });
    setTimeout(() => anchor.classList.remove("wcv-jump-highlight"), 2600);
    return true;
  }

  function createPanelItemActions(courseOrCode) {
    const isString = typeof courseOrCode === "string";
    const code = isString ? courseOrCode : courseOrCode?.courseCode;
    const course = isString ? null : courseOrCode;
    const wrap = document.createElement("div");
    wrap.className = "wcv-panel-item-actions";
    if (code) {
      const copyBtn = createTextElement("button", "wcv-panel-action-btn", `コードコピー (${code})`);
      copyBtn.type = "button";
      copyBtn.addEventListener("click", () => copyTextWithFeedback(copyBtn, code));
      wrap.append(copyBtn);
    }
    if (course && findCourseAnchorOnPage(course)) {
      const jumpBtn = createTextElement("button", "wcv-panel-action-btn is-jump", "時間割で位置表示 ↗");
      jumpBtn.type = "button";
      jumpBtn.addEventListener("click", () => jumpToCourseOnPage(course));
      wrap.append(jumpBtn);
    }
    if (course?.webclassUrl) {
      const openLink = createTextElement("a", "wcv-panel-action-btn is-open", "コースを開く →");
      openLink.href = course.webclassUrl;
      wrap.append(openLink);
    }
    return wrap.childElementCount ? wrap : null;
  }

  function createPanelCourseItem(course) {
    const item = document.createElement("article");
    item.className = "wcv-panel-course";
    const title = createTextElement("h3", "wcv-panel-course-title", course.courseName);
    const siblings = findSiblingOfferings(course);
    if (course.ambiguous) {
      title.append(createTextElement("span", "wcv-panel-candidate", `複数開講 ${course.candidateCount}クラス`));
    } else if (siblings.length > 1) {
      title.append(createTextElement("span", "wcv-panel-candidate", `全${siblings.length}開講`));
    }
    const corrections = getCorrectionEventsForCourse(course);
    if (corrections.length) {
      title.append(createTextElement("span", "wcv-panel-correction-badge", `訂正候補${corrections.length}件`));
    }
    const meta = document.createElement("div");
    meta.className = "wcv-panel-course-meta";
    const rawRoom = roomsLabel(course, { maxVisible: 2 });
    const cleanRoom = rawRoom === "教室未定" ? "未定" : rawRoom === "教室未定／時間外" ? "未定／時間外" : rawRoom;
    const rawCampus = campusesLabel(course);
    meta.append(
      createTextElement("div", "wcv-panel-meta-line wcv-panel-room", `教室  ${cleanRoom}`),
      createTextElement("div", "wcv-panel-meta-line wcv-panel-teacher", `担当  ${instructorsLabel(course, { maxVisible: 2 })}`),
      createTextElement("div", "wcv-panel-meta-line wcv-panel-time", `開講  ${meetingsLabel(course)}`),
      createTextElement("div", "wcv-panel-meta-line wcv-panel-campus", `場所  ${rawCampus === "未登録" ? "指定なし" : rawCampus}`)
    );
    if (siblings.length > 1) {
      const details = document.createElement("details");
      details.className = "wcv-panel-offerings-details";
      details.append(createTextElement("summary", "wcv-panel-offerings-summary", `全${siblings.length}開講の教場・担当先生を見る`));
      const subList = document.createElement("div");
      subList.className = "wcv-panel-offerings-list";
      const currentCode = normalizeCode(course.courseCode);
      for (const offering of siblings.slice(0, 12)) {
        const s = offeringSlotSummary(offering);
        const isCurrent = Boolean(currentCode && normalizeCode(offering.courseCode) === currentCode);
        subList.append(createTextElement(
          "div",
          `wcv-panel-offering-line${isCurrent ? " is-current" : ""}`,
          `${isCurrent ? "★ " : ""}${s.slotLabel} | 教場: ${s.roomLabel} | 担当: ${s.teacherLabel} (${s.code || "未特定"})`
        ));
      }
      details.append(subList);
      meta.append(details);
    }
    item.append(title, meta);
    const actions = createPanelItemActions(course);
    if (actions) item.append(actions);
    return item;
  }

  function openPanelAndFocusSearch(initialMode = "", opener = document.activeElement) {
    ensureFloatingPanel();
    const panel = document.getElementById(UI_IDS.panel);
    const launcher = document.getElementById(UI_IDS.launcher);
    if (!panel || !launcher) return;
    if (opener instanceof HTMLElement && !panel.contains(opener)) state.panelOpener = opener;
    if (initialMode) {
      state.panelQuickMode = initialMode;
      state.panelSearchQuery = "";
      state.panelLayerFilter = "all";
      const input = panel.querySelector(".wcv-panel-search-input");
      if (input) input.value = "";
      const clearBtn = panel.querySelector(".wcv-panel-search-clear");
      if (clearBtn) clearBtn.hidden = true;
    }
    panel.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    updatePanelContents();
    const input = panel.querySelector(".wcv-panel-search-input");
    input?.focus();
  }

  function restoreSearchFocus() {
    const opener = state.panelOpener;
    state.panelOpener = null;
    const fallback = document.getElementById(UI_IDS.launcher);
    (opener?.isConnected && opener.getClientRects().length && opener !== document.body ? opener : fallback)?.focus();
  }

  function appendSourcePageLinks(item, record, className, prefix) {
    const locations = Array.isArray(record.sourceLocations) ? record.sourceLocations : [];
    const wrap = document.createElement("div");
    wrap.className = "wcv-panel-page-links";
    for (const loc of locations.slice(0, 4)) {
      const url = historicalSourcePageUrl(record, loc.page);
      if (!url) continue;
      const link = createTextElement("a", className, `${prefix} p.${loc.page} ↗`);
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      wrap.append(link);
    }
    if (locations.length > 4) {
      wrap.append(createTextElement("span", "wcv-panel-more-pages", `ほか${locations.length - 4}頁`));
    }
    if (wrap.childElementCount) item.append(wrap);
  }

  function buildCorrectionPanelItem(event) {
    const item = document.createElement("article");
    item.className = "wcv-panel-course wcv-panel-db-item";
    const resolvedTitle = resolveCourseTitleByCode(event.courseCode, event.courseName);
    item.append(
      createTextElement("div", "wcv-panel-layer-tag is-correction", `2026訂正表候補（未適用） ・ ${event.changeDate || "日付未記載"}`),
      createTextElement("h3", "wcv-panel-course-title", resolvedTitle ? `${resolvedTitle} (${event.courseCode})` : `講義コード ${event.courseCode}`),
      createTextElement("div", "wcv-panel-meta-line", event.sourceExcerpt || "")
    );
    const url = historicalSourcePageUrl(event, event.sourcePage);
    if (url) {
      const link = createTextElement("a", "wcv-correction-source", `訂正表PDF p.${event.sourcePage} ↗`);
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      item.append(link);
    }
    const actions = createPanelItemActions(event.courseCode ? { courseCode: event.courseCode } : null);
    if (actions) item.append(actions);
    return item;
  }

  function buildFallPanelItem(record) {
    const item = document.createElement("article");
    item.className = "wcv-panel-course wcv-panel-db-item";
    const reviewed = record.reviewStatus === "visually-reviewed-provisional";
    const teacher = (record.instructors || []).join("・") || record.instructorText || "なし";
    item.append(
      createTextElement(
        "div",
        `wcv-panel-layer-tag ${reviewed ? "is-reviewed" : "is-fall"}`,
        `2026後期PDF候補（${reviewed ? "目視確認済み" : "未確認抽出"}） ・ ${record.courseCode}`
      ),
      createTextElement("h3", "wcv-panel-course-title", record.courseName || "科目名抽出なし"),
      createTextElement("div", "wcv-panel-meta-line", `担当候補: ${teacher} / 教室候補: ${record.room || "なし"}`)
    );
    appendSourcePageLinks(item, record, "wcv-fall-source", "後期PDF");
    const actions = createPanelItemActions(record.courseCode ? { courseCode: record.courseCode } : null);
    if (actions) item.append(actions);
    return item;
  }

  function buildHistoricalPanelItem(record) {
    const item = document.createElement("article");
    item.className = "wcv-panel-course wcv-panel-db-item";
    const reviewed = record.reviewStatus === "visually-reviewed-provisional";
    const teacher = (record.instructors || []).join("・") || record.instructorText || "なし";
    item.append(
      createTextElement(
        "div",
        `wcv-panel-layer-tag ${reviewed ? "is-reviewed" : "is-history"}`,
        `${record.academicYear}年度PDF候補（${reviewed ? "目視確認済み" : "未確認抽出"}） ・ ${record.courseCode}`
      ),
      createTextElement("h3", "wcv-panel-course-title", record.courseName || "科目名抽出なし"),
      createTextElement("div", "wcv-panel-meta-line", `担当候補: ${teacher} / 教室候補: ${record.room || "なし"}`)
    );
    appendSourcePageLinks(item, record, "wcv-history-source", "PDF");
    const actions = createPanelItemActions(record.courseCode ? { courseCode: record.courseCode } : null);
    if (actions) item.append(actions);
    return item;
  }

  function renderStudyGuideList(guides, filterText, listContainer, count) {
    listContainer.replaceChildren();
    const query = String(filterText || "").normalize("NFKC").trim().toLowerCase();
    const defaultTerms = ["卒業要件", "修了要件", "必修", "授業科目", "単位", "GPA", "進級"];
    let matchedGuideCount = 0;

    for (const guide of guides) {
      const termPages = guide.termPages || {};
      const allTermKeys = Object.keys(termPages);
      const matchedTerms = query
        ? allTermKeys.filter((term) => term.normalize("NFKC").toLowerCase().includes(query))
        : defaultTerms.filter((term) => termPages[term]?.[0]);
      const titleMatch = !query || String(guide.title || "").normalize("NFKC").toLowerCase().includes(query);
      if (query && !matchedTerms.length && !titleMatch) continue;

      matchedGuideCount += 1;
      const item = document.createElement("article");
      item.className = "wcv-panel-course wcv-panel-db-item";
      item.append(
        createTextElement("div", "wcv-panel-layer-tag is-snapshot", guide.kind === "curriculum-table" ? "大学院教育課程表PDF" : `2026学修要覧・履修要綱 ・ 全${guide.pageCount || "?"}頁`),
        createTextElement("h3", "wcv-panel-course-title", guide.title)
      );
      const termsWrap = document.createElement("div");
      termsWrap.className = "wcv-study-guide-terms";
      const topUrl = historicalSourcePageUrl({ url: guide.url }, 1);
      if (topUrl) {
        const link = createTextElement("a", "wcv-guide-source is-primary", "表紙・目次 p.1 ↗");
        link.href = topUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        termsWrap.append(link);
      }
      const termsToShow = matchedTerms.length ? matchedTerms.slice(0, query ? 8 : 5) : allTermKeys.slice(0, 4);
      for (const term of termsToShow) {
        const pageNum = termPages[term]?.[0];
        if (!pageNum) continue;
        const pageUrl = historicalSourcePageUrl({ url: guide.url }, pageNum);
        if (!pageUrl) continue;
        const link = createTextElement("a", `wcv-guide-source${query ? " is-matched" : ""}`, `${term} p.${pageNum} ↗`);
        link.href = pageUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        termsWrap.append(link);
      }
      if (termsWrap.childElementCount) item.append(termsWrap);
      listContainer.append(item);
    }

    count.textContent = query ? `${matchedGuideCount}/${guides.length}資料` : `${guides.length}資料`;
    if (!matchedGuideCount) {
      const empty = document.createElement("div");
      empty.className = "wcv-panel-empty";
      empty.append(
        createTextElement("strong", "", "一致する要覧・用語が見つかりません"),
        createTextElement("p", "", "「卒業」「GPA」「進級」「教職」「単位」などのキーワードでお試しください。")
      );
      listContainer.append(empty);
    }
  }

  function renderPanelQuickMode(mode, body, count) {
    if (mode === "corrections") {
      const events = state.correctionEvents || [];
      count.textContent = `${events.length}件`;
      const banner = createTextElement(
        "div",
        "wcv-panel-mode-note",
        "2026年度 公式時間割訂正表PDF（4資料）から抽出した未適用の候補イベント一覧です。必ずPDF原文とWebClassお知らせで確認してください。"
      );
      body.append(banner);
      const visibleCount = Math.min(events.length, state.panelCorrectionLimit || 35);
      for (const event of events.slice(0, visibleCount)) {
        body.append(buildCorrectionPanelItem(event));
      }
      if (visibleCount < events.length) {
        const moreBtn = createTextElement(
          "button",
          "wcv-panel-expand-btn",
          `残りをすべて表示（+${events.length - visibleCount}件）`
        );
        moreBtn.type = "button";
        moreBtn.addEventListener("click", () => {
          state.panelCorrectionLimit = events.length;
          body.dataset.signature = "";
          updatePanelContents();
        });
        body.append(moreBtn);
      }
      return;
    }

    if (mode === "fall-reviewed") {
      const reviewed = (state.currentFallEvidence || []).filter((r) => r.reviewStatus === "visually-reviewed-provisional");
      count.textContent = `${reviewed.length}件`;
      const banner = createTextElement(
        "div",
        "wcv-panel-mode-note",
        "2026年度後期 公式時間割PDFのうち、PDF原文の目視確認が完了している参考行です（全後期候補の検索は上の検索欄をご利用ください）。"
      );
      body.append(banner);
      for (const record of reviewed) {
        body.append(buildFallPanelItem(record));
      }
      return;
    }

    if (mode === "study-guides") {
      const guides = state.studyGuideNavigation?.guides || [];
      const banner = createTextElement(
        "div",
        "wcv-panel-mode-note",
        "2026年度 公式学修要覧・大学院履修要綱・教育課程表PDF（全11冊・用語索引1,030件）のページ案内です。用語を入力して目的のページに直接移動できます。"
      );
      const filterBar = document.createElement("div");
      filterBar.className = "wcv-panel-subsearch-box";
      const subInput = document.createElement("input");
      subInput.type = "search";
      subInput.className = "wcv-panel-subsearch-input";
      subInput.placeholder = "要覧用語で絞り込み（例: 進級・GPA・教職・単位）…";
      subInput.setAttribute("aria-label", "履修要覧用語で絞り込み");
      subInput.value = state.panelGuideFilter || "";

      const chipRow = document.createElement("div");
      chipRow.className = "wcv-panel-guide-chips";
      const listContainer = document.createElement("div");
      listContainer.className = "wcv-guide-results";

      const updateGuideChipStates = () => {
        for (const chip of chipRow.querySelectorAll("button")) {
          const active = (chip.dataset.term || "") === (state.panelGuideFilter || "");
          chip.classList.toggle("is-active", active);
          chip.setAttribute("aria-pressed", String(active));
        }
      };

      for (const [term, label] of [
        ["", "すべて"],
        ["卒業要件", "卒業要件"],
        ["進級", "進級"],
        ["GPA", "GPA"],
        ["教職", "教職"],
        ["休学", "休学"],
        ["単位", "単位"]
      ]) {
        const chip = createTextElement("button", "wcv-panel-guide-chip", label);
        chip.type = "button";
        chip.dataset.term = term;
        chip.addEventListener("click", () => {
          state.panelGuideFilter = term;
          subInput.value = term;
          updateGuideChipStates();
          renderStudyGuideList(guides, term, listContainer, count);
        });
        chipRow.append(chip);
      }

      subInput.addEventListener("input", () => {
        state.panelGuideFilter = subInput.value;
        updateGuideChipStates();
        renderStudyGuideList(guides, state.panelGuideFilter, listContainer, count);
      });

      filterBar.append(subInput, chipRow);
      body.append(banner, filterBar, listContainer);
      updateGuideChipStates();
      renderStudyGuideList(guides, state.panelGuideFilter, listContainer, count);
    }
  }

  function courseSearchBlob(course) {
    if (state.searchBlobCache.has(course)) return state.searchBlobCache.get(course);
    const rooms = (course.meetings || [])
      .flatMap((m) => meetingRooms(m).flatMap((r) => [r, humanizeRoom(r, false)]))
      .concat(course.provisionalRooms || []);
    const slots = (course.meetings || []).flatMap((m) => [
      m.termBlock || "",
      m.day && m.period ? `${m.day}${m.period}` : "",
      m.day && m.period ? `${m.day}${m.period}限` : "",
      m.campus || ""
    ]);
    const depts = (course.departments || []).flatMap((d) => [d.label || "", d.sourceGroup || "", d.code || ""]);
    const blob = [
      course.courseCode || "",
      normalizeCode(course.courseCode),
      course.courseName || "",
      ...(course.aliases || []),
      ...(course.instructors || []),
      ...(course.campuses || []),
      ...rooms,
      ...slots,
      ...depts
    ].join(" ").normalize("NFKC").toLowerCase();
    state.searchBlobCache.set(course, blob);
    return blob;
  }

  function textMatchesAllTokens(haystack, tokens) {
    return tokens.every((token) => haystack.includes(token));
  }

  function searchDatabaseAcrossLayers(rawQuery) {
    const query = String(rawQuery || "").normalize("NFKC").trim().toLowerCase();
    if (query.length < 2) return null;
    const tokens = query.split(/\s+/).filter(Boolean);
    const exactQuery = normalizeExactCourseTitle(query);
    const normTitle = normalizeCourseName(query);

    const scoredBase = [];
    for (const course of state.courses) {
      const code = normalizeCode(course.courseCode);
      const name = String(course.courseName || "").normalize("NFKC").toLowerCase();
      const exactName = normalizeExactCourseTitle(course.courseName);
      const teachers = (course.instructors || []).join(" ").normalize("NFKC").toLowerCase();
      const blob = courseSearchBlob(course);
      let score = 0;
      if (code && code === query) score = 100;
      else if (exactQuery && exactName === exactQuery) score = 90;
      else if (code && code.includes(query)) score = 80;
      else if (name.includes(query) || (exactQuery && exactName.includes(exactQuery))) score = 70;
      else if (teachers.includes(query)) score = 60;
      else if (blob.includes(query)) score = 50;
      else if (tokens.length > 1 && textMatchesAllTokens(blob, tokens)) score = 45;
      else if (normTitle.length >= 2 && normalizeCourseName(course.courseName).includes(normTitle)) score = 40;
      if (score > 0) scoredBase.push({ course, score });
    }
    scoredBase.sort((a, b) => b.score - a.score);
    const baseMatches = scoredBase.slice(0, 200).map((item) => item.course);

    const correctionMatches = [];
    let correctionCount = 0;
    for (const event of state.correctionEvents || []) {
      const resolvedTitle = resolveCourseTitleByCode(event.courseCode, event.courseName);
      const hay = [event.courseCode, event.courseName, resolvedTitle, event.sourceExcerpt, event.changeDate]
        .filter(Boolean).join(" ").normalize("NFKC").toLowerCase();
      if (hay.includes(query) || (tokens.length > 1 && textMatchesAllTokens(hay, tokens))) {
        correctionCount += 1;
        if (correctionMatches.length < 200) correctionMatches.push(event);
      }
    }

    const fallMatches = [];
    let fallCount = 0;
    for (const record of state.currentFallEvidence || []) {
      const slots = (record.scheduleCandidates || [])
        .map((c) => `${c.termCandidate || ""} ${c.dayCandidate || ""}${c.periodCandidate || ""}`).join(" ");
      const hay = [record.courseCode, record.courseName, record.instructorText, ...(record.instructors || []), record.room, slots]
        .filter(Boolean).join(" ").normalize("NFKC").toLowerCase();
      if (hay.includes(query) || (tokens.length > 1 && textMatchesAllTokens(hay, tokens))) {
        fallCount += 1;
        if (fallMatches.length < 200) fallMatches.push(record);
      }
    }

    const historicalMatches = [];
    let historicalCount = 0;
    for (const record of state.historicalEvidence || []) {
      const hay = [record.academicYear, record.courseCode, record.courseName, record.instructorText, ...(record.instructors || []), record.room]
        .filter(Boolean).join(" ").normalize("NFKC").toLowerCase();
      if (hay.includes(query) || (tokens.length > 1 && textMatchesAllTokens(hay, tokens))) {
        historicalCount += 1;
        if (historicalMatches.length < 200) historicalMatches.push(record);
      }
    }

    const counts = {
      base: scoredBase.length,
      correction: correctionCount,
      fall: fallCount,
      historical: historicalCount
    };
    return {
      query,
      baseMatches,
      correctionMatches,
      fallMatches,
      historicalMatches,
      counts,
      total: counts.base + counts.correction + counts.fall + counts.historical
    };
  }

  function renderPanelSearchResults(results, body) {
    if (!results.total) {
      const empty = document.createElement("div");
      empty.className = "wcv-panel-empty";
      empty.append(
        createTextElement("strong", "", "該当する科目・候補が見つかりませんでした。"),
        createTextElement("p", "", "講義コード（例: leb05601）、科目名、教員名、教室（例: 12K）、曜日時限（例: 水2）の複数条件検索ができます。")
      );
      body.append(empty);
      return;
    }

    const layerDefs = [
      ["all", "すべて", results.total],
      ["base", "基本DB", results.counts.base],
      ["correction", "訂正表", results.counts.correction],
      ["fall", "後期PDF", results.counts.fall],
      ["history", "過年度", results.counts.historical]
    ].filter(([key, , cnt]) => key === "all" || cnt > 0);

    if (!layerDefs.some(([key]) => key === state.panelLayerFilter)) {
      state.panelLayerFilter = "all";
    }

    if (layerDefs.length > 2) {
      const bar = document.createElement("div");
      bar.className = "wcv-panel-layer-bar";
      bar.setAttribute("role", "group");
      bar.setAttribute("aria-label", "データベース層で絞り込み");
      for (const [key, label, cnt] of layerDefs) {
        const active = state.panelLayerFilter === key;
        const btn = createTextElement("button", `wcv-panel-layer-btn${active ? " is-active" : ""}`, `${label} (${cnt})`);
        btn.type = "button";
        btn.setAttribute("aria-pressed", String(active));
        btn.addEventListener("click", () => {
          state.panelLayerFilter = key;
          state.panelSearchLimit = 12;
          updatePanelContents();
        });
        bar.append(btn);
      }
      body.append(bar);
    }

    const orderedEntries = [];
    const filter = state.panelLayerFilter;
    if (filter === "all" || filter === "base") {
      for (const course of results.baseMatches) orderedEntries.push({ kind: "base", data: course });
    }
    if (filter === "all" || filter === "correction") {
      for (const event of results.correctionMatches) orderedEntries.push({ kind: "correction", data: event });
    }
    if (filter === "all" || filter === "fall") {
      for (const record of results.fallMatches) orderedEntries.push({ kind: "fall", data: record });
    }
    if (filter === "all" || filter === "history") {
      for (const record of results.historicalMatches) orderedEntries.push({ kind: "history", data: record });
    }

    const limit = Math.max(12, state.panelSearchLimit || 12);
    const slice = orderedEntries.slice(0, limit);
    for (const entry of slice) {
      if (entry.kind === "base") {
        const item = createPanelCourseItem(entry.data);
        item.prepend(createTextElement("div", "wcv-panel-layer-tag is-snapshot", `2026基本スナップショット ・ ${entry.data.courseCode || "コード未特定"}`));
        body.append(item);
      } else if (entry.kind === "correction") {
        body.append(buildCorrectionPanelItem(entry.data));
      } else if (entry.kind === "fall") {
        body.append(buildFallPanelItem(entry.data));
      } else {
        body.append(buildHistoricalPanelItem(entry.data));
      }
    }

    if (orderedEntries.length > limit) {
      const remaining = orderedEntries.length - limit;
      const moreBtn = createTextElement(
        "button",
        "wcv-panel-expand-btn",
        `さらに表示（残り${remaining}件を表示）`
      );
      moreBtn.type = "button";
      moreBtn.addEventListener("click", () => {
        state.panelSearchLimit = limit + 20;
        updatePanelContents();
      });
      body.append(moreBtn);
    }
  }

  function updatePanelContents() {
    const panel = document.getElementById(UI_IDS.panel);
    if (!panel) return;
    const body = panel.querySelector(".wcv-panel-body");
    const count = panel.querySelector(".wcv-panel-count");
    if (!body || !count) return;

    const query = state.panelSearchQuery.trim();
    const clearBtn = panel.querySelector(".wcv-panel-search-clear");
    if (clearBtn) clearBtn.hidden = query.length === 0;
    const quickBtns = panel.querySelectorAll(".wcv-panel-quick-btn");
    for (const btn of quickBtns) {
      const active = query.length < 2 && btn.dataset.mode === state.panelQuickMode;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    }

    if (query.length >= 2) {
      const signature = `search:${query}|${state.panelLayerFilter}|${state.panelSearchLimit}`;
      if (body.dataset.signature === signature) return;
      body.dataset.signature = signature;
      body.replaceChildren();
      const results = searchDatabaseAcrossLayers(query);
      count.textContent = `${results.total}件`;
      renderPanelSearchResults(results, body);
      return;
    }

    if (state.panelQuickMode !== "detected") {
      const signature = `mode:${state.panelQuickMode}:${state.panelCorrectionLimit}`;
      if (body.dataset.signature === signature) return;
      body.dataset.signature = signature;
      body.replaceChildren();
      renderPanelQuickMode(state.panelQuickMode, body, count);
      return;
    }

    const courses = state.currentCourse ? [state.currentCourse] : [...state.detectedCourses.values()].slice(0, 10);
    const signature = `detected:${courses.map(courseKey).join("|")}`;
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
        createTextElement("strong", "", isLoginEntrancePage() ? "ログイン前の画面でも全学DBを検索できます" : "この画面では授業名を検出できませんでした"),
        createTextElement("p", "", "上の検索欄に講義コード・科目名・教員名・教室・曜日時限を入力するか、下のクイックボタンから公式PDFデータベースを閲覧できます。")
      );
      const actions = document.createElement("div");
      actions.className = "wcv-panel-empty-actions";
      for (const [mode, label] of [
        ["corrections", `2026訂正表候補を見る (${state.correctionEvents.length}件)`],
        ["fall-reviewed", "2026後期PDF（目視確認済）を見る"],
        ["study-guides", `2026公式履修要覧を開く (${state.studyGuideNavigation?.summary?.studyGuideCount || 11}冊)`]
      ]) {
        const btn = createTextElement("button", "wcv-panel-empty-btn", label);
        btn.type = "button";
        btn.addEventListener("click", () => {
          state.panelQuickMode = mode;
          updatePanelContents();
        });
        actions.append(btn);
      }
      empty.append(actions);
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
      newLauncher.title = "授業情報・全学DB検索 (/ または Ctrl+K)";
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
        createTextElement("h2", "wcv-panel-title", "授業情報・全学DB検索")
      );
      const count = createTextElement("span", "wcv-panel-count", "0件");
      const close = document.createElement("button");
      close.type = "button";
      close.className = "wcv-panel-close";
      close.setAttribute("aria-label", "授業情報パネルを閉じる");
      close.textContent = "×";
      header.append(heading, count, close);

      const searchWrap = document.createElement("div");
      searchWrap.className = "wcv-panel-search";
      const searchBox = document.createElement("div");
      searchBox.className = "wcv-panel-search-box";
      const searchInput = document.createElement("input");
      searchInput.type = "search";
      searchInput.className = "wcv-panel-search-input";
      searchInput.placeholder = "コード・科目・教員・教室(例: 12K)・曜日(例: 水2)で検索…";
      searchInput.setAttribute("aria-label", "データベース横断検索");
      searchInput.value = state.panelSearchQuery;
      const clearBtn = createTextElement("button", "wcv-panel-search-clear", "×");
      clearBtn.type = "button";
      clearBtn.hidden = !state.panelSearchQuery;
      clearBtn.setAttribute("aria-label", "検索語をクリア");
      clearBtn.addEventListener("click", () => {
        state.panelSearchQuery = "";
        state.panelLayerFilter = "all";
        state.panelSearchLimit = 12;
        searchInput.value = "";
        updatePanelContents();
        searchInput.focus();
      });
      searchInput.addEventListener("input", () => {
        state.panelSearchQuery = searchInput.value;
        state.panelLayerFilter = "all";
        state.panelSearchLimit = 12;
        updatePanelContents();
      });
      searchBox.append(searchInput, clearBtn);

      const quickBar = document.createElement("div");
      quickBar.className = "wcv-panel-quick-bar";
      quickBar.setAttribute("role", "group");
      quickBar.setAttribute("aria-label", "表示モード切り替え");
      for (const [mode, label] of [
        ["detected", "この画面"],
        ["corrections", `訂正表 (${state.correctionEvents.length})`],
        ["fall-reviewed", "後期確認済"],
        ["study-guides", "履修要覧"]
      ]) {
        const qBtn = createTextElement("button", `wcv-panel-quick-btn${state.panelQuickMode === mode ? " is-active" : ""}`, label);
        qBtn.type = "button";
        qBtn.dataset.mode = mode;
        qBtn.setAttribute("aria-pressed", String(state.panelQuickMode === mode));
        qBtn.addEventListener("click", () => {
          state.panelQuickMode = mode;
          state.panelSearchQuery = "";
          state.panelLayerFilter = "all";
          searchInput.value = "";
          updatePanelContents();
        });
        quickBar.append(qBtn);
      }
      searchWrap.append(searchBox, quickBar);

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
      newPanel.append(header, searchWrap, body, footer);

      const setOpen = (open) => {
        newPanel.hidden = !open;
        newLauncher.setAttribute("aria-expanded", String(open));
        if (open) updatePanelContents();
      };
      newLauncher.addEventListener("click", () => setOpen(newPanel.hidden));
      close.addEventListener("click", () => {
        setOpen(false);
        restoreSearchFocus();
      });
      if (!document.documentElement.dataset.wcvPanelKeybound) {
        document.documentElement.dataset.wcvPanelKeybound = "true";
        document.addEventListener("keydown", (event) => {
          const livePanel = document.getElementById(UI_IDS.panel);
          if (event.key === "Escape" && livePanel && !livePanel.hidden) {
            livePanel.hidden = true;
            document.getElementById(UI_IDS.launcher)?.setAttribute("aria-expanded", "false");
            restoreSearchFocus();
            return;
          }
          const isShortcut = (event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey) && !event.altKey)
            || (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey);
          if (!isShortcut || !state.settings.enabled || !state.settings.showFloatingPanel || isCourseContentPage()) return;
          const activeTag = document.activeElement?.tagName;
          const inEditable = activeTag === "INPUT" || activeTag === "TEXTAREA" || activeTag === "SELECT" || document.activeElement?.isContentEditable;
          if (inEditable) return;
          event.preventDefault();
          openPanelAndFocusSearch();
        });
      }
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

  function nativeMeetingFor(course, day, period, contextText = "") {
    const meetings = course?.meetings || [];
    const termHints = extractTermHints(contextText);
    const hasPeriod = Number.isInteger(Number(period));
    if (termHints.length) {
      const exactTermSlot = meetings.find((m) => m.day === day && Number(m.period) === Number(period) && meetingMatchesTermHints(m, termHints));
      if (exactTermSlot) return exactTermSlot;
    }
    const exactSlot = meetings.find((m) => m.day === day && Number(m.period) === Number(period));
    if (exactSlot) return exactSlot;
    if (termHints.length && hasPeriod) {
      const termPeriod = meetings.find((m) => Number(m.period) === Number(period) && meetingMatchesTermHints(m, termHints));
      if (termPeriod) return termPeriod;
    }
    const byPeriod = hasPeriod ? meetings.find((m) => Number(m.period) === Number(period)) : null;
    if (byPeriod) return byPeriod;
    if (termHints.length) {
      const byTerm = meetings.find((m) => meetingMatchesTermHints(m, termHints));
      if (byTerm) return byTerm;
    }
    return meetings[0] || null;
  }

  function nativePeriodBounds(meeting, period) {
    const profiles = state.dataset?.dataset?.periodProfiles || {};
    const profileId = meeting?.timeProfile || "standard";
    const profile = profiles[profileId] || profiles.standard;
    const info = profile?.periods?.[String(period)];
    if (!info) return null;
    return {
      start: meeting?.startsAtNine ? "09:00" : info.start,
      end: info.end
    };
  }

  function nativePeriodLabel(period, meeting = null) {
    const bounds = nativePeriodBounds(meeting, period);
    return bounds ? `${bounds.start}〜${bounds.end}` : "";
  }

  function resolveNativeSlotInfo(course, day, period, contextText = "") {
    const termHints = extractTermHints(contextText);
    const meeting = nativeMeetingFor(course, day, period, contextText);
    const hasMultiOfferings = Array.isArray(course?.offerings) && course.offerings.length > 1;
    const singleMeetingRoom = meeting ? roomForMeeting(meeting) : "";
    const room = hasMultiOfferings
      ? roomsLabel(course, { day, period, maxVisible: 2, termHints })
      : (singleMeetingRoom && singleMeetingRoom !== "教室未定" ? singleMeetingRoom : roomsLabel(course, { day, period, maxVisible: 2, termHints }));
    const teacher = hasMultiOfferings
      ? instructorsLabel(course, { day, period, maxVisible: 2, termHints })
      : shortInstructors(course?.instructors, 2);
    const siblings = findSiblingOfferings(course);
    const corrections = getCorrectionEventsForCourse(course);
    return { meeting, room, teacher, siblings, corrections };
  }

  function registerNativeScheduleEntry({ anchor, course, day, period, slotInfo }) {
    if (!course || !day || !Number.isInteger(Number(period))) return;
    const key = `${day}|${period}|${courseKey(course)}`;
    const nextEntry = {
      key,
      day,
      period: Number(period),
      course,
      anchor,
      href: anchor?.href || webclassCourseUrl(anchor) || "",
      room: slotInfo.room,
      teacher: slotInfo.teacher,
      meeting: slotInfo.meeting,
      correctionsCount: slotInfo.corrections.length
    };
    const idx = state.nativeScheduleEntries.findIndex((item) => item.key === key);
    if (idx < 0) {
      state.nativeScheduleEntries.push(nextEntry);
      return;
    }
    const existingVisible = state.nativeScheduleEntries[idx].anchor?.getClientRects?.().length > 0;
    const nextVisible = anchor?.getClientRects?.().length > 0;
    if (!existingVisible && nextVisible) {
      state.nativeScheduleEntries[idx] = nextEntry;
    }
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
    const valueEl = document.createElement("span");
    valueEl.className = "wcv-native-card-meta-value";
    const text = String(value == null ? "" : value);
    if (className === "wcv-native-card-room" && text.includes("・")) {
      const idx = text.lastIndexOf("・");
      if (text.length <= 11 && !text.includes("/")) {
        valueEl.classList.add("wcv-room-nowrap");
      }
      valueEl.append(
        document.createTextNode(text.slice(0, idx)),
        createTextElement("span", "wcv-room-code", text.slice(idx))
      );
    } else {
      valueEl.textContent = text;
    }
    line.append(
      createTextElement("span", "wcv-native-card-meta-label", label),
      valueEl
    );
    return line;
  }

  function enhanceNativeCourseAnchor(anchor, course, day, period, contextText = "") {
    if (!(anchor instanceof HTMLAnchorElement) || !course) return null;
    const slotInfo = resolveNativeSlotInfo(course, day, period, contextText);
    if (anchor.dataset.wcvNativeEnhanced === "true") return slotInfo;
    rememberNativeElement(anchor);

    const rawStatus = Array.from(anchor.querySelectorAll(".course-new-message, .course-contents-info, .badge"))
      .map((element) => element.textContent)
      .map(compactStatusText)
      .filter(Boolean);
    const { meeting, room, teacher, siblings, corrections } = slotInfo;

    anchor.innerHTML = "";
    addNativeClass(anchor, "wcv-native-course-card", categoryClass(course));
    anchor.dataset.wcvNativeEnhanced = "true";
    anchor.dataset.wcvAnnotated = "true";
    anchor.dataset.wcvCourseCode = course.courseCode || "";
    anchor.setAttribute("aria-label", `${course.courseName}、教室 ${room}、担当 ${teacher}`);
    const siblingTooltip = siblings.length > 1
      ? `\n--- 同名科目の開講一覧 (全${siblings.length}開講) ---\n` + siblings.slice(0, 8).map((off) => {
          const s = offeringSlotSummary(off);
          return `・${s.slotLabel}: 教場 ${s.roomLabel} / 担当 ${s.teacherLabel} (${s.code || "未特定"})`;
        }).join("\n")
      : "";
    anchor.title = `${course.courseName}\n教室: ${room}\n担当: ${teacher}\n講義コード: ${course.courseCode || "複数候補"}${siblingTooltip}`;

    const top = document.createElement("span");
    top.className = "wcv-native-card-top";
    const hiddenCode = document.createElement("span");
    hiddenCode.hidden = true;
    hiddenCode.textContent = `_${course.courseCode && /[a-z]{3,4}\d{4,6}/i.test(course.courseCode) ? course.courseCode : "wcv0000"}`;
    top.append(
      createTextElement("span", "wcv-native-card-title", course.courseName),
      hiddenCode,
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
    for (const row of curriculumMatches(course)) {
      const label = curriculumLabel(row);
      const badge = createTextElement("span", "wcv-native-status wcv-curriculum-candidate", label);
      badge.title = `${row.note} 授業詳細から原資料を確認できます。`;
      statusWrap.append(badge);
      anchor.setAttribute("aria-label", `${anchor.getAttribute("aria-label")}、${label}`);
    }
    for (const status of statuses.slice(0, 3)) {
      const kind = /締切/.test(status) ? "wcv-native-status-deadline" : "wcv-native-status-new";
      statusWrap.append(createTextElement("span", `wcv-native-status ${kind}`, status));
    }
    if (siblings.length > 1) {
      statusWrap.append(createTextElement(
        "span",
        "wcv-native-status wcv-native-status-multi",
        course.courseCode ? `${course.courseCode}・全${siblings.length}開講` : `複数開講 ${siblings.length}クラス`
      ));
    }
    if (corrections.length) {
      statusWrap.append(createTextElement("span", "wcv-native-status wcv-native-status-correction", `訂正表候補${corrections.length}件`));
    }

    anchor.append(top, meta);
    if (statusWrap.childElementCount) anchor.append(statusWrap);
    return slotInfo;
  }

  function enhanceNativeScheduleTable() {
    const table = document.querySelector("#schedule-table");
    state.nativeDetectedCourses = new Map();
    if (!table || !hasNativeScheduleGrid()) return;
    addNativeClass(table, "wcv-native-schedule-table");
    addNativeClass(table.closest(".table-responsive") || table.parentElement, "wcv-native-schedule-viewport");
    const semesterText = selectedSemesterText();
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
          const anchorContext = [elementText(anchor), semesterText].filter(Boolean).join(" ");
          const matched = findCourse(`${anchor.href} ${anchor.textContent || ""}`, { day, period, semesterText });
          if (!matched) continue;
          const course = courseForContext(matched, anchorContext);
          state.nativeDetectedCourses.set(courseKey(course), course);
          const slotInfo = enhanceNativeCourseAnchor(anchor, course, day, period, anchorContext);
          if (slotInfo) registerNativeScheduleEntry({ anchor, course, day, period, slotInfo });
        }
      });
    }
  }

  function enhanceNativeMobileSchedule() {
    const schedule = document.querySelector(".schedule-list");
    if (!schedule) return;
    addNativeClass(schedule, "wcv-native-mobile-schedule");
    const semesterText = selectedSemesterText();
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
        const anchorContext = [elementText(child), semesterText].filter(Boolean).join(" ");
        const matched = findCourse(`${child.href} ${child.textContent || ""}`, { day, period, semesterText });
        if (matched) {
          const course = courseForContext(matched, anchorContext);
          state.nativeDetectedCourses.set(courseKey(course), course);
          const slotInfo = enhanceNativeCourseAnchor(child, course, day, period, anchorContext);
          if (slotInfo) registerNativeScheduleEntry({ anchor: child, course, day, period, slotInfo });
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
      syncSidebarAppearance(existing.querySelector("#wcv-sidebar-appearance"));
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
    const appearanceLabel = createTextElement("label", "wcv-sidebar-appearance", "見た目");
    const appearance = document.createElement("select");
    appearance.id = "wcv-sidebar-appearance";
    appearance.append(new Option("標準", "standard"), new Option("モダン", "modern"));
    syncSidebarAppearance(appearance);
    appearance.addEventListener("change", () => chrome.storage.local.set({ appearance: appearance.value }));
    appearanceLabel.append(appearance);
    options.append(appearanceLabel);
    for (const [key, title, description] of [
      ["modernizeNativeLayout", "参加しているコースをカード表示", "時間割表に教場・担当先生・講義コードを統合表示"],
      ["showInlineMetadata", "その他のコースにも補足表示", "時間割外のコース一覧にも教場・担当先生を追加"],
      ["showDeadlineList", "締め切りが近い課題", "左側に1週間以内の課題を表示"]
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

  function jstNowParts(date = new Date()) {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
    const weekMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dayLabels = ["日", "月", "火", "水", "木", "金", "土"];
    const weekdayIndex = weekMap[parts.weekday] ?? 0;
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      weekdayIndex,
      weekdayJa: dayLabels[weekdayIndex],
      hour: Number(parts.hour) % 24,
      minute: Number(parts.minute)
    };
  }

  function timeStringToMinutes(text) {
    const match = String(text || "").match(/^(\d{1,2}):(\d{2})$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function formatIcsDate(year, month, day, hhmm) {
    const [hh, mm] = String(hhmm || "00:00").split(":");
    const pad = (v) => String(v).padStart(2, "0");
    return `${year}${pad(month)}${pad(day)}T${pad(hh)}${pad(mm)}00`;
  }

  function escapeIcsText(value) {
    return String(value || "")
      .replace(/\\/g, "\\\\")
      .replace(/\r?\n/g, "\\n")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,");
  }

  function buildTimetableIcs(entries, options = {}) {
    const refDate = options.referenceDate instanceof Date ? options.referenceDate : new Date();
    const now = jstNowParts(refDate);
    const dayIndexMap = { "日": 0, "月": 1, "火": 2, "水": 3, "木": 4, "金": 5, "土": 6 };
    const stamp = `${now.year}${String(now.month).padStart(2, "0")}${String(now.day).padStart(2, "0")}T${String(now.hour).padStart(2, "0")}${String(now.minute).padStart(2, "0")}00`;

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//TCU WebClass Visual//Timetable Export//JA",
      "CALSCALE:GREGORIAN",
      "BEGIN:VTIMEZONE",
      "TZID:Asia/Tokyo",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0900",
      "TZOFFSETTO:+0900",
      "TZNAME:JST",
      "END:STANDARD",
      "END:VTIMEZONE"
    ];

    for (const entry of entries || []) {
      const targetDayIdx = dayIndexMap[entry.day];
      if (targetDayIdx == null || !Number.isInteger(Number(entry.period))) continue;
      const bounds = nativePeriodBounds(entry.meeting, entry.period);
      if (!bounds?.start || !bounds?.end) continue;
      const deltaDays = (targetDayIdx - now.weekdayIndex + 7) % 7;
      const dt = new Date(Date.UTC(now.year, now.month - 1, now.day + deltaDays));
      const y = dt.getUTCFullYear();
      const m = dt.getUTCMonth() + 1;
      const d = dt.getUTCDate();
      const code = entry.course?.courseCode || "";
      const summary = entry.course?.courseName || "授業";
      const campus = entry.meeting?.campus && !String(entry.room || "").includes(entry.meeting.campus)
        ? `${entry.meeting.campus} ` : "";
      const location = entry.room && entry.room !== "教室未定" ? `${campus}${entry.room}` : (entry.meeting?.campus || "");
      const descParts = [
        code ? `講義コード: ${code}` : "",
        entry.teacher ? `担当: ${entry.teacher}` : "",
        entry.href ? `WebClass: ${entry.href}` : ""
      ].filter(Boolean);
      const uid = `tcu-wcv-${encodeURIComponent(code || summary)}-${targetDayIdx}-${entry.period}@webclass.tcu.ac.jp`;

      lines.push(
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTAMP;TZID=Asia/Tokyo:${stamp}`,
        `DTSTART;TZID=Asia/Tokyo:${formatIcsDate(y, m, d, bounds.start)}`,
        `DTEND;TZID=Asia/Tokyo:${formatIcsDate(y, m, d, bounds.end)}`,
        "RRULE:FREQ=WEEKLY;COUNT=15",
        `SUMMARY:${escapeIcsText(summary)}`,
        ...(location ? [`LOCATION:${escapeIcsText(location)}`] : []),
        ...(descParts.length ? [`DESCRIPTION:${escapeIcsText(descParts.join("\n"))}`] : []),
        "END:VEVENT"
      );
    }

    lines.push("END:VCALENDAR");
    return `${lines.join("\r\n")}\r\n`;
  }

  function downloadTimetableIcs(button) {
    if (!state.nativeScheduleEntries.length) return;
    const ics = buildTimetableIcs(state.nativeScheduleEntries);
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "tcu-webclass-timetable.ics";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (button) {
      const prev = button.textContent;
      button.textContent = "保存済 ✓";
      button.classList.add("is-copied");
      setTimeout(() => {
        if (!button.isConnected) return;
        button.textContent = prev;
        button.classList.remove("is-copied");
      }, 1800);
    }
  }

  function ensureTodayTimetableStrip(form) {
    if (!form) return;
    const target = form.querySelector(".wcv-native-schedule-viewport, #schedule-table, .wcv-native-mobile-schedule");
    if (!target || !state.nativeScheduleEntries.length) {
      document.getElementById("wcv-today-strip")?.remove();
      return;
    }

    const now = jstNowParts();
    const weekdays = ["月", "火", "水", "木", "金", "土"];
    const defaultDay = weekdays.includes(now.weekdayJa) ? now.weekdayJa : "月";
    const activeDay = weekdays.includes(state.todaySelectedDay) ? state.todaySelectedDay : defaultDay;
    const isViewingToday = activeDay === now.weekdayJa;
    const nowMinutes = now.hour * 60 + now.minute;

    const dayEntries = state.nativeScheduleEntries
      .filter((entry) => entry.day === activeDay)
      .sort((a, b) => a.period - b.period);

    const signature = [
      activeDay,
      now.weekdayJa,
      Math.floor(nowMinutes / 5),
      state.todayStripCollapsed ? "1" : "0",
      dayEntries.map((e) => `${e.key}:${e.room}:${e.teacher}:${e.correctionsCount}`).join("|"),
      state.nativeScheduleEntries.length
    ].join("#");

    let strip = document.getElementById("wcv-today-strip");
    if (strip && strip.dataset.signature === signature) return;

    withOwnMutation(() => {
      if (!strip) {
        strip = document.createElement("section");
        strip.id = "wcv-today-strip";
        strip.className = "wcv-today-strip wcv-root wcv-native-injected";
        strip.setAttribute("aria-label", "今日の授業と時間割ユーティリティ");
        target.insertAdjacentElement("beforebegin", strip);
      }
      strip.dataset.signature = signature;
      strip.replaceChildren();

      const header = document.createElement("div");
      header.className = "wcv-today-header";
      const titleGroup = document.createElement("div");
      titleGroup.className = "wcv-today-title-group";
      titleGroup.append(createTextElement(
        "strong",
        "wcv-today-title",
        isViewingToday ? `今日の授業 (${now.weekdayJa}曜)` : `${activeDay}曜の授業`
      ));
      if (!weekdays.includes(now.weekdayJa) && activeDay === "月" && !state.todaySelectedDay) {
        titleGroup.append(createTextElement("span", "wcv-today-subbadge", "日曜のため月曜を表示"));
      }

      const dayTabs = document.createElement("div");
      dayTabs.className = "wcv-today-day-tabs";
      dayTabs.setAttribute("role", "group");
      dayTabs.setAttribute("aria-label", "表示する曜日を選択");
      for (const day of weekdays) {
        const countForDay = state.nativeScheduleEntries.filter((e) => e.day === day).length;
        const active = day === activeDay;
        const isToday = day === now.weekdayJa;
        const label = isToday ? `${day}(今日)` : day;
        const btn = createTextElement(
          "button",
          `wcv-today-day-btn${active ? " is-active" : ""}${isToday ? " is-today" : ""}${countForDay === 0 ? " is-empty" : ""}`,
          label
        );
        btn.type = "button";
        btn.setAttribute("aria-pressed", String(active));
        btn.title = countForDay ? `${day}曜: ${countForDay}科目` : `${day}曜: 授業なし`;
        btn.addEventListener("click", () => {
          state.todaySelectedDay = day;
          ensureTodayTimetableStrip(form);
        });
        dayTabs.append(btn);
      }

      const tools = document.createElement("div");
      tools.className = "wcv-today-tools";
      const icsBtn = createTextElement("button", "wcv-today-tool-btn is-export", ".ics時間割保存");
      icsBtn.type = "button";
      icsBtn.title = "現在の時間割をカレンダーアプリ(.ics)用に書き出します";
      icsBtn.addEventListener("click", () => downloadTimetableIcs(icsBtn));
      const collapseBtn = createTextElement(
        "button",
        "wcv-today-tool-btn",
        state.todayStripCollapsed ? "開く" : "閉じる"
      );
      collapseBtn.type = "button";
      collapseBtn.setAttribute("aria-expanded", String(!state.todayStripCollapsed));
      collapseBtn.addEventListener("click", () => {
        state.todayStripCollapsed = !state.todayStripCollapsed;
        ensureTodayTimetableStrip(form);
      });
      tools.append(icsBtn, collapseBtn);
      header.append(titleGroup, dayTabs, tools);
      strip.append(header);

      if (state.todayStripCollapsed) return;

      const list = document.createElement("div");
      list.className = "wcv-today-list";
      if (!dayEntries.length) {
        list.append(createTextElement("div", "wcv-today-empty", `${activeDay}曜日の時間割に登録された授業はありません。`));
        strip.append(list);
        return;
      }

      let markedNext = false;
      for (const entry of dayEntries) {
        const card = document.createElement("article");
        card.className = `wcv-today-card ${categoryClass(entry.course)}`;
        const bounds = nativePeriodBounds(entry.meeting, entry.period);
        const startMin = bounds ? timeStringToMinutes(bounds.start) : null;
        const endMin = bounds ? timeStringToMinutes(bounds.end) : null;
        let timingState = "";
        if (isViewingToday && startMin != null && endMin != null) {
          if (nowMinutes >= startMin && nowMinutes <= endMin) timingState = "current";
          else if (!markedNext && nowMinutes < startMin) {
            timingState = "next";
            markedNext = true;
          }
        }
        if (timingState === "current") card.classList.add("is-current-period");
        if (timingState === "next") card.classList.add("is-next-period");

        const top = document.createElement("div");
        top.className = "wcv-today-card-top";
        const timeText = bounds ? `${entry.period}限 ${bounds.start}〜${bounds.end}` : `${entry.period}限`;
        top.append(createTextElement("span", "wcv-today-period", timeText));
        if (timingState === "current") top.append(createTextElement("span", "wcv-today-live-badge is-now", "受講中"));
        else if (timingState === "next") top.append(createTextElement("span", "wcv-today-live-badge is-next", "次の授業"));
        else if (entry.correctionsCount > 0) {
          top.append(createTextElement("span", "wcv-today-live-badge is-correction", `訂正${entry.correctionsCount}`));
        }

        const link = createTextElement("a", "wcv-today-course-link", entry.course.courseName);
        if (entry.href) link.href = entry.href;

        const meta = createTextElement(
          "div",
          "wcv-today-card-meta",
          `${entry.room || "教室未定"} ・ ${entry.teacher || "担当未定"}`
        );
        card.append(top, link, meta);
        list.append(card);
      }
      strip.append(list);
    });
  }

  function applyCourseListFilter(form) {
    if (!form) return;
    const bar = document.getElementById("wcv-course-list-filters");
    const items = Array.from(form.querySelectorAll("ul.courseList > li"));
    if (!items.length) {
      bar?.remove();
      return;
    }
    const mode = state.courseListFilter || "all";
    const scheduleKeys = new Set(state.nativeDetectedCourses.keys());
    let visibleCount = 0;

    for (const item of items) {
      let show = true;
      if (mode === "active") {
        show = Boolean(
          item.querySelector(".course-new-message, .course-contents-info, .badge")
          || /新着|締切|未読/.test(item.textContent || "")
        );
      } else if (mode === "extra") {
        const anchor = item.querySelector("a[href*='/webclass/course.php/']");
        if (anchor) {
          const code = extractCourseCodes(`${anchor.href} ${anchor.textContent || ""}`)[0] || "";
          const match = code ? (state.codeIndex.get(code) || buildProvisionalFallCourse(code)) : null;
          const inTable = (code && scheduleKeys.has(code)) || (match && scheduleKeys.has(courseKey(match)));
          show = !inTable;
        }
      }
      item.classList.toggle("wcv-native-list-hidden", !show);
      if (show) visibleCount += 1;
    }

    if (bar) {
      const countEl = bar.querySelector(".wcv-course-list-filter-count");
      if (countEl) countEl.textContent = mode === "all" ? `全${items.length}件` : `${visibleCount} / ${items.length}件`;
      for (const btn of bar.querySelectorAll("button[data-filter]")) {
        const active = btn.dataset.filter === mode;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", String(active));
      }
    }
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

    const tree = form.querySelector(".courseTree");
    const hasListItems = Boolean(form.querySelector("ul.courseList > li"));
    if (tree && hasListItems && !document.getElementById("wcv-course-list-filters")) {
      withOwnMutation(() => {
        const bar = document.createElement("div");
        bar.id = "wcv-course-list-filters";
        bar.className = "wcv-course-list-filters wcv-root wcv-native-injected";
        bar.setAttribute("role", "group");
        bar.setAttribute("aria-label", "その他のコース絞り込み");
        for (const [key, label] of [
          ["all", "すべて"],
          ["active", "新着・課題あり"],
          ["extra", "時間割表外のみ"]
        ]) {
          const btn = createTextElement("button", "wcv-course-list-filter-btn", label);
          btn.type = "button";
          btn.dataset.filter = key;
          btn.addEventListener("click", () => {
            state.courseListFilter = key;
            applyCourseListFilter(form);
          });
          bar.append(btn);
        }
        bar.append(createTextElement("span", "wcv-course-list-filter-count", ""));
        tree.insertAdjacentElement("beforebegin", bar);
      });
    }
  }

  function isLoginEntrancePage() {
    if (document.querySelector("#schedule-table, .cm-contentsList, main#js-main")) return false;
    return Boolean(document.querySelector("#contentJapanese .showLoginButton, a.showLoginButton[onclick*='callSSOWebClass']"));
  }

  function enhanceLoginEntrancePage() {
    if (!isLoginEntrancePage()) return;
    addNativeClass(document.body, "wcv-native-login-page");
    for (const container of document.querySelectorAll("#contentJapanese, #contentEnglish")) {
      addNativeClass(container, "wcv-native-login-container");
      const buttons = container.querySelectorAll("a.showLoginButton");
      if (buttons[0]) addNativeClass(buttons[0], "wcv-native-login-btn-primary");
      if (buttons[1]) addNativeClass(buttons[1], "wcv-native-login-btn-secondary");
    }

    const jpContainer = document.querySelector("#contentJapanese");
    if (jpContainer && !document.getElementById("wcv-login-assistant")) {
      const assistant = document.createElement("aside");
      assistant.id = "wcv-login-assistant";
      assistant.className = "wcv-login-assistant wcv-root wcv-native-injected";
      assistant.setAttribute("aria-label", "WebClass授業情報 拡張機能の案内");
      const badge = createTextElement("div", "wcv-login-assistant-badge", "✓ WebClass 授業情報 拡張機能が待機中です");
      const desc = createTextElement(
        "p",
        "wcv-login-assistant-desc",
        "上の「TCUアカウントで利用」からログインすると、時間割の各科目に教室・担当教員・訂正表候補が自動で表示されます。"
      );
      const actions = document.createElement("div");
      actions.className = "wcv-login-assistant-actions";
      const searchBtn = createTextElement("button", "wcv-login-assistant-btn is-primary", "ログイン前に時間割・訂正表・後期PDFを検索");
      searchBtn.type = "button";
      searchBtn.addEventListener("click", () => openPanelAndFocusSearch("detected"));
      const corrBtn = createTextElement("button", "wcv-login-assistant-btn", `2026訂正表候補 (${state.correctionEvents.length}件)`);
      corrBtn.type = "button";
      corrBtn.addEventListener("click", () => openPanelAndFocusSearch("corrections"));
      const guideBtn = createTextElement("button", "wcv-login-assistant-btn", "2026公式履修要覧一覧");
      guideBtn.type = "button";
      guideBtn.addEventListener("click", () => openPanelAndFocusSearch("study-guides"));
      actions.append(searchBtn, corrBtn, guideBtn);
      assistant.append(badge, desc, actions);
      jpContainer.append(assistant);
    }
  }

  function updateNativeCourseCount() {
    const heading = document.querySelector("main#js-main h3.page-header");
    if (!heading || !/参加しているコース/.test(heading.textContent || "")) return;
    let tools = document.getElementById("wcv-native-heading-tools");
    if (!tools) {
      tools = document.createElement("span");
      tools.id = "wcv-native-heading-tools";
      tools.className = "wcv-native-heading-tools wcv-native-injected";
      const badge = createTextElement("span", "wcv-native-course-count wcv-native-injected", "");
      badge.id = UI_IDS.nativeCourseCount;
      tools.append(badge);
      heading.append(tools);
    }
    const badge = document.getElementById(UI_IDS.nativeCourseCount);
    const scheduleCodes = uniqueBy(Array.from(document.querySelectorAll("#schedule-table a[href*='/webclass/course.php/']"))
      .flatMap((anchor) => extractCourseCodes(`${anchor.href} ${anchor.textContent || ""}`))
      .filter((code) => state.codeIndex.has(code)));
    const nextText = `${scheduleCodes.length}科目`;
    if (badge && badge.textContent !== nextText) badge.textContent = nextText;
  }

  function readEnrollment(form) {
    const year = Number(form.elements.year?.value);
    const term = form.elements.semester?.value;
    const courses = [];
    const seen = new Set();
    for (const anchor of form.querySelectorAll("#schedule-table a[href*='/webclass/course.php/'], .schedule-list a[href*='/webclass/course.php/']")) {
      const url = new URL(anchor.href);
      if (url.origin !== location.origin) continue;
      const match = /^\/webclass\/course\.php\/([a-z0-9]+)\//i.exec(url.pathname);
      if (!match) continue;
      const identity = match[1].toLowerCase();
      if (seen.has(identity)) continue;
      seen.add(identity);
      const code = /^(?:(\d{2}))?([a-z]{3,4}\d{4,6})$/.exec(identity);
      const exact = code && (!code[1] || Number(code[1]) === year % 100) ? code[2] : null;
      const original = state.nativeOriginals.get(anchor)?.children || [...anchor.childNodes];
      const name = original.filter((node) => !(node instanceof Element) ||
        !node.matches(".course-new-message, .course-contents-info, .badge, .list-group-item-text, .wcv-root"))
        .map((node) => node.textContent).join(" ")
        .trim().replace(/\s+/g, " ").slice(0, 160) || "授業名なし";
      courses.push({ code: exact, name });
    }
    return { year, term, courses };
  }

  let inlineEnrollmentIndex;
  let inlineEvidence;
  async function updateEnrollmentSummary(form, output) {
    const snapshot = readEnrollment(form);
    const signature = JSON.stringify(snapshot);
    // Keep registration names in the isolated script, outside the page DOM.
    if (output._wcvSignature === signature) return;
    output._wcvSignature = signature;
    const current = snapshot.year === state.dataset?.dataset?.academicYear;
    if (inlineEnrollmentIndex?.year !== snapshot.year) {
      const rows = current ? state.dataset.courses : state.historicalEvidence.filter(r => r.academicYear === snapshot.year);
      inlineEnrollmentIndex = { year: snapshot.year, index: WCV_ENROLLMENT_MATCH.createIndex(rows) };
    }
    const index = inlineEnrollmentIndex.index;
    try {
      inlineEvidence ??= fetch(chrome.runtime.getURL("data/syllabus-credit-evidence.json"))
        .then(r => { if (!r.ok) throw new Error(); return r.json(); })
        .catch(error => { inlineEvidence = null; throw error; });
      const evidence = await inlineEvidence;
      if (output._wcvSignature !== signature || !output.isConnected) return;
      const codes = new Set(snapshot.courses.map(row => row.code).filter(Boolean));
      let matched = 0, verified = 0, units = 0;
      for (const row of snapshot.courses) {
        const {course} = WCV_ENROLLMENT_MATCH.identify(row, index, snapshot.term, snapshot.year, current);
        if (!course || (!row.code && codes.has(course.courseCode))) continue;
        codes.add(course.courseCode);
        matched++;
        const records = evidence.records.filter(record => WCV_ENROLLMENT_MATCH.validEvidence(record,
          snapshot.year, course.courseCode, [course.courseName, ...(course.aliases || [])],
          WCV_ENROLLMENT_MATCH.semesterFor(snapshot.term, course)));
        if (records.length && records.every(record => record.units === records[0].units)) {
          units += records[0].units;
          verified++;
        }
      }
      const pending = snapshot.courses.length - matched;
      const details = output.parentElement.querySelector("button");
      details.textContent = pending ? "要確認の科目を見る（履修・進級チェック）" : "履修・進級チェック";
      output.replaceChildren(
        createTextElement("span", "wcv-enrollment-scope", snapshot.year + "年度・" + (WCV_ENROLLMENT_MATCH.terms[snapshot.term] || "表示中の学期") + "・参加コース " + snapshot.courses.length + "件"),
        createTextElement("strong", "", "授業データと一致 " + matched + "件"),
        createTextElement("strong", "", "要確認 " + pending + "件"),
        createTextElement("span", "wcv-enrollment-units", verified
          ? "シラバスで確認済みの単位数：" + verified + "件で計" + units / 100 + "単位"
          : "単位数：同梱資料では未確認")
      );
    } catch {
      output._wcvSignature = null;
      output.textContent = "自動照合のデータを読み込めませんでした。";
    }
  }

  function ensureLearningTools(form) {
    if (form.name !== "condition" || !form.querySelector("#schedule-table, .schedule-list")) return;
    const existing = document.getElementById("wcv-learning-tools");
    if (existing) {
      updateEnrollmentSummary(form, existing.querySelector(".wcv-enrollment-summary"));
      existing.querySelector("#wcv-native-open-search").hidden = !state.settings.showFloatingPanel;
      return;
    }
    const nav = document.createElement("nav");
    nav.id = "wcv-learning-tools";
    nav.className = "wcv-learning-tools wcv-root wcv-native-injected";
    nav.setAttribute("aria-labelledby", "wcv-learning-title");
    const title = createTextElement("h4", "", "履修・学習ツール");
    title.id = "wcv-learning-title";
    const review = document.createElement("div");
    review.className = "wcv-enrollment-review";
    const actions = document.createElement("div");
    actions.className = "wcv-learning-actions";
    const status = createTextElement("p", "wcv-learning-status", "");
    status.setAttribute("role", "status");
    for (const [section, label] of [
      ["plan", "時間割プランナー"], ["credits", "単位の確認"],
      ["requirements", "卒業要件"], ["graduate", "大学院の修了要件"], ["tasks", "課題メモ"],
      ["enrollment", "履修・進級チェック"]
    ]) {
      const control = createTextElement("button", "", label);
      control.type = "button";
      control.addEventListener("click", async () => {
        control.disabled = true;
        status.textContent = "";
        try {
          const result = await chrome.runtime.sendMessage({
            type: "wcv-open-planner", section, snapshot: section === "enrollment" ? readEnrollment(form) : undefined
          });
          if (!result?.opened) throw new Error("Planner did not open");
        } catch {
          status.textContent = "ツールを開けませんでした。WebClassのタブを更新してお試しください。";
        } finally {
          control.disabled = false;
        }
      });
      if (section === "enrollment") review.append(control);
      else actions.append(control);
    }
    const search = createTextElement("button", "", "授業・過年度を検索");
    search.id = "wcv-native-open-search";
    search.type = "button";
    search.hidden = !state.settings.showFloatingPanel;
    search.addEventListener("click", () => openPanelAndFocusSearch("", search));
    const deadlines = createTextElement("button", "", "WebClassの締切");
    deadlines.type = "button";
    deadlines.className = "wcv-learning-deadlines";
    deadlines.addEventListener("click", focusDeadlinePanel);
    actions.append(search, deadlines);
    const summary = createTextElement("p", "wcv-enrollment-summary", "登録科目を自動照合中…");
    review.prepend(summary);
    nav.append(title, review, actions, status);
    form.before(nav);
    updateEnrollmentSummary(form, summary);
  }

  function focusDeadlinePanel() {
    const panel = document.getElementById("wcv-deadlines");
    if (!panel) return false;
    panel.focus({ preventScroll: true });
    panel.scrollIntoView({ block: "center" });
    return true;
  }

  function ensurePastCoursePicker(form) {
    const id = "wcv-past-course-picker";
    if (document.getElementById(id) || form.name !== "condition") return;
    const year = form.querySelector('select[name="year"]');
    const semester = form.querySelector('select[name="semester"]');
    const admission = state.settings.webclassAdmissionYear || /^(20\d{2})-/.exec(state.settings.curriculumPlan || "")?.[1];
    if (!year || !semester || !admission || !Array.from(semester.options).some((option) => option.value === "all")) return;
    const { year: calendarYear, month } = jstNowParts();
    const currentYear = month >= 4 ? calendarYear : calendarYear - 1;
    const pastYears = Array.from(year.options, (option) => option.value)
      .filter((value) => /^20\d{2}$/.test(value) && Number(value) >= Number(admission) && Number(value) < currentYear)
      .sort((left, right) => Number(right) - Number(left));
    if (!pastYears.length) return;

    const row = document.createElement("div");
    row.className = "wcv-past-course-picker wcv-root wcv-native-injected";
    row.id = id;
    const label = createTextElement("label", "", "過年度の参加コース");
    const picker = document.createElement("select");
    picker.id = "wcv-past-course-year";
    label.htmlFor = picker.id;
    for (const value of pastYears) picker.append(new Option(`${value}年度`, value));
    if (pastYears.includes(year.value)) picker.value = year.value;
    const open = createTextElement("button", "", "全学期を表示");
    open.type = "button";
    open.addEventListener("click", () => {
      year.value = picker.value;
      semester.value = "all";
      form.requestSubmit();
    });
    row.append(label, picker, open);
    year.parentElement.after(row);
  }

  function enhanceNativeWebClassLayout() {
    if (!state.settings.modernizeNativeLayout) {
      restoreNativeEnhancements();
      return;
    }
    if (isLoginEntrancePage()) {
      enhanceLoginEntrancePage();
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
      ensureLearningTools(form);
      addNativeClass(form, "wcv-native-course-form");
      const directHeadings = Array.from(form.children).filter((element) => element.tagName === "H4");
      if (directHeadings[0]) addNativeClass(directHeadings[0], "wcv-native-semester-heading");
      if (directHeadings[1]) {
        addNativeClass(directHeadings[1], "wcv-native-timetable-heading");
        if (!directHeadings[1].querySelector(".wcv-native-inline-legend")) {
          const inlineLegend = document.createElement("span");
          inlineLegend.className = "wcv-native-inline-legend wcv-native-injected";
          inlineLegend.setAttribute("aria-label", "授業カテゴリ色分け凡例");
          for (const [className, label] of [
            ["wcv-category-specialist", "専門科目"],
            ["wcv-category-foundation", "基礎科目"],
            ["wcv-category-exercise", "実験・演習"],
            ["wcv-category-information", "情報・通信"]
          ]) {
            inlineLegend.append(createTextElement("span", `wcv-native-legend-pill ${className}`, label));
          }
          directHeadings[1].append(inlineLegend);
        }
      }
      const selectWrap = directHeadings[0]?.nextElementSibling;
      if (selectWrap) addNativeClass(selectWrap, "wcv-native-semester-controls");
      const tableViewport = form.querySelector("#schedule-table")?.closest(".table-responsive");
      const addCourse = tableViewport?.nextElementSibling?.nextElementSibling || tableViewport?.nextElementSibling;
      if (addCourse && /コースを追加/.test(addCourse.textContent || "")) addNativeClass(addCourse, "wcv-native-add-course");
      enhanceNativeCourseListArea(form);
      ensurePastCoursePicker(form);
    }
    state.nativeScheduleEntries = [];
    ensureSidebarTools(sidebar);
    enhanceNativeScheduleTable();
    enhanceNativeMobileSchedule();
    ensureTodayTimetableStrip(form);
    applyCourseListFilter(form);
    updateNativeCourseCount();
  }

  function isLikelyTimetablePage() {
    if (nativeTimetable()) return true;
    return state.detectedCourses.size >= 3 && /webclass/i.test(document.title || "");
  }

  function categoryClass(course) {
    const category = course?.category || "";
    if (category.includes("実験") || category.includes("演習")) return "wcv-category-exercise";
    if (category.includes("基礎")) return "wcv-category-foundation";
    if (category.includes("情報") || category.includes("通信")) return "wcv-category-information";
    return "wcv-category-specialist";
  }

  function webclassCourseUrl(element) {
    if (!(element instanceof Element)) return "";
    const anchor = element.matches("a[href*='course.php']") ? element : element.closest("a[href*='course.php']");
    if (!anchor) return "";
    try {
      const url = new URL(anchor.getAttribute("href") || "", location.href);
      return url.origin === location.origin && /\/webclass\/course\.php\/[^/]+\//.test(url.pathname) ? url.href : "";
    } catch { return ""; }
  }

  function createTimetableCourseTitle(course, className) {
    const title = createTextElement("h4", className, "");
    if (!course?.webclassUrl) {
      title.textContent = course?.courseName || "";
      return title;
    }
    const link = createTextElement("a", "wcv-course-page-link", course.courseName);
    link.href = course.webclassUrl;
    title.append(link);
    return title;
  }

  function createTimetableCourseCard(course, meeting) {
    const card = document.createElement("article");
    card.className = `wcv-timetable-course-card ${categoryClass(course)}${course.ambiguous ? " wcv-timetable-ambiguous" : ""}`;
    card.dataset.courseCode = course.courseCode || courseKey(course);
    card.setAttribute("aria-label", `${course.courseName}、${meetingLabel(meeting, true)}、担当 ${instructorLabel(course, 4)}`);
    const title = createTimetableCourseTitle(course, "wcv-timetable-course-title");
    const category = createTextElement("span", "wcv-timetable-category", course.ambiguous ? `${course.candidateCount}候補` : (course.category || "授業"));
    const meta = document.createElement("div");
    meta.className = "wcv-timetable-course-meta";
    meta.append(
      createTextElement("div", "wcv-timetable-room", `教室  ${roomForMeeting(meeting)}`),
      createTextElement("div", "wcv-timetable-teacher", `担当  ${course.broadAmbiguous ? "要特定" : instructorLabel(course, 2)}`)
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
    item.dataset.courseCode = course.courseCode || courseKey(course);
    const metaText = course.unlisted
      ? `時間割データ未収録 / WebClass登録コース${course.campuses?.length ? ` / ${campusesLabel(course)}` : ""}`
      : `${meetingsLabel(course)} / 担当 ${instructorLabel(course, 2)} / ${campusesLabel(course)}`;
    item.append(
      createTimetableCourseTitle(course, "wcv-irregular-title"),
      createTextElement("div", "wcv-irregular-meta", metaText)
    );
    return item;
  }

  function validMeeting(meeting) {
    const period = Number(meeting?.period);
    return DAYS.includes(meeting?.day) && Number.isInteger(period) && period >= 1 && period <= 9;
  }

  function standardPeriods(courses = []) {
    const profile = state.dataset?.dataset?.periodProfiles?.standard?.periods || {};
    const maxCoursePeriod = Math.max(5, ...courses.flatMap((course) => (course?.meetings || []).filter(validMeeting).map((meeting) => Number(meeting.period))));
    return Array.from({ length: Math.min(9, maxCoursePeriod) }, (_, index) => index + 1).map((period) => ({
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
      createTextElement("div", "wcv-enhanced-eyebrow", "学生制作・非公式"),
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

    const regularCourses = courses.filter((course) => (course.meetings || []).some(validMeeting));
    const irregularCourses = courses.filter((course) => !(course.meetings || []).some(validMeeting));
    const hasSunday = regularCourses.some((course) => (course.meetings || []).some((meeting) => validMeeting(meeting) && meeting.day === "日"));
    const days = hasSunday ? DAYS : DAYS.slice(0, 6);
    const periods = standardPeriods(regularCourses);
    const viewport = document.createElement("div");
    viewport.className = "wcv-enhanced-grid-viewport";
    const grid = document.createElement("div");
    grid.className = "wcv-enhanced-grid";
    grid.style.setProperty("--wcv-day-count", String(days.length));
    grid.style.gridTemplateRows = `40px repeat(${periods.length}, minmax(116px, auto))`;
    grid.append(createTextElement("div", "wcv-grid-corner", ""));
    for (const day of days) grid.append(createTextElement("div", "wcv-grid-day", `${day}曜日`));

    const slotMap = new Map();
    for (const course of regularCourses) {
      for (const meeting of (course.meetings || []).filter(validMeeting)) {
        const key = `${meeting.day}-${Number(meeting.period)}`;
        if (!slotMap.has(key)) slotMap.set(key, []);
        slotMap.get(key).push({ course, meeting: { ...meeting, period: Number(meeting.period) } });
      }
    }

    for (const periodInfo of periods) {
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

  function findTimetableContainer() {
    const schedule = document.querySelector("table#schedule-table, table.schedule-table");
    const scheduleColumn = schedule?.closest(".col-sm-9");
    if (scheduleColumn instanceof HTMLElement) {
      scheduleColumn.classList.add("wcv-home-timetable-column");
      return scheduleColumn;
    }
    return findSafeMainContainer();
  }

  function injectEnhancedTimetable() {
    const existing = document.getElementById(UI_IDS.enhancedTimetable);
    const courses = [...state.detectedCourses.values()];
    // WebClass本来の時間割グリッド（#schedule-table thead th）がある場合は「参加しているコース」へ完全統合するため別表示しない
    const shouldShow = state.settings.showEnhancedTimetable && !hasNativeScheduleGrid() && courses.length >= 1 && isLikelyTimetablePage();
    if (!shouldShow) {
      existing?.remove();
      return;
    }
    const signature = JSON.stringify(courses);
    if (existing?.dataset.signature === signature) return;
    existing?.remove();
    withOwnMutation(() => {
      const timetable = createEnhancedTimetable(courses);
      timetable.dataset.signature = signature;
      const container = findTimetableContainer();
      if (container === document.body) document.body.insertBefore(timetable, document.body.firstElementChild);
      else container.prepend(timetable);
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
        createTextElement("span", "", "時間割の各科目に教室・担当教員を追加しました。科目カードをクリックするとそのままコースが開きます。"),
        createTextElement("span", "wcv-welcome-sub", "授業・過年度の検索や履修案づくりは「履修・学習ツール」から開けます。")
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
      globalThis.WCV_DEADLINES?.sync(state.settings);
      document.getElementById("wcv-welcome-banner")?.remove();
      return;
    }
    applyRestyle(state.settings.restyle);
    if (isCourseContentPage()) {
      state.detectedCourses = new Map();
      state.currentCourse = null;
      removeInjectedUi();
      globalThis.WCV_DEADLINES?.sync(state.settings);
      document.getElementById("wcv-welcome-banner")?.remove();
    } else {
      globalThis.WCV_DEADLINES?.sync(state.settings);
      enhanceNativeWebClassLayout();
      if (state.settings.showInlineMetadata || !hasNativeScheduleGrid()) scanCourseElements();
      else {
        clearInlineMetadata();
        state.detectedCourses = new Map(state.nativeDetectedCourses);
      }
      injectEnhancedTimetable();
      state.currentCourse = findCurrentCourse();
      injectCurrentCourseCard(state.currentCourse);
      ensureFloatingPanel();
      ensureWelcomeBanner();
    }
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
      const relevant = mutations.some((mutation) => {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        if (target?.closest(".wcv-root, .wcv-native-injected, .wcv-native-course-card, .wcv-native-period-cell")) return false;
        if (mutation.type === "characterData" || mutation.type === "attributes") return true;
        return [...mutation.addedNodes, ...mutation.removedNodes].some((node) =>
          !(node instanceof Element && (node.closest(".wcv-root, .wcv-native-injected") || node.classList.contains("wcv-native-injected")))
        );
      });
      if (relevant) scheduleScan(220);
    });
    state.observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ["href", "data-course-code", "data-course-name", "title"]
    });
  }

  async function loadDataset() {
    if (globalThis.WCV_DATA?.load) return globalThis.WCV_DATA.load();
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
      return {
        summary: {},
        database: {},
        records: [],
        currentFallCandidates: { summary: {}, records: [], sources: [] },
        correctionEvents: { summary: {}, records: [], sources: [] },
        studyGuideNavigation: { summary: {}, guides: [], curriculumTables: [] }
      };
    }
  }

  async function initialize() {
    try {
      const [dataset, historicalData, stored, curriculum] = await Promise.all([
        loadDataset(), loadHistoricalCourseData(), storageGet(DEFAULT_SETTINGS),
        fetch(chrome.runtime.getURL("data/curriculum-candidates.json")).then(r => r.ok ? r.json() : null).catch(() => null)
      ]);
      state.dataset = dataset;
      state.curriculumCandidates = curriculum;
      state.officialCourseCodes = new Set((dataset.courses || []).map((course) => normalizeCode(course.courseCode)).filter(Boolean));
      state.historicalEvidence = historicalData.records || [];
      state.historicalDataSummary = historicalData.summary || {};
      state.currentFallEvidence = historicalData.currentFallCandidates?.records || [];
      state.currentFallSummary = historicalData.currentFallCandidates?.summary || {};
      state.correctionEvents = historicalData.correctionEvents?.records || [];
      state.correctionSummary = historicalData.correctionEvents?.summary || {};
      state.studyGuideNavigation = historicalData.studyGuideNavigation || null;
      state.databaseStatus = historicalData.database || {};
      state.settings = { ...DEFAULT_SETTINGS, ...stored };
      state.courses = mergeCourses(dataset.courses || [], state.settings.userCourses || []);
      rebuildIndexes();
      runScan();
      startObserver();

      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") return;
        let needsRebuild = false;
        let needsScan = false;
        for (const [key, change] of Object.entries(changes)) {
          if (key in DEFAULT_SETTINGS) {
            state.settings[key] = change.newValue ?? DEFAULT_SETTINGS[key];
            if (key === "webclassAdmissionYear") document.getElementById("wcv-past-course-picker")?.remove();
            if (key !== "appearance") needsScan = true;
            if (["userCourses", "curriculumPlan", "curriculumTeaching", "curriculumHirameki"].includes(key)) needsRebuild = true;
          }
        }
        if (needsRebuild) {
          state.courses = mergeCourses(state.dataset?.courses || [], state.settings.userCourses || []);
          rebuildIndexes();
          removeInjectedUi();
        }
        if (changes.appearance) applyAppearance();
        if (needsScan) scheduleScan(50);
      });

      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type === "wcv-read-enrollment" && _sender.url?.startsWith(chrome.runtime.getURL("src/planner.html"))) {
          const form = document.forms.condition;
          sendResponse(state.settings.enabled && form?.querySelector("#schedule-table, .schedule-list") ? readEnrollment(form) : null);
          return;
        }
        if (message?.type === "wcv-open-page-tool") {
          if (!state.settings.enabled || !document.getElementById("wcv-learning-tools")) {
            sendResponse({ opened: false });
          } else if (message.tool === "enrollment") {
            chrome.runtime.sendMessage({
              type: "wcv-open-planner", section: "enrollment", snapshot: readEnrollment(document.forms.condition)
            }).then(sendResponse, () => sendResponse({ opened: false }));
            return true;
          } else if (message.tool === "search") {
            openPanelAndFocusSearch();
            sendResponse({ opened: Boolean(document.querySelector("#wcv-panel .wcv-panel-search-input")) });
          } else {
            sendResponse({ opened: message.tool === "deadlines" && focusDeadlinePanel() });
          }
          return;
        }
        if (message?.type === "wcv-get-status") {
          const scope = state.dataset?.dataset?.scope || {};
          const pageTools = [];
          if (document.getElementById("wcv-learning-tools")) {
            pageTools.push("enrollment");
            if (state.settings.showFloatingPanel) pageTools.push("search");
            if (document.getElementById("wcv-deadlines")) pageTools.push("deadlines");
          }
          sendResponse({
            ready: true,
            enabled: state.settings.enabled,
            isLoginPage: isLoginEntrancePage(),
            pageTools,
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
            currentFallGroupedRows: state.currentFallSummary?.groupedRows || 0,
            currentFallOccurrences: state.currentFallSummary?.sourceOccurrences || 0,
            currentFallReviewedOccurrences: state.currentFallSummary?.visuallyReviewedOccurrences || 0,
            currentFallUnmatchedPairs: state.currentFallSummary?.baseSnapshotUnmatchedPairs || 0,
            correctionEventCount: state.correctionSummary?.eventCount || 0,
            studyGuideCount: state.studyGuideNavigation?.summary?.studyGuideCount || 0,
            studyGuidePageCount: state.studyGuideNavigation?.summary?.totalStudyGuidePages || 0,
            studyGuideIndexedTerms: state.studyGuideNavigation?.summary?.indexedTermPagePairs || 0,
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
