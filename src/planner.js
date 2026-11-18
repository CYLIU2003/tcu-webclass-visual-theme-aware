(() => {
  "use strict";

  const days = ["月", "火", "水", "木", "金", "土"];
  const periods = [1, 2, 3, 4, 5];
  const quartersByTerm = {
    前期前: [0], 前期後: [1], 後期前: [2], 後期後: [3],
    前期: [0, 1], 後期: [2, 3], 通年: [0, 1, 2, 3],
    前集中: [0, 1], 後集中: [2, 3]
  };
  const batchSize = 25;
  const $ = (id) => document.getElementById(id);
  const saved = new Set();
  let catalog = new Map();
  let storagePrefix;
  let slot = null;
  let limit = batchSize;

  function element(tag, text) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  }

  function button(label, action) {
    const node = element("button", label);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }

  function normalize(text) {
    return text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  }

  function makeEntry(course) {
    const slotsByQuarter = Array.from({ length: 4 }, () => new Set());
    for (const meeting of course.meetings || []) {
      if (!days.includes(meeting.day) || !periods.includes(meeting.period)) continue;
      for (const quarter of quartersByTerm[meeting.termBlock] || []) {
        slotsByQuarter[quarter].add(`${meeting.day}${meeting.period}`);
      }
    }
    const terms = (course.termBlocks || []).flatMap((term) => quartersByTerm[term] || []);
    const quarterSet = new Set(terms);
    slotsByQuarter.forEach((slots, index) => { if (slots.size) quarterSet.add(index); });
    return {
      course,
      slotsByQuarter,
      quarterSet,
      searchable: [course.courseName, course.courseCode, ...(course.instructors || [])].map(normalize)
    };
  }

  function quarter() {
    return Number($("quarter").value);
  }

  function focusSearch() {
    if (matchMedia("(max-width: 840px)").matches) {
      $("query").focus({ preventScroll: true });
      $("search-title").closest("section").scrollIntoView({ block: "start" });
    } else {
      $("query").focus();
    }
  }

  function syncNavigation() {
    const hash = location.hash || "#plan-title";
    const links = document.querySelectorAll(".planner-nav a");
    for (const link of links) {
      if (link.hash === hash) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
    if (!location.hash || ![...links].some((link) => link.hash === hash)) return;
    if (hash === "#query") {
      focusSearch();
      return;
    }
    const heading = $(hash.slice(1));
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: "start" });
  }

  function renderPlan() {
    const current = quarter();
    const registered = [...saved].map((code) => catalog.get(code));
    const selected = registered.filter(Boolean);
    const inQuarter = selected.filter((entry) => entry.quarterSet.has(current));
    const scheduled = new Map();
    for (const entry of inQuarter) {
      for (const key of entry.slotsByQuarter[current]) {
        if (!scheduled.has(key)) scheduled.set(key, []);
        scheduled.get(key).push(entry.course);
      }
    }
    const conflicts = [...scheduled].filter(([, courses]) => courses.length > 1);
    const unplaced = inQuarter.filter((entry) => !entry.slotsByQuarter[current].size).length;
    $("plan-count").textContent = `このQの候補 ${inQuarter.length}件 · コマを特定できない候補 ${unplaced}件`;
    $("plan-status").textContent = conflicts.length
      ? `同じ曜日・時限に複数の授業が入っています（${conflicts.map(([key]) => `${key[0]}曜${key.slice(1)}限`).join("、")}）。`
      : "";
    $("plan-status").classList.toggle("conflict", Boolean(conflicts.length));

    const heading = element("tr");
    for (const title of ["時限", ...days.map((day) => `${day}曜`)]) {
      const th = element("th", title);
      th.scope = "col";
      heading.append(th);
    }
    const head = element("thead");
    head.append(heading);
    const body = element("tbody");
    for (const period of periods) {
      const row = element("tr");
      const periodLabel = element("th", `${period}限`);
      periodLabel.scope = "row";
      row.append(periodLabel);
      for (const day of days) {
        const key = `${day}${period}`;
        const courses = scheduled.get(key) || [];
        const cell = element("td");
        const findCourse = button(courses.length ? "候補を探す" : "＋", () => {
          slot = { key, label: `${day}曜${period}限` };
          $("query").value = "";
          renderResults(true);
          $("timetable").querySelector("[aria-pressed=true]")?.setAttribute("aria-pressed", "false");
          findCourse.setAttribute("aria-pressed", "true");
          focusSearch();
        });
        findCourse.dataset.slot = key;
        if (!courses.length) findCourse.dataset.empty = "";
        findCourse.setAttribute("aria-label", `${day}曜${period}限の授業を探す`);
        findCourse.setAttribute("aria-pressed", String(slot?.key === key));
        cell.append(findCourse);
        if (courses.length > 1) {
          const warning = element("strong", "重複候補");
          warning.className = "conflict";
          cell.append(warning);
        }
        for (const course of courses) {
          const name = element("span", `${course.courseName}（${course.courseCode}）`);
          name.className = "cell-course";
          cell.append(name);
        }
        row.append(cell);
      }
      body.append(row);
    }
    $("timetable").replaceChildren(head, body);
    const list = $("selected");
    list.replaceChildren();
    for (const code of saved) {
      const entry = catalog.get(code);
      const item = entry ? courseRow(entry) : element("li", `${code}（現在のデータに見つかりません）`);
      item.append(courseButton(code, false));
      list.append(item);
    }
    if (!saved.size) list.append(element("li", "追加した授業がここに表示されます。"));
  }

  function courseRow({ course, slotsByQuarter }) {
    const item = element("li");
    const title = element("strong", course.courseName);
    title.className = "course-title";
    const knownSlots = slotsByQuarter[quarter()];
    const rooms = new Set((course.meetings || [])
      .filter((meeting) => knownSlots.has(`${meeting.day}${meeting.period}`)
        && quartersByTerm[meeting.termBlock]?.includes(quarter()))
      .flatMap((meeting) => meeting.rooms?.length ? meeting.rooms : [meeting.room])
      .filter(Boolean));
    const meta = [
      course.courseCode, course.level, ...(course.instructors || []), ...(course.campuses || []),
      (course.termBlocks || []).join("・"),
      [...knownSlots].map((key) => `${key[0]}曜${key.slice(1)}限`).join("・"),
      rooms.size ? `教室 ${[...rooms].join("・")}` : ""
    ];
    const info = element("span");
    info.className = "course-info";
    for (const value of meta.filter(Boolean)) {
      info.append(element("span", value));
    }
    item.append(title, info);
    if (course.source?.url?.startsWith("https://www.asc.tcu.ac.jp/")) {
      const source = element("a", "時間割PDF");
      const page = course.source.pages?.[0];
      source.href = Number.isInteger(page) ? `${course.source.url}#page=${page}` : course.source.url;
      source.target = "_blank";
      source.rel = "noopener noreferrer";
      item.append(source);
    }
    return item;
  }

  function courseButton(code, add) {
    const name = catalog.get(code)?.course.courseName || code;
    const control = button(add ? "追加" : "外す", async () => {
      control.disabled = true;
      try {
        const key = storagePrefix + code;
        if (add) await chrome.storage.local.set({ [key]: true });
        else await chrome.storage.local.remove(key);
        $("edit-status").textContent = `${name}（${code}）を${add ? "追加しました" : "外しました"}。`;
        if (document.activeElement === document.body) $(add ? "query" : "plan-title").focus();
      } catch {
        control.disabled = false;
        $("edit-status").textContent = "保存できませんでした。もう一度お試しください。";
        control.focus();
      }
    });
    control.dataset.courseCode = code;
    control.setAttribute("aria-label", `${name}（${code}）を${add ? "追加" : "外す"}`);
    return control;
  }

  function renderResults(resetLimit = false) {
    if (resetLimit) limit = batchSize;
    const query = normalize($("query").value);
    const campus = $("campus").value;
    const level = $("course-level").value;
    const matches = [...catalog.values()].filter((entry) => entry.quarterSet.has(quarter())
      && (!slot || entry.slotsByQuarter[quarter()].has(slot.key))
      && (!level || entry.course.level === level)
      && (!campus || entry.course.campuses?.includes(campus))
      && (!query || entry.searchable.some((text) => text.includes(query))));
    $("search-scope").textContent = slot ? `${slot.label}の候補` : "選択中のQの候補";
    $("clear-slot").hidden = !slot;
    $("back-to-timetable").hidden = !slot;
    $("search-status").textContent = matches.length ? `${matches.length}件中 ${Math.min(limit, matches.length)}件を表示` : "該当する授業がありません。";
    $("more").hidden = matches.length <= limit;
    $("results").replaceChildren(...matches.slice(0, limit).map((entry) => {
      const item = courseRow(entry);
      const code = entry.course.courseCode;
      if (saved.has(code)) item.append(element("span", "追加済み"));
      else item.append(courseButton(code, true));
      return item;
    }));
  }

  async function initialize() {
    try {
      const data = await WCV_DATA.load();
      if (!Array.isArray(data.courses) || data.dataset?.academicYear !== 2026) throw new Error("Unexpected timetable");
      catalog = new Map(data.courses.map((course) => [course.courseCode, makeEntry(course)]));
      const campuses = new Set(data.courses.flatMap((course) => course.campuses || []));
      for (const campus of [...campuses].sort((a, b) => a.localeCompare(b, "ja"))) {
        $("campus").append(new Option(campus, campus));
      }
      storagePrefix = `planner:${data.dataset.academicYear}:`;
      const stored = await chrome.storage.local.get(null);
      for (const [key, value] of Object.entries(stored)) {
        if (key.startsWith(storagePrefix) && value === true) saved.add(key.slice(storagePrefix.length));
      }
      WCV_PLANNER_CREDITS.initialize(stored, storagePrefix, (code) => catalog.get(code)?.course);
      WCV_PLANNER_TASKS.initialize(stored, storagePrefix, (code) => catalog.get(code)?.course);
      await Promise.all([
        WCV_PLANNER_GRADUATE.initialize(),
        WCV_PLANNER_PROGRAMS.initialize(stored),
        WCV_PLANNER_GUIDES.initialize(storagePrefix, (code) => catalog.get(code)?.course),
        WCV_PLANNER_ENROLLMENT.initialize(stored, data.dataset.academicYear, data.courses),
      ]);
      chrome.storage.onChanged.addListener((changes, area) => {
        const updates = Object.entries(changes).filter(([key]) => key.startsWith(storagePrefix));
        if (area !== "local" || !updates.length) return;
        const active = document.activeElement;
        for (const [key, change] of updates) {
          const code = key.slice(storagePrefix.length);
          if (change.newValue === true) saved.add(code);
          else saved.delete(code);
        }
        renderPlan();
        renderResults();
        if (active && !active.isConnected) {
          const sameControl = active.dataset.courseCode
            ? document.querySelector(`[data-course-code="${CSS.escape(active.dataset.courseCode)}"]`)
            : document.querySelector(`[data-slot="${CSS.escape(active.dataset.slot || "")}"]`);
          (sameControl || $("query")).focus();
        }
      });
      $("query").addEventListener("input", () => renderResults(true));
      window.addEventListener("hashchange", syncNavigation);
      const navigation = document.querySelector(".planner-nav");
      new ResizeObserver(() => {
        document.documentElement.style.setProperty("--planner-nav-offset", `${navigation.offsetHeight + 12}px`);
      }).observe(navigation);
      navigation.addEventListener("click", (event) => {
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        if (event.target.closest("a")?.hash !== location.hash) return;
        event.preventDefault();
        syncNavigation();
      });
      $("campus").addEventListener("change", () => renderResults(true));
      $("course-level").addEventListener("change", () => renderResults(true));
      $("back-to-timetable").addEventListener("click", () => {
        $("timetable").querySelector('[aria-pressed="true"]')?.focus();
      });
      $("quarter").addEventListener("change", () => {
        slot = null;
        renderPlan();
        renderResults(true);
      });
      $("clear-slot").addEventListener("click", () => {
        slot = null;
        $("timetable").querySelector("[aria-pressed=true]")?.setAttribute("aria-pressed", "false");
        renderResults(true);
        $("query").focus();
      });
      $("more").addEventListener("click", () => {
        const previousLimit = limit;
        limit += batchSize;
        renderResults();
        $("results").children[previousLimit]?.querySelector("button")?.focus();
        if ($("more").hidden && document.activeElement === document.body) $("query").focus();
      });
      renderPlan();
      renderResults();
      $("workspace").hidden = false;
      $("loading").hidden = true;
      document.documentElement.style.setProperty("--planner-nav-offset", `${navigation.offsetHeight + 12}px`);
      syncNavigation();
    } catch {
      $("loading").textContent = "時間割や保存済みデータを読み込めませんでした。このページを再読み込みしてください。";
    }
  }

  initialize();
})();
