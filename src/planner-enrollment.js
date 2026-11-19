(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const format = (value) => String(value / 100);

  function element(tag, text) {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  }

  function amount(input) {
    return input.value !== "" && input.validity.valid ? Math.round(input.valueAsNumber * 100) : null;
  }

  function link(label, url) {
    const anchor = element("a", label);
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    return anchor;
  }

  async function index(path) {
    const response = await fetch(chrome.runtime.getURL(path));
    if (!response.ok) throw new Error("Missing data");
    return response.json();
  }

  async function initialize(stored, catalogYear, catalog) {
    const token = new URLSearchParams(location.search).get("enrollment");
    const status = $("enrollment-status");
    if (token !== null && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(token)) {
      status.textContent = "時間割の読み込み先が無効です。WebClassのコース一覧から開き直してください。";
      return;
    }
    status.textContent = "WebClassの時間割を読み込んでいます。";
    try {
      const key = "wcv-enrollment:" + token;
      let snapshot;
      if (token) snapshot = (await chrome.storage.session.get(key))[key];
      else {
        const tabs = await chrome.tabs.query({url: "https://webclass.tcu.ac.jp/*"});
        const snapshots = (await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id,
          {type: "wcv-read-enrollment"}, {frameId: 0}).catch(() => null)))).filter(Boolean);
        if (snapshots.length > 1) {
          status.textContent = "複数の時間割が開いています。確認したいコース一覧の「履修・進級チェック」を押してください。";
          return;
        }
        snapshot = snapshots[0];
      }
      if (!snapshot) {
        status.textContent = "読み込んだ時間割がありません。WebClassのコース一覧から開き直してください。";
        return;
      }
      const currentYear = snapshot.year === catalogYear;
      const [guides, progression, evidence, courses] = await Promise.all([
        index("data/undergraduate-guides.json"), index("data/progression-rules.json"),
        index("data/syllabus-credit-evidence.json"),
        currentYear ? catalog : index("data/historical-course-row-evidence.json")
          .then((history) => history.records.filter((course) => course.academicYear === snapshot.year))
      ]);
      const matching = WCV_ENROLLMENT_MATCH;
      const courseIndex = matching.createIndex(courses);
      const profile = $("enrollment-profile");
      const stage = $("enrollment-stage");
      const earned = $("enrollment-earned");
      const result = $("enrollment-result");
      const source = $("enrollment-source");
      const byId = new Map(guides.profiles.map((row) => [`${row.year}:${row.department}`, row]));
      profile.append(new Option("入学年度と学科を選択", ""));
      for (const year of [...new Set(guides.profiles.map((row) => row.year))].reverse()) {
        const group = document.createElement("optgroup");
        group.label = `${year}年度入学`;
        for (const row of guides.profiles.filter((row) => row.year === year)) {
          group.append(new Option(`${row.year}年度・${row.department}`, `${row.year}:${row.department}`));
        }
        profile.append(group);
      }
      let programSettings = stored[WCV_CURRICULUM.settingsKey];
      const remembered = programSettings?.cohort || stored["planner-guide:profile"];
      if (byId.has(remembered)) profile.value = remembered;

      let matched = 0;
      let byContext = 0;
      const seenCodes = new Set();
      const inputs = [];
      const entries = [];
      const assigned = new Set(snapshot.courses.map((row) => row.code).filter(Boolean));
      const lookupButton = $("enrollment-lookup");
      const lookupStatus = $("enrollment-lookup-status");
      const pending = () => entries.filter((entry) => entry.code && !entry.evidence);
      let lookupRunning = false;
      const syncLookup = () => { lookupButton.disabled = lookupRunning || !pending().length; };
      for (const row of snapshot.courses) {
        if (row.code && seenCodes.has(row.code)) continue;
        if (row.code) seenCodes.add(row.code);
        const match = matching.identify(row, courseIndex, snapshot.term, snapshot.year, currentYear);
        let course = match.course;
        if (course && match.method === "context" && assigned.has(course.courseCode)) course = null;
        if (course && match.method === "context") {
          assigned.add(course.courseCode);
          byContext++;
        }
        if (course && match.method === "code") matched++;
        const item = element("li", "");
        const info = element("div", "");
        const registration = matching.registration(row.name);
        const heading = element("strong", "");
        const matchStatus = element("p", "");
        const unitStatus = element("p", "");
        const programNotes = element("div", "");
        info.append(heading, matchStatus);
        const input = document.createElement("input");
        Object.assign(input, { type: "number", min: "0", max: "999", step: "0.01", inputMode: "decimal" });
        const entry = { code: match.method === "conflict" ? null : row.code || course?.courseCode, course, evidence: null, titles: [] };
        const apply = element("button", "見込み単位に入れる");
        apply.type = "button";
        apply.hidden = true;
        const applyPlan = element("button", "");
        applyPlan.type = "button";
        applyPlan.hidden = true;
        applyPlan.addEventListener("click", () => {
          input.value = format(entry.plannedUnits);
          render();
          input.focus();
        });
        apply.addEventListener("click", () => {
          if (!entry.evidence) return;
          input.value = format(entry.evidence.units);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.focus();
        });
        function showEvidence(found) {
          entry.evidence = found;
          unitStatus.replaceChildren();
          apply.hidden = !found;
          if (!found) unitStatus.textContent = "シラバスの単位数は未確認";
          if (found) {
            unitStatus.append(link(`公式シラバス ${format(found.units)}単位`, found.source));
            unitStatus.append("（進級に算入できる科目かは要覧で確認）");
          }
        }
        function showMatch(method) {
          const selected = entry.course;
          item.dataset.needsReview = String(!selected);
          item.tabIndex = -1;
          heading.textContent = selected?.courseName || registration.title || row.name;
          const reason = method === "context" ? "授業名・担当・時限で照合"
            : method === "confirmed" ? "候補を選択済み" : selected ? "講義コードで照合" : "時間割データ未照合";
          matchStatus.textContent = entry.code
            ? [entry.code, ...(selected?.instructors || []), reason].join(" ／ ")
            : (method === "conflict" ? "開講年度が一致しません。WebClassの表示年度を確認してください。"
              : match.candidates.length ? `授業名が一致する候補 ${match.candidates.length}件` : "講義コードを照合できません");
          input.setAttribute("aria-label", `${registration.title || row.name}（${entry.code || "コード未照合"}）の見込み単位`);
          entry.titles = selected ? [selected.courseName, ...(selected.aliases || [])] : [registration.title];
          const half = matching.semesterFor(snapshot.term, selected);
          const savedEvidence = evidence.records.filter((record) =>
            matching.validEvidence(record, snapshot.year, entry.code, entry.titles, half));
          showEvidence(savedEvidence.length && savedEvidence.every((record) => record.units === savedEvidence[0].units)
            ? savedEvidence[0] : null);
          const record = stored[`${WCV_PLANNER_CREDITS.entryPrefix}planner:${snapshot.year}:${entry.code}`];
          entry.plannedUnits = record?.status === "planned" && Number.isInteger(record.units)
            && record.units > 0 && record.units <= 99900 ? record.units : null;
          applyPlan.hidden = entry.plannedUnits === null;
          if (!applyPlan.hidden) applyPlan.textContent = `保存した予定 ${format(entry.plannedUnits)}単位を見込みに入れる`;
        }
        if (!row.code && !course && match.candidates.length) {
          const chooser = element("label", "講義コードを選ぶ");
          const select = document.createElement("select");
          select.append(new Option("候補を選択", ""));
          for (const candidate of match.candidates) {
            const firstMeeting = candidate.meetings?.[0];
            const time = firstMeeting ? `${firstMeeting.day}曜${firstMeeting.period}限` : "";
            const label = [candidate.courseCode, ...(candidate.termBlocks || []), ...(candidate.instructors || []), time].filter(Boolean).join(" ／ ");
            select.append(new Option(label, candidate.courseCode));
          }
          chooser.append(select);
          info.append(chooser);
          select.addEventListener("change", () => {
            if (select.value && assigned.has(select.value) && entry.code !== select.value) {
              select.value = entry.code || "";
              lookupStatus.textContent = "すでに照合済みの講義コードです。別の候補を確認してください。";
              return;
            }
            if (entry.code) assigned.delete(entry.code);
            entry.code = select.value || null;
            entry.course = match.candidates.find((candidate) => candidate.courseCode === entry.code);
            if (entry.code) assigned.add(entry.code);
            input.value = "";
            lookupStatus.textContent = "";
            showMatch(entry.course ? "confirmed" : "");
            syncLookup();
            renderStatus();
            renderPrograms();
            render();
          });
        }
        info.append(programNotes, unitStatus, apply, applyPlan);
        showMatch(match.method);
        const label = element("label", "見込み単位");
        label.append(input);
        item.append(info, label);
        $("enrollment-courses").append(item);
        inputs.push(input);
        entry.showEvidence = showEvidence;
        entry.programNotes = programNotes;
        entry.fallbackName = registration.title;
        entries.push(entry);
      }
      if (!inputs.length) {
        $("enrollment-courses").append(element("li", "この表示範囲の時間割にコースがありません。"));
      }
      $("enrollment-all-tip").hidden = false;
      function renderStatus() {
        const unresolved = entries.filter((entry) => !entry.course).length;
        const selected = entries.length - unresolved - matched - byContext;
        status.textContent = `${snapshot.year}年度・${matching.terms[snapshot.term]} ／ WebClassの参加コース ${entries.length}件 ／ 科目の照合 ${entries.length - unresolved}件（うち手動選択 ${selected}件） ／ 科目の要確認 ${unresolved}件`;
      }
      renderStatus();

      if (entries.some(entry => !entry.course)) {
        const jump = element("button", "最初の要確認科目へ");
        jump.type = "button";
        jump.addEventListener("click", () => {
          const first = $("enrollment-courses").querySelector('[data-needs-review="true"]');
          first?.focus();
        });
        $("enrollment-status").after(jump);
        $("enrollment-courses").addEventListener("change", () => {
          jump.hidden = !entries.some(entry => !entry.course);
        });
      }

      async function lookupUnits(requestPermission) {
        const lookups = pending();
        if (lookupRunning || !lookups.length) return;
        lookupRunning = true;
        syncLookup();
        const selectors = [...$("enrollment-courses").querySelectorAll("select")];
        const total = lookups.length;
        let verified = 0;
        let checked = 0;
        let failed = 0;
        selectors.forEach((select) => { select.disabled = true; });
        try {
          if (requestPermission && !await chrome.permissions.request(matching.permission)) {
            lookupStatus.textContent = "シラバス照会の許可がありません。単位は手入力できます。";
            return;
          }
          lookupStatus.textContent = `公開シラバスを照合しています（0 / ${total}件）。`;
          const check = async () => {
            for (let entry = lookups.shift(); entry; entry = lookups.shift()) {
              try {
                const found = await matching.lookup(snapshot.year, entry.code, entry.titles,
                  matching.semesterFor(snapshot.term, entry.course));
                if (found) {
                  entry.showEvidence(found);
                  verified++;
                }
              } catch {
                failed++;
              }
              checked++;
              lookupStatus.textContent = `公開シラバスを照合しています（${checked} / ${total}件）。`;
            }
          };
          await Promise.all([check(), check(), check()]);
          lookupStatus.textContent = `単位数を確認 ${verified}件、未確認 ${total - verified}件。` +
            (failed ? ` うち通信エラー ${failed}件。再照会できます。` : "") +
            (verified ? " 算入対象の科目は「見込み単位に入れる」を押してください。" : " 単位は手入力できます。");
        } catch {
          lookupStatus.textContent = "公開シラバスに接続できませんでした。時間をおいてお試しください。";
        } finally {
          selectors.forEach((select) => { select.disabled = false; });
          lookupRunning = false;
          syncLookup();
        }
      }
      lookupButton.addEventListener("click", () => lookupUnits(true));
      syncLookup();

      function render() {
        const row = byId.get(profile.value);
        const rule = progression.profiles[profile.value]?.find((entry) => entry.stage === Number(stage.value));
        const values = inputs.map(amount);
        const unentered = values.filter((value) => value === null).length;
        const planned = values.reduce((sum, value) => sum + (value ?? 0), 0);
        const base = amount(earned);
        source.replaceChildren();
        if (row) {
          const url = rule?.url || row.sources[0].url;
          source.append(link(rule ? `進級条件の原表（PDF p.${rule.page}）` : "学修要覧を確認", rule ? `${url}#page=${rule.page}` : url));
        }
        result.replaceChildren(element("strong", `入力済みの見込み ${format(planned)}単位`));
        if (unentered) result.append(element("span", `見込み単位が未入力 ${unentered}件`));
        if (!row || !rule) {
          result.append(element("p", row ? "この進級先の総単位条件は要覧で確認してください。" : "入学年度と学科を選ぶと、進級条件を表示します。"));
          return;
        }
        result.append(element("strong", `進級条件の総単位 ${rule.minimum}単位`));
        if (base !== null) {
          const minimum = rule.minimum * 100;
          const remaining = Math.max(0, minimum - base - planned);
          const earnedGap = Math.max(0, minimum - base);
          result.append(element("p", `取得済み ${format(base)}単位（総単位まで残り ${format(earnedGap)}単位）`));
          result.append(element("p", `入力済みの見込みを含む ${format(base + planned)}単位（総単位まで残り ${format(remaining)}単位）`));
        }
        result.append(element("p", "確認しているのは総単位数です。必修・区分別単位・在学期間などの条件と、ポータルの正誤表も確認してください。"));
      }

      let programs;
      function renderPrograms() {
        for (const entry of entries) {
          const name = entry.course?.level === "大学院" ? "" : entry.course?.courseName || entry.fallbackName;
          const rows = programs && programSettings?.cohort === profile.value
            ? WCV_CURRICULUM.programMatches(...programs, programSettings, name) : [];
          entry.programNotes.replaceChildren(...rows.map((row) => {
            const note = element("p", "");
            note.append(link(WCV_CURRICULUM.programLabel(row), row.url), " ― ", row.note);
            return note;
          }));
        }
      }

      WCV_PLANNER_PROGRAMS.load().then((data) => {
        programs = data;
        renderPrograms();
      }).catch(() => {});
      profile.addEventListener("change", renderPrograms);
      chrome.storage.onChanged.addListener((changes, area) => {
        const change = changes[WCV_CURRICULUM.settingsKey];
        if (area !== "local" || !change) return;
        programSettings = change.newValue;
        if (byId.has(programSettings?.cohort)) profile.value = programSettings.cohort;
        renderPrograms();
        render();
      });

      $("enrollment-content").addEventListener("input", render);
      render();
      $("enrollment-content").hidden = false;

      async function autoLookup() {
        if (location.hash !== "#enrollment-title") return;
        window.removeEventListener("hashchange", autoLookup);
        const allowed = await chrome.permissions.contains(matching.permission).catch(() => false);
        if (allowed) lookupUnits(false);
      }
      window.addEventListener("hashchange", autoLookup);
      autoLookup();
    } catch {
      status.textContent = "時間割または進級条件を読み込めませんでした。WebClassのコース一覧から開き直してください。";
    }
  }

  globalThis.WCV_PLANNER_ENROLLMENT = { initialize };
})();
