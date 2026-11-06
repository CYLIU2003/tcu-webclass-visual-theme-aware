#!/usr/bin/env python3
"""Build the extension dataset from cached official PDFs and correction cells.

No enrollment data is used. Every imported course has page-level provenance.
The spring books' provisional fall rows are archived, not merged into the
September books. Run the fetch and both extract scripts before this builder.
"""
from __future__ import annotations
from collections import Counter
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import unicodedata

ROOT=Path(__file__).resolve().parents[1]
CACHE=ROOT/'tmp/timetable-sources'
CODE=re.compile(r'\b[sy][a-z]{2,3}\d{4,6}\b')
DAYS='月火水木金土日'

def read(path):
    return json.loads(path.read_text(encoding='utf-8'))

def write(path,value):
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

def norm(text):
    return unicodedata.normalize('NFKC',text or '').strip()

def compact(text):
    return re.sub(r'\s+','',norm(text))

def unwrap(text):
    lines=norm(text).splitlines()
    result=''
    for line in lines:
        line=line.strip()
        if result and line and result[-1].isascii() and result[-1].isalpha() and line[0].isascii() and line[0].isalpha():
            result+=' '
        result+=line
    return result

def unique(items):
    return list(dict.fromkeys(items))

def teachers(text,comma=False):
    if comma:
        return unique([unwrap(v).strip(' 、,') for v in re.split('[,、]',norm(text)) if v.strip(' \n、,')])
    result=[]
    for line in norm(text).splitlines():
        line=line.strip()
        if not line or line in ('-','―','未定'):
            continue
        # A short continuation of a katakana name (e.g. アブドラ ノルハヤ / ティ).
        if result and not re.search(r'\s',line) and re.fullmatch(r'[ァ-ヶー・A-Za-z]+',line) and re.search('[ァ-ヶ]',result[-1]):
            result[-1]+=line
        else:
            result.append(line)
    return unique(result)

def rooms(text):
    text=norm(text)
    if text in ('','-','―','未定','未定※'):
        return []
    lines=text.splitlines()
    if len(lines)>1 and all(re.fullmatch(r'\d{1,2}[A-Z]{1,2}',v) for v in lines):
        return unique(lines)
    return unique([v.strip() for v in re.split('[、・,／/]',unwrap(text)) if v.strip()])

def semester(term):
    if term.startswith('前'): return '前期'
    if term.startswith('後'): return '後期'
    if '通年' in term: return '通年'
    raise ValueError(f'Unknown term: {term!r}')

def source_priority(source,code):
    if source['level']=='学部':
        return 100 if ('setagaya' in source['id'])==(code[0]=='s') else 50
    if code.startswith('sm'):
        return 100 if 'science' in source['id'] else 70 if 'urban' in source['id'] else 50
    if code.startswith('ym'):
        return 100 if 'data' in source['id'] and code[4:6]=='21' else 90 if 'environment' in source['id'] else 60
    return 50

def source_ref(source,page):
    return {'id':source['id'],'document':source['document'],'url':source['url'],'pages':[page]}

def add_source(refs,ref):
    existing=next((r for r in refs if r['id']==ref['id']),None)
    if existing: existing['pages']=sorted(set(existing['pages']+ref['pages']))
    else: refs.append(deepcopy(ref))

def parse_slots(text):
    text=norm(text).replace('曜日','').replace('曜','')
    slots=[]
    for match in re.finditer(r'([月火水木金土日])\s*([1-9](?![0-9A-Za-z])(?:\s*[・、,]\s*[1-9](?![0-9A-Za-z]))*)',text):
        slots.extend((match[1],int(n)) for n in re.findall('[1-9]',match[2]))
    return unique(slots)

