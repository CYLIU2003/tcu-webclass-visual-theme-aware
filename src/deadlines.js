(() => {
  "use strict";

  const PANEL_ID = "wcv-deadlines";
  const DAY = 86400000;
  const JST = 9 * 3600000;
  const state = { signature: "", courses: new Map(), tasks: [], observations: [], covered: new Set(), pending: new Set(), missingDates: 0, loading: false, error: "", updatedAt: null, frame: null, cancelLoad: null, timer: null };

  function courseId(href, baseUrl) {
    try {
      const url = new URL(href, baseUrl);
      if (url.origin !== new URL(baseUrl).origin) return "";
      return url.pathname.match(/^\/webclass\/course\.php\/([^/]+)(?:\/|$)/)?.[1]?.toLowerCase() || "";
    } catch { return ""; }
  }

  function parseDeadline(value) {
    const match = String(value || "").normalize("NFKC").trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    const [, year, month, day, hour, minute, second = "0"] = match.map((part) => part == null ? part : Number(part));
    if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
    const utc = Date.UTC(year, month - 1, day, hour, minute, Number(second));
    const date = new Date(utc);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return utc - JST;
  }

  function completedStatus(value) {
    return /^(?:提出済み?|回答済み?|合格|完了|実施済み?)$/.test(String(value || "").trim());
  }

  function exclusionReason(task, now) {
    if (task.deadline == null) return /^[\s\-—－]*$/.test(task.rawDeadline || "") ? "締切なし" : "締切の形式を読み取れません";
    if (completedStatus(task.status)) return "提出・実施済みのため対象外";
    if (task.deadline < now) return "期限切れのため対象外";
    if (task.deadline > now + 7 * DAY) return "締切が7日より先のため対象外";
    return "表示対象";
  }

  function selectTasks(tasks, now) {
    return tasks.filter((task) => exclusionReason(task, now) === "表示対象")
      .sort((a, b) => a.deadline - b.deadline || a.courseName.localeCompare(b.courseName, "ja") || a.title.localeCompare(b.title, "ja"));
  }

  function extractTasks(doc, courses, baseUrl) {
    const covered = new Set();
    const pending = new Set();
    const tasks = new Map();
    const observations = new Map();
    let missingDates = 0;
    const tables = Array.from(doc.querySelectorAll("table"), table => {
      // Match one header row belonging to this table; nested tables and extra
      // header rows must not shift the column indexes.
      const rows = Array.from(table.rows).filter(row => row.closest("table") === table);
      const header = rows.find(row => {
        const labels = Array.from(row.cells).filter(cell => cell.tagName === "TH").map(cell => cell.textContent.trim());
        return ["教材", "締切", "状態"].every(label => labels.includes(label));
      });
      return header ? { table, rows, header } : null;
    }).filter(Boolean);
    const assignmentTables = new Set(tables.map(({ table }) => table));
    const isMaterialLink = (link) => {
      let table = link.closest("table");
      while (table) {
        if (assignmentTables.has(table)) return true;
        table = table.parentElement?.closest("table");
      }
      return false;
    };
    for (const { table, rows, header } of tables) {
      const headings = Array.from(header.cells, (cell) => cell.textContent.trim());
      const titleIndex = headings.indexOf("教材");
      const deadlineIndex = headings.indexOf("締切");
      const statusIndex = headings.indexOf("状態");
      if (titleIndex < 0 || deadlineIndex < 0 || statusIndex < 0) continue;
      let container = table.parentElement;
      let course;
      while (container && container !== doc.body) {
        // Use the nearest single-course block. Links inside its assignment
        // tables can point to materials in other courses, such as surveys;
        // exclude links in sibling assignment tables as well as this one.
        const links = Array.from(container.querySelectorAll("a[href*='course.php']"))
          .filter((link) => !isMaterialLink(link));
        const ids = new Set(links.map((link) => courseId(link.getAttribute("href"), baseUrl)).filter(Boolean));
        if (ids.size === 1) { course = courses.get([...ids][0]); break; }
        if (ids.size > 1) break;
        container = container.parentElement;
      }
      if (!course) continue;
      if (table.closest('[aria-busy="true"]')) { pending.add(course.id); continue; }
      // An empty tbody can be an AJAX placeholder. It is not evidence that a
      // course has no assignments. Only material rows or an explicit empty
      // message confirm that this course's response has arrived.
      const explicitEmpty = rows.some(row => row !== header && row.cells.length === 1 &&
        /(?:教材|課題|データ)(?:は|が)?ありません|該当する.+ありません|No data available|No matching records/i.test(row.cells[0].textContent));
      let hasMaterials = false;
      for (const row of rows) {
        if (row === header || row.parentElement === table.tHead || row.cells.length <= Math.max(titleIndex, deadlineIndex, statusIndex)) continue;
        // Deliberately read only the assignment, deadline and status columns.
        const title = row.cells[titleIndex]?.textContent.trim();
        const rawDeadline = row.cells[deadlineIndex]?.textContent.trim();
        const status = row.cells[statusIndex]?.textContent.trim() || "-";
        if (!title) continue;
        hasMaterials = true;
        const deadline = parseDeadline(rawDeadline);
        const observationKey = `${course.id}:${title}:${rawDeadline}`;
        observations.set(observationKey, { courseId: course.id, title, rawDeadline, deadline, status });
        if (deadline == null) { missingDates += 1; continue; }
        let href = course.href;
        const link = row.cells[titleIndex]?.querySelector("a[href]");
        if (link) {
          try {
            const url = new URL(link.getAttribute("href"), baseUrl);
            if (url.origin === new URL(baseUrl).origin && /^https?:$/.test(url.protocol) && !url.hash && !/\/(?:logout|delete|submit)(?:[./]|$)/i.test(url.pathname)) href = url.href;
          } catch { /* Use the course link when no usable assignment link exists. */ }
        }
        const key = `${course.id}:${title}:${deadline}`;
        tasks.set(key, { key, title, courseName: course.name, courseId: course.id, deadline, status, href, directLink: href !== course.href });
      }
      if (hasMaterials || explicitEmpty) covered.add(course.id);
      else pending.add(course.id);
    }
    // A course may have separate report/test tables. One completed table must
    // not hide another table whose material rows are still loading.
    for (const id of pending) covered.delete(id);
    return { tasks: [...tasks.values()], observations: [...observations.values()], covered, pending, missingDates };
  }

  function textElement(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value != null) element.textContent = value;
    return element;
  }

  function formatDeadline(timestamp) {
    return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(timestamp);
  }

  function remainingLabel(deadline, now) {
    const difference = deadline - now;
    if (difference < 3600000) return `あと${Math.max(1, Math.ceil(difference / 60000))}分`;
    if (difference < DAY) return `あと${Math.ceil(difference / 3600000)}時間`;
    return `あと${Math.ceil(difference / DAY)}日`;
  }

  function renderDiagnostics(panel, now) {
    const details = panel.querySelector(".wcv-deadline-diagnostics");
    if (!details?.open) return;
    const content = details.querySelector(".wcv-deadline-diagnostic-content");
    const opened = new Set(Array.from(content.querySelectorAll("details[open]"), item => item.dataset.courseId));
    content.replaceChildren();
    content.append(textElement("p", "", "拡張が取得した教材・締切・状態と判定結果です。科目がここにない場合は、対象の時間割に含まれていません。"));
    for (const course of state.courses.values()) {
      const rows = state.observations.filter(row => row.courseId === course.id);
      const section = textElement("details", "wcv-deadline-diagnostic-course");
      section.dataset.courseId = course.id;
      section.open = opened.has(course.id);
      const included = rows.filter(row => exclusionReason(row, now) === "表示対象").length;
      section.append(textElement("summary", "", `${course.name}：表示対象${included}件／取得教材${rows.length}件`));
      const readStatus = state.covered.has(course.id) ? "教材行・教材なしの表示を確認済み" : state.pending.has(course.id) ? `未読込の課題表あり${rows.length ? "（確認できた教材・前回の情報を表示）" : "（表の枠のみ取得・教材行は未確認）"}` : rows.length ? "今回は未取得・前回の情報" : "課題表を取得できていません";
      section.append(textElement("p", "", `コースID: ${course.id} · ${readStatus}`));
      const list = textElement("ul", "");
      for (const row of rows) {
        const item = textElement("li", "");
        item.append(textElement("strong", "", row.title));
        item.append(textElement("p", "", `締切: ${JSON.stringify(row.rawDeadline || "")} · 状態: ${row.status} · ${exclusionReason(row, now)}`));
        list.append(item);
      }
      section.append(list);
      content.append(section);
    }
  }

  function render() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const now = Date.now();
    const tasks = selectTasks(state.tasks, now);
    renderDiagnostics(panel, now);
    panel.querySelector(".wcv-deadline-count").textContent = `${tasks.length}件`;
    const refresh = panel.querySelector(".wcv-deadline-refresh");
    refresh.disabled = state.loading;
    refresh.textContent = state.loading ? "読み込み中…" : "更新";
    const status = panel.querySelector(".wcv-deadline-status");
    if (state.loading) status.textContent = "WebClassの課題実施状況一覧を確認しています…";
    else if (state.error) status.textContent = state.error + (state.updatedAt ? ` ${formatDeadline(state.updatedAt)}に取得した情報を表示しています。` : "");
    else status.textContent = `${state.courses.size}科目中${state.covered.size}科目の教材を確認 · ${state.updatedAt ? formatDeadline(state.updatedAt) + " 更新" : "未取得"}${state.missingDates ? ` · 締切なし・読取失敗の教材 ${state.missingDates}件は対象外` : ""}`;
    const list = panel.querySelector(".wcv-deadline-list");
    list.replaceChildren();
    if (!tasks.length) {
      list.append(textElement("p", "wcv-deadline-empty", state.loading ? "課題を読み込み中です。" : state.error ? "「更新」で再取得できます。" : "確認できた範囲では、1週間以内に締切を迎える対象課題はありません。"));
      return;
    }
    for (const task of tasks) {
      const item = textElement("li", `wcv-deadline-item${task.deadline - now <= DAY ? " wcv-deadline-urgent" : ""}`);
      const content = textElement("div", "wcv-deadline-content");
      content.append(textElement("span", "wcv-deadline-course", task.courseName), textElement("strong", "wcv-deadline-title", task.title));
      const knownStatus = task.status !== "-" && task.status !== "—";
      content.append(textElement("span", "wcv-deadline-task-status", knownStatus ? task.status : "提出状況を確認"));
      const due = textElement("div", "wcv-deadline-due");
      const time = textElement("time", "", formatDeadline(task.deadline));
      time.dateTime = new Date(task.deadline).toISOString();
      due.append(time, textElement("span", "wcv-deadline-remaining", remainingLabel(task.deadline, now)));
      const link = textElement("a", "wcv-deadline-open", task.directLink ? "課題を開く" : "コースを開く");
      link.href = task.href;
      link.setAttribute("aria-label", `${task.title}：${link.textContent}`);
      item.append(content, due, link);
      list.append(item);
    }
  }

  function stopLoading() {
    state.cancelLoad?.();
    state.cancelLoad = null;
    state.frame?.remove();
    state.frame = null;
    state.loading = false;
  }

  function destroy() {
    stopLoading();
    clearInterval(state.timer);
    state.timer = null;
    state.signature = "";
    state.tasks = [];
    state.observations = [];
    state.pending = new Set();
    document.getElementById(PANEL_ID)?.remove();
  }

  function load(dashboardUrl) {
    stopLoading();
    state.loading = true;
    state.error = "";
    render();
    const frame = document.createElement("iframe");
    frame.className = "wcv-root";
    // Keep a real viewport for dashboard widgets that defer rendering when
    // their container has no layout. The frame remains outside the screen.
    frame.style.cssText = "position:fixed;left:-200vw;top:0;width:100vw;height:100vh;border:0;opacity:0;pointer-events:none";
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.inert = true;
    frame.title = "課題実施状況の読み込み";
    frame.src = dashboardUrl;
    state.frame = frame;
    const started = Date.now();
    let previousSignature = "";
    let stableSince = 0;
    const poll = setInterval(() => {
      if (state.frame !== frame) return;
      let result;
      try {
        const doc = frame.contentDocument;
        if (doc && doc.location.href !== "about:blank") result = extractTasks(doc, state.courses, dashboardUrl);
      } catch { /* A login redirect may temporarily be outside this origin. */ }
      if (result?.covered.size || result?.observations.length) {
        const signature = JSON.stringify([result.observations, [...result.covered], [...result.pending], result.missingDates]);
        if (signature !== previousSignature) { previousSignature = signature; stableSince = Date.now(); }
        if (result.covered.size === state.courses.size && Date.now() - stableSince >= 1000) return finish(result);
      }
      if (Date.now() - started >= 20000) finish(result);
    }, 250);
    state.cancelLoad = () => clearInterval(poll);
    const finish = (result) => {
      if (state.frame !== frame) return;
      state.pending = result?.pending || new Set();
      if (result?.covered.size || result?.observations.length) {
        // An incomplete refresh must not erase the last known tasks of courses
        // whose tables have not arrived. Replace checked courses in full so
        // submitted or removed assignments do disappear after a successful read.
        const retained = state.tasks.filter((task) => !result.covered.has(task.courseId));
        state.tasks = [...new Map([...retained, ...result.tasks].map(task => [task.key, task])).values()];
        const retainedObservations = state.observations.filter(row => !result.covered.has(row.courseId));
        state.observations = [...new Map([...retainedObservations, ...result.observations].map(row => [`${row.courseId}:${row.title}:${row.rawDeadline}`, row])).values()];
        state.covered = result.covered;
        state.missingDates = result.missingDates;
        state.updatedAt = Date.now();
        if (result.covered.size < state.courses.size) state.error = `${state.courses.size}科目中${result.covered.size}科目を確認。一部の科目の教材の読み込みを確認できませんでした。${retained.length ? "未取得の科目は前回の情報を表示しています。" : ""}「更新」で再確認してください。`;
      } else {
        state.covered = new Set();
        state.error = state.pending.size ? "課題情報を取得できませんでした。課題表の枠はありますが、教材の読み込みを確認できていません。「更新」で再確認してください。" : "課題情報を取得できませんでした。WebClassへのログイン状態を確認して「更新」を押してください。";
      }
      stopLoading();
      render();
    };
    document.body.append(frame);
  }

  function sync(settings) {
    const table = document.querySelector("table#schedule-table, table.schedule-table");
    const dashboard = Array.from(document.querySelectorAll("a[href]"))
      .find((link) => {
        if (link.closest(".wcv-root")) return false;
        try {
          const url = new URL(link.href, location.href);
          return url.pathname === "/webclass/ip_mods.php/plugin/score_summary_table/dashboard" && url.origin === location.origin;
        } catch { return false; }
      });
    if (!settings.enabled || settings.showDeadlineList === false || !table || !dashboard) { destroy(); return; }
    const courses = new Map();
    for (const link of table.querySelectorAll("a[href*='course.php']")) {
      const id = courseId(link.getAttribute("href"), location.href);
      if (!id) continue;
      const name = link.textContent.replace(/^\s*»\s*/, "").replace(/[（(][^）)]*20\d{2}年度[^）)]*[）)]/g, "").replace(/_[a-z]{3,4}\d{4,6}[\s\S]*$/i, "").trim();
      courses.set(id, { id, name, href: link.href });
    }
    if (!courses.size) { destroy(); return; }
    const signature = [...courses.keys()].sort().join(",");
    if (signature === state.signature && document.getElementById(PANEL_ID)) return;
    destroy();
    state.signature = signature;
    state.courses = courses;
    state.covered = new Set();
    state.pending = new Set();
    state.missingDates = 0;
    state.updatedAt = null;
    const sidebar = table.closest(".col-sm-9")?.parentElement?.querySelector(":scope > .col-sm-3");
    const panel = textElement("section", `wcv-root wcv-deadlines${sidebar ? " wcv-deadlines-sidebar" : ""}`);
    panel.id = PANEL_ID;
    panel.setAttribute("aria-label", "1週間以内の課題");
    const header = textElement("div", "wcv-deadline-header");
    const heading = textElement("h2", "", "1週間以内の課題");
    header.append(heading, textElement("span", "wcv-deadline-count", "0件"));
    const controls = textElement("div", "wcv-deadline-controls");
    const refresh = textElement("button", "wcv-deadline-refresh", "更新");
    refresh.type = "button";
    refresh.addEventListener("click", () => load(dashboard.href));
    controls.append(textElement("span", "wcv-deadline-window", "7日以内・締切順"), refresh);
    const status = textElement("p", "wcv-deadline-status");
    status.setAttribute("role", "status");
    const list = textElement("ul", "wcv-deadline-list");
    const note = textElement("p", "wcv-deadline-note", "時間割にある科目が対象です。提出済み等は除外。提出状況が不明な課題はコースで確認してください。締切は日本時間です。");
    const diagnostics = textElement("details", "wcv-deadline-diagnostics");
    diagnostics.append(textElement("summary", "", "課題の取得・除外理由"), textElement("div", "wcv-deadline-diagnostic-content"));
    diagnostics.addEventListener("toggle", () => renderDiagnostics(panel, Date.now()));
    panel.append(header, controls, status, list, note, diagnostics);
    const main = sidebar || document.querySelector("#js-main, main, #main") || table.parentElement;
    main.prepend(panel);
    state.timer = setInterval(render, 60000);
    load(dashboard.href);
  }

  globalThis.WCV_DEADLINES = Object.freeze({ sync, destroy });
})();
