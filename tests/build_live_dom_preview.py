#!/usr/bin/env python3
"""Build a self-contained sanitized WebClass preview from current extension data."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def javascript_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def main() -> None:
    html = (ROOT / "demo" / "preview-live-dom.html").read_text(encoding="utf-8")
    css = (ROOT / "src" / "content.css").read_text(encoding="utf-8")
    content_script = (ROOT / "src" / "content.js").read_text(encoding="utf-8")
    dataset = json.loads((ROOT / "data" / "timetable-2026.json").read_text(encoding="utf-8"))
    history = json.loads((ROOT / "data" / "historical-course-row-evidence.json").read_text(encoding="utf-8"))

    stylesheet_link = '<link href="../src/content.css" rel="stylesheet"/>'
    if stylesheet_link not in html:
        raise ValueError("content stylesheet link is missing from preview source")
    html = html.replace(stylesheet_link, f"<style>\n{css}\n</style>", 1)

    mock_script = f"""<script>
window.__WCV_DATASET__ = {javascript_json(dataset)};
window.__WCV_HISTORY__ = {javascript_json(history)};
window.__wcvStorageListeners = [];
window.chrome = {{
  storage: {{
    local: {{
      _values: {{enabled:true,restyle:true,modernizeNativeLayout:true,showInlineMetadata:true,showEnhancedTimetable:false,showSidebarTools:true,showFloatingPanel:true,showSourceLabel:true,debug:false,userCourses:[]}},
      get(defaults, callback) {{ callback(Object.assign({{}}, defaults || {{}}, this._values)); }},
      set(values, callback) {{
        const changes = {{}};
        for (const [key, newValue] of Object.entries(values || {{}})) {{
          changes[key] = {{oldValue:this._values[key],newValue}};
          this._values[key] = newValue;
        }}
        for (const listener of window.__wcvStorageListeners) listener(changes, 'local');
        if (callback) callback();
      }}
    }},
    onChanged: {{addListener(listener) {{window.__wcvStorageListeners.push(listener);}}}}
  }},
  runtime: {{getURL(path) {{return path;}},onMessage:{{addListener(){{}}}},openOptionsPage(){{}},lastError:null}}
}};
window.fetch = async function(url) {{
  const value = String(url);
  const payload = value.includes('historical-course-row-evidence.json')
    ? window.__WCV_HISTORY__
    : (value.includes('timetable-2026.json') ? window.__WCV_DATASET__ : null);
  return payload
    ? {{ok:true,status:200,json:async()=>payload}}
    : {{ok:false,status:404,json:async()=>({{}})}};
}};
</script>"""
    html, count = re.subn(
        r"<script>\s*window\.__wcvStorageListeners = \[\];.*?</script>",
        lambda _match: mock_script,
        html,
        count=1,
        flags=re.DOTALL,
    )
    if count != 1:
        raise ValueError("preview Chrome API stub was not found")

    source_tag = '<script defer="defer" src="../src/content.js"></script>'
    if source_tag not in html:
        raise ValueError("content script reference is missing from preview source")
    html = html.replace(source_tag, f"<script>\n{content_script}\n</script>", 1)
    (ROOT / "demo" / "preview-live-dom-standalone.html").write_text(html, encoding="utf-8")
    print("generated: demo/preview-live-dom-standalone.html")


if __name__ == "__main__":
    main()
