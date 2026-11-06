#!/usr/bin/env python3
"""Cache the cells in official correction notices, preserving source order.

dedupe_chars handles the double-printed text in Yokohama spring page 6.
"""
import json
from pathlib import Path
import pdfplumber

ROOT=Path(__file__).resolve().parents[1]
CACHE=ROOT/'tmp/timetable-sources'
if __name__=='__main__':
    catalog=json.loads((ROOT/'scripts/timetable-sources-2026.json').read_text(encoding='utf-8'))
    for source in catalog['sources']:
        if source['type']!='changes':
            continue
        rows=[]
        with pdfplumber.open(CACHE/(source['id']+'.pdf')) as document:
            for number,page in enumerate(document.pages,1):
                for table in page.dedupe_chars().extract_tables():
                    for row in table:
                        rows.append({'page':number,'cells':row})
        (CACHE/(source['id']+'-rows.json')).write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print(source['id'],len(rows))
