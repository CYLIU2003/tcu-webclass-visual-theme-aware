#!/usr/bin/env python3
"""Extract official timetable cells by geometry, including dotted row rules.

Run fetch-timetable-sources.py first. Results are cached by PDF SHA256. Unlike
newline-based table extraction, each column uses its own bounding rules, so
merged day/term cells and wrapped names/teachers/rooms retain their association.
"""
from __future__ import annotations
import bisect
from concurrent.futures import ProcessPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import re
import pdfplumber
import pypdfium2 as pdfium

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'tmp/timetable-sources'
CODE = re.compile(r'\b[sy][a-z]{2,3}[0-9]{4,6}\b')
VERSION = 1

def unique(values, tolerance=.7):
    result = []
    for value in sorted(values):
        if not result or value-result[-1] > tolerance:
            result.append(value)
    return result

def extract(source):
    path = CACHE / (source['id']+'.pdf')
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    output = CACHE / (source['id']+'-cells.json')
    if output.exists():
        previous = json.loads(output.read_text(encoding='utf-8'))
        if previous.get('sha256') == digest and previous.get('extractorVersion') == VERSION:
            return source['id'], previous
    inventory = []
    with pdfium.PdfDocument(path) as document:
        for number in range(len(document)):
            page=document[number]; textpage=page.get_textpage()
            inventory.append(sorted(set(CODE.findall(textpage.get_text_range()))))
            textpage.close(); page.close()
    rows=[]; diagnostics=[]
    with pdfplumber.open(path) as document:
        for number, raw_codes in enumerate(inventory):
            if not raw_codes:
                continue
            page=document.pages[number]
            words=page.extract_words(x_tolerance=1,y_tolerance=1)
            header=next((w for w in words if '講義コード' in w['text']),None)
            if not header:
                diagnostics.append({'page':number+1,'error':'missing header','missingCodes':raw_codes})
                page.close(); continue
            hy=(header['top']+header['bottom'])/2
            xs=unique([e['x0'] for e in page.edges if e['orientation']=='v' and e['top']<hy<e['bottom'] and e['bottom']-e['top']>3])
            if len(xs) not in (13,14):
                diagnostics.append({'page':number+1,'error':'unexpected columns','columns':xs,'missingCodes':raw_codes})
                page.close(); continue
            hedges=[e for e in page.edges if e['orientation']=='h' and (e['object_type']!='rect_edge' or e['width']>=e['height'])]
            column_chars=[]; column_rules=[]
            for a,b in zip(xs,xs[1:]):
                column_chars.append([c for c in page.chars if a<(c['x0']+c['x1'])/2<b])
                candidates={}
                for edge in hedges:
                    if edge['x0']<b-.3 and edge['x1']>a+.3:
                        key=round(edge['top']*2)/2
                        candidates[key]=candidates.get(key,0)+min(b,edge['x1'])-max(a,edge['x0'])
                column_rules.append(unique([k for k,v in candidates.items() if v>(b-a)*.25]))
            cell_cache={}
            def cell(column,y):
                rules=column_rules[column]; at=bisect.bisect_left(rules,y)
                top=rules[at-1] if at else 0
                bottom=rules[at] if at<len(rules) else page.height
                key=(column,top,bottom)
                if key not in cell_cache:
                    chars=[c for c in column_chars[column] if top<(c['top']+c['bottom'])/2<bottom]
                    cell_cache[key]=pdfplumber.utils.extract_text(chars,x_tolerance=1,y_tolerance=1)
                return cell_cache[key]
            found=set()
            for word in words:
                if not CODE.fullmatch(word['text']) or not xs[8]<word['x0']<xs[9]:
                    continue
                y=(word['top']+word['bottom'])/2
                cells=[cell(i,y) for i in range(len(xs)-1)]
                rows.append({'page':number+1,'y':round(y,2),'code':word['text'],'cells':cells})
                found.add(word['text'])
            diagnostics.append({'page':number+1,'uniqueCodes':len(raw_codes),'occurrences':sum(r['page']==number+1 for r in rows),'missingCodes':sorted(set(raw_codes)-found)})
            page.close()
    result={'extractorVersion':VERSION,'sha256':digest,'pageCount':len(inventory),'inventory':sorted(set(c for codes in inventory for c in codes)),'rows':rows,'pages':diagnostics}
    output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return source['id'],result

if __name__=='__main__':
    catalog=json.loads((ROOT/'scripts/timetable-sources-2026.json').read_text(encoding='utf-8'))
    with ProcessPoolExecutor(max_workers=4) as pool:
        pending=[pool.submit(extract,s) for s in catalog['sources'] if s['type']=='timetable']
        for future in as_completed(pending):
            name,result=future.result()
            missing=sorted(set(c for p in result['pages'] for c in p['missingCodes']))
            print(f"{name}: {len(result['inventory'])} codes, {len(result['rows'])} occurrences, missing {missing}",flush=True)
