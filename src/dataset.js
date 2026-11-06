(() => {
  "use strict";

  async function load() {
    const path = "data/timetable-2026.json";
    const response = await fetch(chrome.runtime.getURL(path));
    if (!response.ok) throw new Error(`時間割データの読込に失敗しました: ${path} (${response.status})`);
    return response.json();
  }

  globalThis.WCV_DATA = Object.freeze({ load });
})();
