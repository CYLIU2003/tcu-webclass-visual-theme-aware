(() => {
  "use strict";

  const inExtension = location.protocol === "chrome-extension:" || location.protocol === "moz-extension:" || location.protocol === "extension:";
  const isEdge = /Edg\//.test(navigator.userAgent);

  if (inExtension) {
    document.getElementById("installedBanner").hidden = false;
  }

  // 使っているブラウザーの URL を先頭に
  const rows = document.querySelectorAll(".copyrow > div");
  if (isEdge && rows.length === 2) rows[0].parentNode.insertBefore(rows[1], rows[0]);

  document.querySelectorAll(".copy").forEach((button) => {
    button.addEventListener("click", async () => {
      const text = button.dataset.copy;
      try {
        await navigator.clipboard.writeText(text);
      } catch (error) {
        const area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      const original = button.textContent;
      button.textContent = "コピーしました ✓";
      button.classList.add("done");
      setTimeout(() => { button.textContent = original; button.classList.remove("done"); }, 1800);
    });
  });

  document.getElementById("openWebClassBtn").addEventListener("click", () => {
    window.open("https://webclass.tcu.ac.jp/", "_blank", "noopener");
  });

  // 目次のスクロール位置に合わせてハイライト
  const links = Array.from(document.querySelectorAll(".toc a"));
  const map = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          links.forEach((a) => a.classList.remove("active"));
          map.get(entry.target.id)?.classList.add("active");
        }
      });
    }, { rootMargin: "-30% 0px -60% 0px" });
    map.forEach((_, id) => { const el = document.getElementById(id); if (el) observer.observe(el); });
  }
})();
