"""Check that a runtime-only asset cannot disappear from the archive unnoticed."""
import importlib.util
from html.parser import HTMLParser
from pathlib import Path

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("package_builder", root / "scripts/package_extension.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
builder.validate_package_files()
class Images(HTMLParser):
    def __init__(self):
        super().__init__()
        self.sources = []
    def handle_starttag(self, tag, attrs):
        if tag == "img":
            attributes = dict(attrs)
            assert attributes.get("alt"), "Guide screenshots need descriptive alternatives"
            self.sources.append(attributes["src"])

for relative in ("src/welcome.html", "はじめにお読みください.html"):
    parser = Images()
    parser.feed((root / relative).read_text(encoding="utf8"))
    assert len(parser.sources) >= 2
    for src in parser.sources:
        image = ((root / relative).parent / src).resolve()
        assert image.is_relative_to(root) and image.is_file(), (relative, src)
        assert image.relative_to(root).as_posix() in builder.PACKAGE_FILES, src
builder.PACKAGE_FILES = tuple(path for path in builder.PACKAGE_FILES if path != "data/sample-user-overrides.json")
try:
    builder.validate_package_files()
    raise AssertionError("missing runtime example was accepted")
except ValueError as error:
    assert "data/sample-user-overrides.json" in str(error)
print("PASS: runtime-only package resources are required")