def build_changes(catalog):
    changes=[]
    for source in catalog:
        if source['type']!='changes': continue
        previous=None; headers=None
        for item in read(CACHE/(source['id']+'-rows.json')):
            cells=item['cells']
            if any(c and '講義コード' in c for c in cells):
                headers=cells; previous=None; continue
            if source['id'].startswith(('changes-ug-setagaya','changes-grad-science')):
                if len(cells)!=9 or not CODE.search(cells[5] or ''): continue
                date,department,term,slots,name,codes,teacher,field,content=cells
                change={'date':date,'termBlock':term,'slots':slots,'name':unwrap(name),'teacher':teacher,'field':field or '', 'before':'','after':content or ''}
            else:
                if not headers or len(cells)!=len(headers): continue
                ci=next(i for i,h in enumerate(headers) if h and '講義コード' in h)
                codes=cells[ci]
                # Vertically merged correction cells inherit values within their table only.
                if codes is None and previous: codes=previous.get('codes')
                if not CODE.search(codes or ''): continue
                ni=ci+1; ti=next((i for i,h in enumerate(headers) if h and '担当' in h),ni+1)
                fi=next((i for i,h in enumerate(headers) if h and ('変更箇' in h or '開講期' in h)),ti+1)
                before=cells[-2]; after=cells[-1]
                field=cells[fi]
                if previous:
                    field=previous['field'] if field is None else field
                    before=previous['before'] if before is None else before
                    after=previous['after'] if after is None else after
                name=unwrap(''.join(v or '' for v in cells[ni:ti]))
                change={'date':'','termBlock':'','slots':'','name':name or (previous['name'] if previous else ''),'teacher':cells[ti] or '', 'field':field or '', 'before':before or '', 'after':after or ''}
                previous={**change,'codes':codes}
            for code in CODE.findall(codes):
                changes.append({**change,'courseCode':code,'source':source_ref(source,item['page'])})
    return changes

def apply_change(course,change):
    """Apply changed fields; retain original notice text for conditional exceptions."""
    field=change['field']; before=norm(change['before']); after=norm(change['after'])
    content=after
    if '→' in after and not before:
        before,after=[v.strip() for v in after.split('→',1)]
    schedule_before,schedule_after=before,after
    status=[]
    if '非開講' in content or '開講中止' in content:
        return ['withdrawn']
    if '科目名' == field:
        if course['courseName']!=unwrap(after):
            course['aliases']=unique(course['aliases']+[course['courseName']])
            course['courseName']=unwrap(after)
        status.append('name')
    if '担当' in field:
        if '開講期' in field and '\n' in content:
            before,after=[v.strip() for v in content.splitlines()[-1].split('→',1)]
        elif field.count('変更')>1 and '→' in content:
            before,after=[v.strip() for v in content.split('→',1)]
            before=before.splitlines()[-1]
        # Teacher changes use set differences; this keeps newer additions in fall books.
        if '削除' in after and '→' not in after:
            removed=re.sub(r'(教授|講師)?を?削除','',after).strip()
            course['instructors']=[t for t in course['instructors'] if compact(t)!=compact(removed)]
        else:
            addition='追加' in field or '追加' in after
            old=teachers(before,comma=True)
            new=teachers(after.replace('追加',''),comma=True)
            new=[n for n in new if n not in ('未定','-','―')]
            old_keys={compact(t) for t in old}; new_keys={compact(t) for t in new}
            if addition:
                keep=course['instructors']
                extra=new
            else:
                keep=[t for t in course['instructors'] if compact(t) not in old_keys-new_keys]
                extra=[t for t in new if compact(t) not in old_keys or not keep]
            seen={compact(t) for t in keep}
            course['instructors']=keep+[t for t in extra if compact(t) not in seen]
        status.append('teachers')
        before,after=schedule_before,schedule_after
    if any(token in field for token in ('曜日','時限','開講期')) and ('→' in content or change['before']):
        new_slots=parse_slots(after)
        old_slots=parse_slots(before)
        if '集中' in after:
            course['meetings']=[]
            course['rooms']=[]
            course['termBlocks']=['後集中' if '後' in after else '前集中']
        elif new_slots and ('曜日' in field or '時限' in field):
            current=course['meetings']; exemplar=deepcopy(current[0]) if current else None
            if exemplar:
                course['meetings']=[]
                for day,period in new_slots:
                    exact=next((m for m in current if (m['day'],m['period'])==(day,period)),exemplar)
                    meeting=deepcopy(exact); meeting.update(day=day,period=period)
                    add_source(meeting['sources'],change['source']); course['meetings'].append(meeting)
        elif re.fullmatch(r'[1-9]時限',after):
            for meeting in course['meetings']: meeting['period']=int(after[0])
        status.append('schedule')
    if '教室' in field:
        # Multiple day/quarter-specific clauses remain distinct; never union rooms
        # from different weekdays into every meeting.
        room_content=(change['before']+' → '+content) if change['before'] else content
        clauses=re.split(r'\n|[、,](?=[^、,\n]*→)',room_content)
        carry_slot=None
        for line in clauses:
            line=norm(line)
            if '→' not in line:
                ds=parse_slots(line)
                if ds: carry_slot=ds
                continue
            left,right=line.split('→',1)
            day_match=re.search('([月火水木金土日])曜',left)
            day=day_match[1] if day_match else None
            slot=parse_slots(left)
            q=re.search(r'\(([1-4])Q\)',right)
            term= {'1':'前期前','2':'前期後','3':'後期前','4':'後期後'}.get(q[1]) if q else None
            if '第3Q' in field: term='後期前'
            old_room=re.sub(r'^.*[:：]','',left)
            old_room=re.sub(r'教室$','',old_room.strip()).strip()
            new_room=re.sub(r'\([1-4]Q\)','',right).strip()
            new_room=re.sub(r'教室$','',new_room)
            # PBL教室 is its actual name, not a redundant suffix.
            if right.strip().startswith('PBL教室'): new_room='PBL教室'
            new_rooms=rooms(new_room)
            for meeting in list(course['meetings']):
                if day and meeting['day']!=day: continue
                if (slot or carry_slot) and (meeting['day'],meeting['period']) not in (slot or carry_slot): continue
                if term and meeting['termBlock'] not in (term,'前期' if term.startswith('前') else '後期'): continue
                old_values=rooms(old_room)
                # A correction notice for this semester is authoritative even
                # when its "before" cell contains a typo. Older spring notices
                # may also mention fall; do not revert a newer fall book.
                if change['source']['id'].endswith('spring') and '後期' in course['semesters'] and old_values and not set(old_values).intersection(meeting['rooms']):
                    continue
                if term and meeting['termBlock']!=term:
                    half=deepcopy(meeting); half['termBlock']=term
                    other=deepcopy(meeting); other['termBlock']=term[:2]+('後' if term.endswith('前') else '前')
                    course['meetings'].remove(meeting); course['meetings'] += [half,other]; meeting=half
                updated=[]
                if set(old_values).intersection(meeting['rooms']):
                    for previous in meeting['rooms']:
                        updated.extend(new_rooms if previous in old_values else [previous])
                    updated=unique(updated)
                else:
                    updated=new_rooms
                meeting['rooms']=updated; meeting['room']=' / '.join(updated)
                add_source(meeting['sources'],change['source'])
        status.append('rooms')
    if not status: status.append('notice')
    course['notes']=unique(course['notes']+[f"{change['date']} {field}: {content}".strip()])
    course.setdefault('changes',[]).append(change)
    add_source(course['sources'],change['source'])
    return status

