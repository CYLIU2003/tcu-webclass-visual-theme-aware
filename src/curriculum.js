/* Source-backed candidates; title matching never certifies an offering. */
(() => {
  "use strict";
  function normalize(value) {
    return String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  }
  function match(data, profile, courseName) {
    if (!data || !profile || !courseName) return [];
    const allowed = new Set();
    if (profile.plan === "2026-information-science") allowed.add("information-science");
    if (profile.plan === "2025-hirameki-engineering") allowed.add("hirameki-engineering-2025");
    if (profile.plan === "2025-hirameki-other") allowed.add("hirameki-other-2025");
    if (profile.plan === "2024-hirameki-engineering") allowed.add("hirameki-engineering");
    if (profile.plan === "2023-hirameki-engineering") allowed.add("hirameki-engineering-2023");
    if (profile.plan === "2022-hirameki-engineering") allowed.add("hirameki-engineering-2022");
    if (profile.hirameki && ["2026-information-science", "2026-hirameki-eligible"].includes(profile.plan)) allowed.add("hirameki-2026");
    if (profile.teaching && profile.plan === "2026-information-science") allowed.add("teaching-engineering-information");
    return (data.records || []).filter(row => allowed.has(row.scope) && normalize(row.title) === normalize(courseName));
  }
  globalThis.WCV_CURRICULUM = Object.freeze({ match, normalize });
})();
