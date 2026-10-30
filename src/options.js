(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    restyle: true,
    modernizeNativeLayout: true,
    showInlineMetadata: true,
    showEnhancedTimetable: false,
    showSidebarTools: true,
    showFloatingPanel: true,
    showSourceLabel: true,
    userCourses: []
  };

  const toggleIds = [
    "enabled",
    "restyle",
    "modernizeNativeLayout",
    "showInlineMetadata",
    "showEnhancedTimetable",
    "showSidebarTools",
    "showFloatingPanel",
    "showSourceLabel"
  ];

  const editor = document.getElementById("jsonEditor");
  const message = document.getElementById("message");
  const overrideCount = document.getElementById("overrideCount");
  const datasetSummary = document.getElementById("datasetSummary");
  const datasetQuality = document.getElementById("datasetQuality");
  const savedChip = document.getElementById("savedChip");
  const detailPanel = document.getElementById("detailPanel");
  let chipTimer = 0;

  function flashSaved() {
    savedChip.textContent = "✓ 保存しました";
    savedChip.classList.add("show");
    clearTimeout(chipTimer);
    chipTimer = setTimeout(() => savedChip.classList.remove("show"), 1800);
  }

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }

  function storageSet(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }

  function setMessage(text, kind = "") {
    message.className = `message ${kind}`.trim();
    message.textContent = text;
  }

  function prettyOverrides(courses) {
    return JSON.stringify({ courses: Array.isArray(courses) ? courses : [] }, null, 2);
  }

  function normalizePayload(parsed) {
    const courses = Array.isArray(parsed) ? parsed : parsed?.courses;
    if (!Array.isArray(courses)) {
      throw new Error('最上位は { "courses": [ ... ] }、または科目配列にしてください。');
    }

    const validated = courses.map((course, index) => {
      if (!course || typeof course !== "object" || Array.isArray(course)) {
        throw new Error(`${index + 1}件目の科目がオブジェクトではありません。`);
      }
      if (typeof course.courseName !== "string" || !course.courseName.trim()) {
        throw new Error(`${index + 1}件目に courseName がありません。`);
      }
      if (course.instructors != null && !Array.isArray(course.instructors)) {
        throw new Error(`${course.courseName}: instructors は配列にしてください。`);
      }
      if (course.meetings != null && !Array.isArray(course.meetings)) {
        throw new Error(`${course.courseName}: meetings は配列にしてください。`);
      }

      const meetings = (course.meetings || []).map((meeting, meetingIndex) => {
        if (!meeting || typeof meeting !== "object") {
          throw new Error(`${course.courseName}: meetings[${meetingIndex}] が不正です。`);
        }
        const period = Number(meeting.period);
        if (!meeting.day || !Number.isInteger(period) || period < 1 || period > 9) {
          throw new Error(`${course.courseName}: day と period を確認してください。`);
        }
        return {
          ...meeting,
          day: String(meeting.day).trim(),
          period,
          room: meeting.room == null ? "" : String(meeting.room).trim()
        };
      });

      return {
        ...course,
        courseName: course.courseName.trim(),
        courseCode: course.courseCode ? String(course.courseCode).trim() : undefined,
        aliases: Array.isArray(course.aliases)
          ? course.aliases.map(String).map((value) => value.trim()).filter(Boolean)
          : [],
        instructors: Array.isArray(course.instructors)
          ? course.instructors.map(String).map((value) => value.trim()).filter(Boolean)
          : [],
        meetings
      };
    });

    return validated;
  }

  function updateCount(courses) {
    overrideCount.textContent = `${courses.length}件`;
  }

  async function loadBundledData() {
    try {
      const [response, historyResponse] = await Promise.all([
        fetch(chrome.runtime.getURL("data/timetable-2026.json")),
        fetch(chrome.runtime.getURL("data/historical-course-row-evidence.json"))
      ]);
      if (!response.ok) throw new Error(`時間割データ: HTTP ${response.status}`);
      if (!historyResponse.ok) throw new Error(`過年度データ: HTTP ${historyResponse.status}`);
      const [data, history] = await Promise.all([response.json(), historyResponse.json()]);
      const scope = data.dataset?.scope || {};
      const count = scope.uniqueCourses || (Array.isArray(data.courses) ? data.courses.length : 0);
      const departmentLabels = Array.from(new Set((scope.departments || []).map((item) => item.label).filter(Boolean)));
      const generatedDate = String(data.dataset?.generatedAt || "").slice(0, 10);
      datasetSummary.textContent = `${data.dataset?.title || "時間割データ"}：${count}科目、${scope.sourceDocuments?.length || 0}資料、${scope.timetablePages || 0}頁を収録。対象は${departmentLabels.length}学科・研究科区分、${(scope.campuses || []).join("・")}。${generatedDate ? `${generatedDate}生成の` : ""}調査用スナップショットです。`;
      const years = Array.isArray(history.summary?.academicYears) ? history.summary.academicYears.join("・") : "";
      const candidates = Number(history.summary?.sourceOccurrences) || 0;
      const reviewed = Number(history.summary?.visuallyReviewedOccurrences) || 0;
      const unreviewed = Number(history.summary?.unreviewedOccurrences) || 0;
      const pastText = candidates
        ? `過年度${years || "一部年度"}のPDF掲載行${candidates.toLocaleString("ja-JP")}件を授業詳細に候補表示します（目視確認${reviewed.toLocaleString("ja-JP")}件、未確認${unreviewed.toLocaleString("ja-JP")}件）。`
        : "過年度の時間割行候補はありません。";
      const guideText = history.database?.curriculumStatus === "not-populated"
        ? "履修要覧のPDF・要件データは未登録です。"
        : "履修要覧の要件データは確認中です。";
      datasetQuality.textContent = `現行時間割との全件照合は未完了です。${pastText}未確認候補は公式PDFで確認してください。${guideText}最新の休講・教室変更はWebClassのお知らせを優先してください。`;
    } catch (error) {
      datasetSummary.textContent = `時間割データを読み込めませんでした: ${error.message}`;
      datasetQuality.textContent = "拡張機能を再読み込みしてから、この設定画面を開き直してください。";
    }
  }

  async function initialize() {
    const settings = await storageGet(DEFAULTS);

    for (const id of toggleIds) {
      const control = document.getElementById(id);
      control.checked = Boolean(settings[id]);
      control.addEventListener("change", async () => {
        await storageSet({ [id]: control.checked });
        if (id === "enabled") detailPanel.classList.toggle("dim", !control.checked);
        flashSaved();
      });
    }

    detailPanel.classList.toggle("dim", !settings.enabled);

    const courses = Array.isArray(settings.userCourses) ? settings.userCourses : [];
    editor.value = prettyOverrides(courses);
    updateCount(courses);
    if (courses.length) document.getElementById("advanced").open = true;
    loadBundledData();

    document.getElementById("saveJson").addEventListener("click", async () => {
      try {
        const parsed = JSON.parse(editor.value || '{"courses":[]}');
        const validated = normalizePayload(parsed);
        editor.value = prettyOverrides(validated);
        await storageSet({ userCourses: validated });
        updateCount(validated);
        setMessage(`${validated.length}件の上書きデータを検証して保存しました。`, "success");
      } catch (error) {
        setMessage(`保存できません: ${error.message}`, "error");
      }
    });

    document.getElementById("formatJson").addEventListener("click", () => {
      try {
        const parsed = JSON.parse(editor.value || '{"courses":[]}');
        editor.value = JSON.stringify(parsed, null, 2);
        setMessage("JSONを整形しました。保存ボタンを押すまで設定は変わりません。", "success");
      } catch (error) {
        setMessage(`整形できません: ${error.message}`, "error");
      }
    });

    document.getElementById("loadSample").addEventListener("click", async () => {
      try {
        const response = await fetch(chrome.runtime.getURL("data/sample-user-overrides.json"));
        const sample = await response.json();
        editor.value = JSON.stringify(sample, null, 2);
        setMessage("記入例を表示しました。必要箇所を修正して保存してください。", "success");
      } catch (error) {
        setMessage(`記入例を読み込めません: ${error.message}`, "error");
      }
    });

    document.getElementById("exportJson").addEventListener("click", () => {
      try {
        const parsed = JSON.parse(editor.value || '{"courses":[]}');
        const validated = normalizePayload(parsed);
        const blob = new Blob([prettyOverrides(validated) + "\n"], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "webclass-course-overrides.json";
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage("上書きデータを書き出しました。", "success");
      } catch (error) {
        setMessage(`書き出せません: ${error.message}`, "error");
      }
    });

    document.getElementById("resetJson").addEventListener("click", async () => {
      if (!confirm("上書きデータをすべて削除します。よろしいですか？")) return;
      await storageSet({ userCourses: [] });
      editor.value = prettyOverrides([]);
      updateCount([]);
      setMessage("上書きデータを削除し、同梱時間割データへ戻しました。", "success");
    });
  }

  initialize();
})();