def main():
    catalog=read(ROOT/'scripts/timetable-sources-2026.json')
    config=read(ROOT/'scripts/timetable-config-2026.json')
    labels={d['code']:d['label'] for d in config['departments']}
    courses={}; diagnostics=[]; source_docs=[]; archived=[]; selected=[]; cross_listings=[]
    priorities={}
    for info in catalog['sources']:
        if info['type']!='timetable': continue
        for row in read(CACHE/(info['id']+'-cells.json'))['rows']:
            sem=semester(norm(row['cells'][3]))
            if sem!=info['semester'] and sem!='通年': continue
            key=(row['code'],sem)
            priorities[key]=max(priorities.get(key,0),source_priority(info,row['code']))
    for info in catalog['sources']:
        source=deepcopy(info)
        source['document']=f"2026年度 {info['group']} {info['semester']} {'授業時間表' if info['type']=='timetable' else '変更一覧'}"
        source['fileName']=info['url'].split('/')[-1]
        source['sha256']=hashlib.sha256((CACHE/(info['id']+'.pdf')).read_bytes()).hexdigest()
        source_docs.append(source)
        if info['type']!='timetable': continue
        raw=read(CACHE/(info['id']+'-cells.json'))
        if raw['sha256']!=source['sha256']:
            raise ValueError(f"PDF changed; run extract-timetables.py again: {info['id']}")
        source['pageCount']=raw['pageCount']
        source['pagesUsed']=sorted(set(r['page'] for r in raw['rows']))
        selected_codes=set(); archived_codes=set()
        for row in raw['rows']:
            cells=row['cells']; term=norm(cells[3]); sem=semester(term)
            if sem!=info['semester'] and sem!='通年':
                archived_codes.add(row['code']); archived.append({'source':info['id'],**row}); continue
            selected_codes.add(row['code']); selected.append({'source':info['id'],**row})
            if source_priority(info,row['code'])<priorities[(row['code'],sem)]:
                cross_listings.append({'source':info['id'],**row}); continue
            department,day,period,_,year,klass,name,teacher,code,room,target,note,*nine=cells
            if code!=row['code']: raise ValueError(f'Merged code cell {row}')
            name=unwrap(name); code=code.lower()
            if not name: raise ValueError(f'Empty course name {code}')
            campus='横浜キャンパス' if code.startswith('y') else '世田谷キャンパス'
            if '渋谷サテライト' in unwrap(room) or '共同原子力' in target: campus='渋谷サテライト'
            ref=source_ref(source,row['page'])
            course=courses.setdefault(code,{'academicYear':2026,'courseCode':code,'courseName':name,'aliases':[], 'instructors':[], 'level':info['level'],'semester':sem,'semesters':[],'termBlock':term,'termBlocks':[], 'campuses':[], 'departments':[], 'category':'専門科目','scheduleTypes':[], 'meetings':[],'rooms':[],'notes':[],'source':deepcopy(ref),'sources':[]})
            if name!=course['courseName']: course['aliases']=unique(course['aliases']+[name])
            course['instructors']=unique(course['instructors']+teachers(teacher))
            course.setdefault('grades',[]); course['grades']=unique(course['grades']+[unwrap(year)])
            course.setdefault('classes',[]); course['classes']=unique(course['classes']+[unwrap(klass)] if klass else course['classes'])
            course['semesters']=unique(course['semesters']+[sem]); course['termBlocks']=unique(course['termBlocks']+[term])
            course['campuses']=unique(course['campuses']+[campus])
            dep={'code':unwrap(department),'label':labels.get(unwrap(department),unwrap(department)), 'sourceGroup':info['group']}
            if dep not in course['departments']: course['departments'].append(dep)
            course['category']='実験・演習' if re.search('実験|演習|実習',name) else ('基礎科目' if department=='共通' or re.search('数学|積分学|物理学|英語|English|Communication|Reading|Writing',name) else '専門科目')
            course['notes']=unique(course['notes']+[unwrap(note)] if note else course['notes'])
            if target: course.setdefault('enrollmentNotes',[]); course['enrollmentNotes']=unique(course['enrollmentNotes']+[unwrap(target)])
            course['rooms']=unique(course['rooms']+rooms(room))
            add_source(course['sources'],ref)
            add_source([course['source']],ref) if course['source']['id']==ref['id'] else None
            if day in DAYS and day and period.isdigit() and '集中' not in term:
                meeting={'day':day,'period':int(period),'termBlock':term,'room':' / '.join(rooms(room)), 'rooms':rooms(room), 'campus':campus,'timeProfile':'joint-nuclear' if '共同原子力' in target else 'standard', 'startsAtNine':any(norm(v) in ('〇','○','◯') for v in nine),'sources':[deepcopy(ref)]}
                same=next((m for m in course['meetings'] if all(m[k]==meeting[k] for k in ('day','period','termBlock','room','campus'))),None)
                if same: add_source(same['sources'],ref)
                else: course['meetings'].append(meeting)
        found={r['code'] for r in raw['rows']}
        missing=sorted(set(raw['inventory'])-found)
        if missing: raise ValueError(f'Unparsed courses in {info["id"]}: {missing}')
        diagnostics.append({'source':info['id'],'pageCount':raw['pageCount'],'pagesUsed':source['pagesUsed'],'rawOccurrences':len(raw['rows']), 'inventoryCodes':raw['inventory'],'selectedCodes':sorted(selected_codes),'provisionalCodes':sorted(archived_codes),'unparsedCodes':missing})
    changes=build_changes(source_docs)
    withdrawn={}; absent_changes=[]
    for change in changes:
        code=change['courseCode']; course=courses.get(code)
        if not course and change['after']=='追加' and change['field']=='―':
            ref=change['source']; sem='前期' if code[1]=='a' else '後期'
            course={'academicYear':2026,'courseCode':code,'courseName':change['name'],'aliases':[], 'instructors':teachers(change['teacher']), 'level':'学部','semester':sem,'semesters':[sem], 'termBlock':sem,'termBlocks':[sem], 'campuses':['横浜キャンパス'], 'departments':[{'code':'変更一覧','label':'変更一覧の追加科目','sourceGroup':'横浜キャンパス・学部'}], 'category':'専門科目','scheduleTypes':['irregular'],'meetings':[], 'rooms':[], 'notes':['変更一覧で追加。固定曜日・時限・教室の記載なし。'],'source':deepcopy(ref),'sources':[deepcopy(ref)]}
            courses[code]=course
        if not course:
            change['status']=['absent-from-current-books']; absent_changes.append(change); continue
        change['status']=apply_change(course,change)
        if 'withdrawn' in change['status']:
            course['withdrawal']=change; withdrawn[code]=courses.pop(code)
    # Self-reference must not be inserted into the change object when serializing.
    for course in courses.values():
        course['meetings'].sort(key=lambda m:(DAYS.index(m['day']),m['period'],m['termBlock'],m['room']))
        course['termBlocks']=unique(m['termBlock'] for m in course['meetings']) or course['termBlocks']
        course['semester']=' / '.join(course['semesters']); course['termBlock']=' / '.join(course['termBlocks'])
        if course['meetings']: course['rooms']=unique(r for m in course['meetings'] for r in m['rooms'])
        course['scheduleTypes']=(['regular'] if course['meetings'] else [])+(['intensive'] if any('集中' in t for t in course['termBlocks']) else [])+(['all-year'] if '通年' in course['semesters'] else [])
        if not course['scheduleTypes']: course['scheduleTypes']=['irregular']
        if course['courseCode']=='sba005510': course['aliases']=unique(course['aliases']+['ことづくり','ことづくり/ことづくり(1)'])
    result=sorted(courses.values(),key=lambda c:c['courseCode'])
    summary={'uniqueCourses':len(result),'rawOccurrences':sum(d['rawOccurrences'] for d in diagnostics), 'selectedOccurrences':len(selected),'sourceDocuments':len(source_docs),'timetableDocuments':len(diagnostics), 'timetablePages':sum(len(d['pagesUsed']) for d in diagnostics), 'unparsedCodes':[], 'withdrawnCourses':len(withdrawn),'withoutInstructor':[c['courseCode'] for c in result if not c['instructors']], 'withoutMeetings':[c['courseCode'] for c in result if not c['meetings']], 'withoutRoom':[c['courseCode'] for c in result if not c['rooms']], 'correctionRows':len(changes),'correctionsAbsentFromCurrentBooks':absent_changes}
    departments=[]
    for course in result:
        for dep in course['departments']:
            if dep not in departments: departments.append(dep)
    dataset={'schemaVersion':2,'dataset':{'id':'tcu-2026-all-departments-timetable','title':'2026年度 東京都市大学 公開授業時間表','academicYear':2026,'semesters':['前期','後期','通年'],'sourceType':'official-timetable-pdfs','generatedAt':catalog['checkedAt'],'verifiedAt':catalog['checkedAt'],'scope':{'levels':['学部','大学院'],'campuses':unique(v for c in result for v in c['campuses']),'departments':departments, 'sourceDocuments':source_docs, **{k:summary[k] for k in ('uniqueCourses','rawOccurrences','timetablePages')}},'periodProfiles':config['periodProfiles']},'courses':result}
    write(ROOT/'data/timetable-2026.json',dataset)
    (ROOT/'data/timetable-2026.js').write_text('window.WCV_TIMETABLE = '+json.dumps(dataset,ensure_ascii=False,separators=(',',':'))+';\n',encoding='utf-8')
    standalone=ROOT/'demo/preview-standalone.html'
    if standalone.exists():
        embedded=json.dumps(dataset,ensure_ascii=False,separators=(',',':')).replace('<','\\u003c')
        html=standalone.read_text(encoding='utf-8')
        html,count=re.subn(r'^window\.WCV_TIMETABLE = [^\n]+;',lambda _: 'window.WCV_TIMETABLE = '+embedded+';',html,count=1,flags=re.M)
        if count!=1: raise ValueError('Standalone data marker is missing')
        standalone.write_text(html,encoding='utf-8')
    write(ROOT/'data/extraction-report.json',{'generatedAt':catalog['checkedAt'],'summary':summary,'sourceDiagnostics':diagnostics,'withdrawnCourses':list(withdrawn.values()),'secondaryListings':[{'courseCode':r['code'],'source':r['source'],'page':r['page'],'termBlock':r['cells'][3],'room':unwrap(r['cells'][9]),'instructors':teachers(r['cells'][7])} for r in cross_listings]})
    write(ROOT/'data/timetable-changes-2026.json',{'checkedAt':catalog['checkedAt'],'changes':changes})
    write(CACHE/'archived-provisional-rows.json',archived)
    print(json.dumps({**{k:v for k,v in summary.items() if not isinstance(v,list)},'withoutInstructor':len(summary['withoutInstructor']),'withoutMeetings':len(summary['withoutMeetings']),'withoutRoom':len(summary['withoutRoom']),'absentChanges':len(absent_changes)},ensure_ascii=False,indent=2))

if __name__=='__main__': main()
