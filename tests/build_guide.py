"""src/welcome.html から、CSS/JSを埋め込んだ単体ガイド『はじめにお読みください.html』を生成する。"""
import pathlib
ROOT = pathlib.Path(__file__).resolve().parents[1]
src = ROOT / "src"
html = (src / "welcome.html").read_text(encoding="utf-8")
css = (src / "welcome.css").read_text(encoding="utf-8")
js = (src / "welcome.js").read_text(encoding="utf-8")
html = html.replace('<link rel="stylesheet" href="welcome.css">', f"<style>\n{css}</style>")
html = html.replace('<script src="welcome.js"></script>', f"<script>\n{js}</script>")
(ROOT / "はじめにお読みください.html").write_text(html, encoding="utf-8")
print("generated")
