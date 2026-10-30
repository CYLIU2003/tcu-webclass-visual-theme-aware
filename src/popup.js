(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    restyle: true,
    modernizeNativeLayout: true,
    showInlineMetadata: true,
    showEnhancedTimetable: false
  };

  const SUB_KEYS = ["restyle", "modernizeNativeLayout", "showInlineMetadata", "showEnhancedTimetable"];

  const controls = {
    enabled: document.getElementById("enabled"),
    restyle: document.getElementById("restyle"),
    modernizeNativeLayout: document.getElementById("modernizeNativeLayout"),
    showInlineMetadata: document.getElementById("showInlineMetadata"),
    showEnhancedTimetable: document.getElementById("showEnhancedTimetable")
  };

  const statusCard = document.getElementById("statusCard");
  const statusTitle = document.getElementById("statusTitle");
  const statusDetail = document.getElementById("statusDetail");
  const statusCount = document.getElementById("statusCount");
  const saveNotice = document.getElementById("saveNotice");
  const datasetSummary = document.getElementById("datasetSummary");
  const datasetQuality = document.getElementById("datasetQuality");
  const datasetQualityTitle = document.getElementById("datasetQualityTitle");
  const datasetQualityDetail = document.getElementById("datasetQualityDetail");
  const guideCard = document.getElementById("guideCard");
  const reloadCard = document.getElementById("reloadCard");
  const optionsSummary = document.getElementById("optionsSummary");
  const openWebClass = document.getElementById("openWebClass");

  let activeTab = null;
  let noticeTimer = 0;

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }

  function storageSet(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }

  function queryActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] || null));
    });
  }

  function sendToTab(tabId, message) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    });
  }

  function setStatus(kind, title, detail, countText = "", { guide = false, reload = false } = {}) {
    statusCard.dataset.kind = kind;
    statusTitle.textContent = title;
    statusDetail.textContent = detail;
    statusCount.hidden = !countText;
    statusCount.textContent = countText;
    guideCard.hidden = !guide;
    reloadCard.hidden = !reload;
    openWebClass.textContent = activeTab?.url?.startsWith("https://webclass.tcu.ac.jp/")
      ? "WebClassを新しく開く"
      : "WebClassを開く";
  }

  function updateOptionsSummary() {
    const on = SUB_KEYS.filter((key) => controls[key].checked).length;
    optionsSummary.textContent = `${on} / ${SUB_KEYS.length} 項目がオン`;
    SUB_KEYS.forEach((key) => { controls[key].disabled = !controls.enabled.checked; });
  }

  function showSaved(text = "保存しました。画面へ自動反映します。") {
    saveNotice.textContent = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { saveNotice.textContent = ""; }, 2000);
  }

  async function loadDatasetSummary() {
    try {
      const [response, historyResponse] = await Promise.all([
        fetch(chrome.runtime.getURL("data/timetable-2026.json")),
        fetch(chrome.runtime.getURL("data/historical-course-row-evidence.json"))
      ]);
      if (!response.ok) throw new Error(`時間割 ${response.status}`);
      if (!historyResponse.ok) throw new Error(`過年度資料 ${historyResponse.status}`);
      const [data, history] = await Promise.all([response.json(), historyResponse.json()]);
      const scope = data.dataset?.scope || {};
      const count = (scope.uniqueCourses || data.courses?.length || 0).toLocaleString("ja-JP");
      const year = data.dataset?.academicYear || 2026;
      const generatedDate = String(data.dataset?.generatedAt || "").slice(0, 10);
      datasetSummary.textContent = `${year}年度の時間割スナップショット：${count}科目${generatedDate ? `（${generatedDate}生成）` : ""}`;
      const summary = history.summary || {};
      const years = Array.isArray(summary.academicYears) ? summary.academicYears.join("・") : "";
      const candidates = Number(summary.sourceOccurrences) || 0;
      const reviewed = Number(summary.visuallyReviewedOccurrences) || 0;
      const unreviewed = Number(summary.unreviewedOccurrences) || 0;
      datasetQuality.dataset.kind = "warning";
      datasetQualityTitle.textContent = "現行資料との全件照合は未完了です";
      const pastText = candidates
        ? `過年度${years || "一部年度"}のPDF掲載行${candidates.toLocaleString("ja-JP")}件を候補として収録（目視確認${reviewed.toLocaleString("ja-JP")}件、未確認${unreviewed.toLocaleString("ja-JP")}件）。`
        : "過年度の時間割行候補はありません。";
      const guideText = history.database?.curriculumStatus === "not-populated"
        ? "履修要覧のPDF・要件データは未登録です。"
        : "履修要覧の要件データは確認中です。";
      datasetQualityDetail.textContent = `${pastText}候補の詳細は公式PDFで確認してください。${guideText}最新の休講・変更はWebClassのお知らせをご確認ください。`;
    } catch (error) {
      datasetSummary.textContent = `時間割データを読み込めませんでした（${error.message}）`;
      datasetQuality.dataset.kind = "warning";
      datasetQualityTitle.textContent = "収録データを確認できません";
      datasetQualityDetail.textContent = "拡張機能を再読み込みしてから、WebClassタブを更新してください。";
    }
  }

  async function refreshStatus() {
    activeTab = await queryActiveTab();

    if (!activeTab?.url?.startsWith("https://webclass.tcu.ac.jp/")) {
      setStatus(
        "idle",
        "WebClassを開いて使います",
        "このページでは何も変わりません。WebClassのコースリストを開くと自動で動きます。",
        "",
        { guide: true }
      );
      return;
    }

    const response = await sendToTab(activeTab.id, { type: "wcv-get-status" });
    if (!response?.ready) {
      setStatus(
        "error",
        "まだ読み込まれていません",
        "拡張機能を入れた直後や更新した直後は、WebClassの再読み込みが必要です。",
        "",
        { reload: true }
      );
      return;
    }

    if (!response.enabled) {
      setStatus("off", "いまはオフです", "右上のスイッチをオンにすると、教室と担当教員が表示されます。");
      return;
    }

    const current = response.currentCourse
      ? `表示中の科目：${response.currentCourse}`
      : "コースリストを開くと、科目ごとに教室・担当教員が出ます。";
    setStatus(
      "ready",
      "WebClassで動いています",
      current,
      response.detectedCount > 0 ? `この画面で ${response.detectedCount} 科目を検出` : ""
    );
  }

  async function initialize() {
    const settings = await storageGet(DEFAULTS);

    Object.entries(controls).forEach(([key, control]) => {
      control.checked = Boolean(settings[key]);
      control.addEventListener("change", async () => {
        await storageSet({ [key]: control.checked });
        updateOptionsSummary();
        showSaved(key === "enabled"
          ? (control.checked ? "オンにしました。" : "オフにしました。元の画面に戻ります。")
          : undefined);
        setTimeout(refreshStatus, 200);
      });
    });
    updateOptionsSummary();

    openWebClass.addEventListener("click", () => {
      chrome.tabs.create({ url: "https://webclass.tcu.ac.jp/" });
      window.close();
    });

    document.getElementById("openGuide").addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("src/welcome.html") });
      window.close();
    });

    document.getElementById("openOptions").addEventListener("click", () => {
      chrome.runtime.openOptionsPage();
      window.close();
    });

    document.getElementById("reloadTab").addEventListener("click", () => {
      if (activeTab?.id != null) chrome.tabs.reload(activeTab.id);
      setStatus("checking", "更新しています…", "少し待つと反映されます。");
      setTimeout(refreshStatus, 1800);
    });

    loadDatasetSummary();
    refreshStatus();
  }

  initialize();
})();
