#!/usr/bin/env python3
"""
Render docs/ux-test-results.{json,md} from the Playwright JSON report of a full suite run.

  python3 scripts/render-ux-results.py [packages/e2e/results/results.json]

Scenario ids come from each test title (AZ-xxx / TM-xxx); titles and personas come from
docs/ux-test-scenarios.json, so the table always matches the scenario catalogue. The prose
sections live in this file so the document can be regenerated from a later run.
"""
import json, os, re, sys, subprocess
from collections import OrderedDict, Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'packages/e2e/results/results.json')
SCEN = json.load(open(os.path.join(ROOT, 'docs/ux-test-scenarios.json')))
BY_ID = {s['id']: s for s in SCEN}
META = json.load(open(os.path.join(ROOT, 'docs/ux-test-results.meta.json')))

PERSONA_MAP = [('Visitor', 'Visitor'), ('Knowledge creator', 'Creator'), ('Node operator', 'Operator'),
               ('AI agent', 'Agent'), ('Cross-cutting', 'Cross-cutting'), ('Teach mode', 'Teach mode')]
ORDER = ['Visitor', 'Creator', 'Operator', 'Agent', 'Cross-cutting']


def persona_of(sid):
    p = BY_ID.get(sid, {}).get('persona', '')
    for pre, short in PERSONA_MAP:
        if p.startswith(pre):
            return short
    return p or '—'


def specs(node):
    for s in node.get('suites', []) or []:
        yield from specs(s)
    for sp in node.get('specs', []) or []:
        yield sp


def dur(ms):
    if not ms:
        return ''
    if ms < 1000:
        return '%d ms' % ms
    if ms < 90_000:
        return '%.1f s' % (ms / 1000)
    return '%.1f min' % (ms / 60000)


def collect(report_path):
    rep = json.load(open(report_path))
    rows = {}
    for su in rep.get('suites', []):
        for sp in specs(su):
            m = re.match(r'(AZ-\d{3}|TM-\d{3})', sp['title'])
            if not m:
                continue
            sid = m.group(1)
            for t in sp['tests']:
                status = t.get('status')
                results = t.get('results') or []
                ms = sum(r.get('duration', 0) for r in results)
                anns = [a for r in results for a in (r.get('annotations') or [])]
                notes = [a['description'] for a in anns if a.get('type') == 'note' and a.get('description')]
                skips = [a['description'] for a in anns if a.get('type') == 'skip' and a.get('description')]
                proj = t.get('projectName', '')
                st = {'expected': 'passed', 'flaky': 'passed', 'unexpected': 'failed', 'skipped': 'skipped'}.get(status, status)
                note = ' · '.join(notes)
                if status == 'flaky':
                    note = (note + ' · ' if note else '') + 'flaky: passed on retry (%s)' % proj
                if st == 'skipped':
                    note = (note + ' · ' if note else '') + 'skipped [%s]: %s' % (proj, skips[0] if skips else 'no reason given')
                cur = rows.get(sid)
                if cur is None:
                    rows[sid] = {'id': sid, 'status': st, 'duration_ms': int(ms), 'note': note}
                else:
                    cur['duration_ms'] += int(ms)
                    if st == 'failed':
                        cur['status'] = 'failed'
                    elif cur['status'] == 'skipped' and st == 'passed':
                        cur['status'] = 'passed'
                    if note:
                        cur['note'] = (cur['note'] + ' · ' if cur['note'] else '') + note
    hundred, teach = OrderedDict(), OrderedDict()
    for sid in sorted(rows):
        n = int(sid.split('-')[1])
        (hundred if sid.startswith('AZ-') and n <= 100 else teach)[sid] = rows[sid]
    return hundred, teach


