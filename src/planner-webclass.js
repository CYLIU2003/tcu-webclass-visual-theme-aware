(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const codePattern = /^[a-z]{3,4}\d{4,6}$/;

  function key(year, row) {
    if (codePattern.test(row.code)) return `${year}:${row.code}`;
    if (/^[a-z0-9]{1,80}$/.test(row.registrationId || "")) return `${year}:wc:${row.registrationId}`;
    return null;
  }

  async function sources() {
    const tabs = await chrome.tabs.query({ url: "https://webclass.tcu.ac.jp/*" });
    const results = await Promise.all(tabs.map(async (tab) => {
      try {
        const snapshot = await chrome.tabs.sendMessage(tab.id, { type: "wcv-read-enrollment" }, { frameId: 0 });
        return snapshot ? { ...snapshot, tabId: tab.id } : null;
      } catch {
        return null;
      }
    }));
    return results.filter(Boolean);
  }

  async function initialize(onSnapshot, saveLedger) {
    const chooser = $("webclass-source-select");
    const status = $("webclass-source-status");
    const refresh = $("webclass-refresh");
    const save = $("webclass-save-ledger");
    const token = new URLSearchParams(location.search).get("enrollment");
    let available = [];
    let snapshot;
    const scope = (row) => `${row.year}年度・${WCV_ENROLLMENT_MATCH.terms[row.term] || "表示中の学期"}`;

    function show(selected) {
      snapshot = selected;
      save.disabled = !snapshot?.courses.length;
      status.textContent = snapshot
        ? `WebClass ${scope(snapshot)}・参加コース ${snapshot.courses.length}件`
        : "取込元のコース一覧を選んでください。WebClassで対象年度・学期を表示できます。";
      onSnapshot(snapshot);
    }

    async function update(tryToken) {
      refresh.disabled = true;
      try {
        const previous = snapshot?.tabId || chooser.value;
        available = await sources();
        const pinned = tryToken && /^[0-9a-f-]{36}$/.test(token || "")
          ? (await chrome.storage.session.get("wcv-enrollment:" + token))["wcv-enrollment:" + token] : null;
        chooser.replaceChildren(new Option("コース一覧を選択", ""),
          ...available.map((row, index) => new Option(`${scope(row)}（タブ ${index + 1}）`, String(row.tabId))));
        $("webclass-source-picker").hidden = available.length < 2;
        const current = available.find((row) => String(row.tabId) === String(previous));
        show(pinned || current || (available.length === 1 ? available[0] : null));
        if (snapshot?.tabId) chooser.value = String(snapshot.tabId);
      } catch {
        status.textContent = "WebClassのコースを読み込めませんでした。コース一覧を確認して再読込してください。";
      } finally {
        refresh.disabled = false;
      }
    }

    chooser.addEventListener("change", () => show(available.find((row) => String(row.tabId) === chooser.value)));
    refresh.addEventListener("click", () => update(false));
    save.addEventListener("click", async () => {
      const selected = snapshot;
      if (!selected || save.getAttribute("aria-busy") === "true") return;
      save.setAttribute("aria-busy", "true");
      try {
        const { added, conflicts } = await saveLedger(selected);
        if (snapshot === selected) status.textContent = `WebClass ${scope(selected)} ／ 履修台帳に ${added}件追加しました（成績は未確認）。` +
          (conflicts ? ` 開講年度の不一致 ${conflicts}件を保留しました。` : "");
      } catch {
        status.textContent = "履修台帳に保存できませんでした。再度お試しください。";
      } finally {
        save.removeAttribute("aria-busy");
        save.disabled = !snapshot?.courses.length;
      }
    });
    await update(true);
  }

  globalThis.WCV_PLANNER_WEBCLASS = { initialize, key };
})();