def main():
    hundred, teach = collect(REPORT)
    missing = ['AZ-%03d' % i for i in range(1, 101) if 'AZ-%03d' % i not in hundred]
    counts = Counter(v['status'] for v in hundred.values())
    passed, failed = counts.get('passed', 0), counts.get('failed', 0)
    blocked = counts.get('skipped', 0) + len(missing)
    for sid in missing:
        hundred[sid] = {'id': sid, 'status': 'blocked', 'duration_ms': 0, 'note': 'not executed in this run'}
    hundred = OrderedDict(sorted(hundred.items()))
    summary_text = '%d passed / %d failed / %d blocked of 100' % (passed, failed, blocked)

    per = {p: Counter() for p in ORDER}
    for sid, r in hundred.items():
        per.setdefault(persona_of(sid), Counter())[r['status']] += 1

    fixes = subprocess.run(['git', 'log', '--oneline', META['fix_range']], cwd=ROOT, capture_output=True, text=True).stdout.strip().split('\n')

    out_json = {
        'date': META['date'], 'summary': {'passed': passed, 'failed': failed, 'blocked': blocked, 'total': 100, 'text': summary_text},
        'environment': META['environment'], 'items': list(hundred.values()),
        'teach_items': list(teach.values()), 'teach_runs': META['teach_runs'],
        'product_fixes': fixes, 'not_covered': META['not_covered'], 'notes': META['notes'],
    }
    with open(os.path.join(ROOT, 'docs/ux-test-results.json'), 'w') as f:
        json.dump(out_json, f, ensure_ascii=False, indent=1)
        f.write('\n')

    L = ['# UX scenario test results', '']
    for k, v in META['environment'].items():
        L.append('- **%s:** %s' % (k, v))
    L += ['', '## Summary', '', '**%s**' % summary_text, '',
          '| Persona | Passed | Failed | Blocked |', '|---|---|---|---|']
    for p in ORDER:
        c = per[p]
        L.append('| %s | %d | %d | %d |' % (p, c.get('passed', 0), c.get('failed', 0), c.get('skipped', 0) + c.get('blocked', 0)))
    L += ['', '## All scenarios', '', '| Id | Title | Persona | Status | Duration | Note |', '|---|---|---|---|---|---|']
    for sid, r in hundred.items():
        title = BY_ID.get(sid, {}).get('title', '').replace('|', '\\|')
        L.append('| %s | %s | %s | %s | %s | %s |' % (sid, title, persona_of(sid), {'passed': 'PASS', 'failed': 'FAIL', 'skipped': 'BLOCKED', 'blocked': 'BLOCKED'}.get(r['status'], r['status'].upper()), dur(r['duration_ms']), r['note'].replace('|', '\\|')))
    L += ['', '## Teach-mode scenarios (AZ-101…AZ-122, TM-*) — not part of the 100', '']
    L += META['teach_prose'] + ['', '| Node | Result |', '|---|---|']
    for row in META['teach_runs']:
        L.append('| %s | %s |' % (row['node'], row['result']))
    L += ['', '| Id | Title | Status | Duration | Note |', '|---|---|---|---|---|']
    for sid, r in teach.items():
        title = BY_ID.get(sid, {}).get('title', META.get('tm_titles', {}).get(sid, '')).replace('|', '\\|')
        L.append('| %s | %s | %s | %s | %s |' % (sid, title, {'passed': 'PASS', 'failed': 'FAIL', 'skipped': 'SKIPPED'}.get(r['status'], r['status'].upper()), dur(r['duration_ms']), r['note'].replace('|', '\\|')))
    L += ['', '## Audit findings from the previous green run', '',
          'Sixteen findings from a review of the previous pass. Fifteen were real and are fixed; the one rejection is',
          'spelled out in the last column.', '',
          '| Finding | Severity | What was wrong | What was done |', '|---|---|---|---|']
    for fid, sev, what, done in META['findings']:
        L.append('| %s | %s | %s | %s |' % (fid, sev, what.replace('|', '\\|'), done.replace('|', '\\|')))
    L += ['', '## What is not covered', ''] + META['not_covered_prose']
    L += ['', '## Notes from this pass', ''] + META['notes_prose']
    L += ['', '## Product fixes made during this effort (`git log --oneline %s`)' % META['fix_range'], '']
    for group in META['fix_groups']:
        L += ['**%s**' % group['title'], '']
        for sha in group['shas']:
            line = next((f for f in fixes if f.startswith(sha)), sha)
            L.append('- `%s` %s' % (line.split(' ', 1)[0], line.split(' ', 1)[1] if ' ' in line else ''))
        L.append('')
    known = {s for g in META['fix_groups'] for s in g['shas']}
    rest = [f for f in fixes if f.split(' ', 1)[0] not in known]
    if rest:
        L += ['**Everything else in the range**', '']
        for f in rest:
            L.append('- `%s` %s' % (f.split(' ', 1)[0], f.split(' ', 1)[1] if ' ' in f else ''))
        L.append('')
    with open(os.path.join(ROOT, 'docs/ux-test-results.md'), 'w') as f:
        f.write('\n'.join(L).rstrip() + '\n')
    print(summary_text, '· teach ids:', len(teach), '· missing:', missing or 'none')


if __name__ == '__main__':
    main()
