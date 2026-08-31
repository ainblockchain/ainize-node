#!/usr/bin/env python3
"""Render docs/ux-test-scenarios.json into a self-contained HTML page (docs/ux-test-scenarios.html).

Usage: python3 scripts/render-ux-scenarios.py [json] [html]
The page has: summary counts, persona/priority/area filters, free-text search, and one card per scenario
with steps / expected results / evidence. No external assets except Google Fonts.
"""
import html
import json
import sys
from collections import Counter
from pathlib import Path

root = Path(__file__).resolve().parents[1]
src = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'docs' / 'ux-test-scenarios.json'
out = Path(sys.argv[2]) if len(sys.argv) > 2 else root / 'docs' / 'ux-test-scenarios.html'
data = json.loads(src.read_text(encoding='utf-8'))
scen = data['scenarios'] if isinstance(data, dict) else data

personas = [p for p, _ in Counter(s['persona'] for s in scen).most_common()]
areas = sorted(Counter(s['area'] for s in scen))
prio = Counter(s['priority'] for s in scen)
auto = Counter(s['automation'] for s in scen)

def esc(x):
    return html.escape(str(x), quote=True)

def li(items):
    return ''.join(f'<li>{esc(i)}</li>' for i in items)

cards = []
for s in scen:
    cards.append(f'''
<article class="card" data-persona="{esc(s['persona'])}" data-priority="{esc(s['priority'])}" data-area="{esc(s['area'])}" data-auto="{esc(s['automation'])}" data-text="{esc((s['id'] + ' ' + s['title'] + ' ' + s['goal'] + ' ' + ' '.join(s['steps']) + ' ' + ' '.join(s['expected'])).lower())}">
  <header>
    <span class="id">{esc(s['id'])}</span>
    <h3>{esc(s['title'])}</h3>
    <span class="chip p-{esc(s['priority'])}">{esc(s['priority'])}</span>
    <span class="chip area">{esc(s['area'])}</span>
    <span class="chip auto">{esc(s['automation'])}</span>
  </header>
  <p class="goal">{esc(s['goal'])}</p>
  <div class="cols">
    <section><h4>Preconditions</h4><ul>{li(s['preconditions']) or '<li>—</li>'}</ul></section>
    <section><h4>Steps</h4><ol>{li(s['steps'])}</ol></section>
    <section><h4>Expected</h4><ul>{li(s['expected'])}</ul></section>
  </div>
  <footer><span class="persona">{esc(s['persona'])}</span><span class="evidence">{esc(' · '.join(s['evidence']))}</span></footer>
</article>''')

persona_buttons = ''.join(f'<button class="f" data-k="persona" data-v="{esc(p)}">{esc(p)} <b>{sum(1 for s in scen if s["persona"] == p)}</b></button>' for p in personas)
area_options = ''.join(f'<option value="{esc(a)}">{esc(a)}</option>' for a in areas)

page = f'''<title>Ainize UX Test Scenarios</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{{--bg:#f6f6f9;--surface:#fff;--line:#dcdbe6;--ink:#1e1d2a;--muted:#6b6a7a;--accent:#8b3eeb;--accent-soft:#f1e9fc;--p0:#b0392d;--p1:#a8731b;--p2:#2e7b4e;--chip:#eeedf4}}
@media (prefers-color-scheme: dark){{:root:not([data-theme="light"]){{--bg:#141320;--surface:#1c1b2a;--line:#2f2e40;--ink:#eae8f2;--muted:#9c9aae;--accent:#b891f5;--accent-soft:#2a2140;--chip:#26253a}}}}
:root[data-theme="dark"]{{--bg:#141320;--surface:#1c1b2a;--line:#2f2e40;--ink:#eae8f2;--muted:#9c9aae;--accent:#b891f5;--accent-soft:#2a2140;--chip:#26253a}}
*{{box-sizing:border-box}} body{{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 "IBM Plex Sans",system-ui,sans-serif}}
.wrap{{max-width:1180px;margin:0 auto;padding:40px 24px 96px}}
h1{{font-size:30px;margin:0 0 6px;letter-spacing:-.01em}} .lede{{color:var(--muted);max-width:76ch;margin:0 0 20px}}
.stats{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:6px;overflow:hidden;margin:0 0 24px}}
.stat{{background:var(--surface);padding:14px 16px}} .stat .k{{font-size:12px;color:var(--muted)}} .stat .v{{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}}
.filters{{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 20px;position:sticky;top:0;background:var(--bg);padding:12px 0;z-index:2;border-bottom:1px solid var(--line)}}
.f{{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:16px;padding:4px 12px;cursor:pointer;font:inherit;font-size:13px}} .f.on{{background:var(--accent);color:#fff;border-color:var(--accent)}} .f b{{font-weight:600;opacity:.7;margin-left:4px}}
select,input[type=search]{{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:6px;padding:6px 10px;font:inherit;font-size:13px}} input[type=search]{{min-width:240px;flex:1}}
.count{{color:var(--muted);font-size:13px;margin-left:auto}}
.card{{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:18px 20px;margin:0 0 14px}}
.card header{{display:flex;gap:10px;align-items:center;flex-wrap:wrap}} .card h3{{margin:0;font-size:16px;flex:1;min-width:240px}}
.id{{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--accent);background:var(--accent-soft);padding:2px 8px;border-radius:4px}}
.chip{{font-size:11px;font-weight:600;letter-spacing:.04em;padding:2px 8px;border-radius:10px;background:var(--chip);color:var(--muted)}}
.chip.p-P0{{color:#fff;background:var(--p0)}} .chip.p-P1{{color:#fff;background:var(--p1)}} .chip.p-P2{{color:#fff;background:var(--p2)}}
.goal{{margin:8px 0 12px;color:var(--muted)}}
.cols{{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}} .cols h4{{margin:0 0 4px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}}
.cols ul,.cols ol{{margin:0;padding-left:20px}} .cols li{{margin:2px 0}}
.card footer{{display:flex;gap:16px;justify-content:space-between;margin-top:12px;font-size:12px;color:var(--muted);flex-wrap:wrap}} .evidence{{font-family:"IBM Plex Mono",monospace;font-size:11px;word-break:break-all}}
.hidden{{display:none}}
</style>
<div class="wrap">
  <h1>Ainize UX Test Scenarios</h1>
  <p class="lede">{len(scen)} testable scenarios grounded in the real Ainize UI, CLI and API (English-first product). Each one names the exact screens, buttons, commands and expected strings; evidence points at the code or dictionary it came from. Live demo: http://localhost:3402 (web + API), CLI <code>ainize</code>.</p>
  <div class="stats">
    <div class="stat"><div class="k">Scenarios</div><div class="v">{len(scen)}</div></div>
    <div class="stat"><div class="k">P0 / P1 / P2</div><div class="v">{prio.get('P0',0)} / {prio.get('P1',0)} / {prio.get('P2',0)}</div></div>
    <div class="stat"><div class="k">Personas</div><div class="v">{len(personas)}</div></div>
    <div class="stat"><div class="k">Areas</div><div class="v">{len(areas)}</div></div>
    <div class="stat"><div class="k">Automatable (api/cli/e2e)</div><div class="v">{auto.get('api',0)+auto.get('cli',0)+auto.get('e2e',0)}</div></div>
  </div>
  <div class="filters" role="toolbar" aria-label="filters">
    <button class="f on" data-k="persona" data-v="">All personas</button>{persona_buttons}
    <select id="prio" aria-label="priority"><option value="">Any priority</option><option>P0</option><option>P1</option><option>P2</option></select>
    <select id="area" aria-label="area"><option value="">Any area</option>{area_options}</select>
    <select id="auto" aria-label="automation"><option value="">Any automation</option><option>manual</option><option>api</option><option>cli</option><option>e2e</option></select>
    <input id="q" type="search" placeholder="Search id, title, steps…" aria-label="search">
    <span class="count" id="count"></span>
  </div>
  {''.join(cards)}
</div>
<script>
(function(){{
  var persona='', cards=[].slice.call(document.querySelectorAll('.card'));
  var prio=document.getElementById('prio'), area=document.getElementById('area'), auto=document.getElementById('auto'), q=document.getElementById('q'), count=document.getElementById('count');
  function apply(){{
    var n=0, s=q.value.trim().toLowerCase();
    cards.forEach(function(c){{
      var ok=(!persona||c.dataset.persona===persona)&&(!prio.value||c.dataset.priority===prio.value)&&(!area.value||c.dataset.area===area.value)&&(!auto.value||c.dataset.auto===auto.value)&&(!s||c.dataset.text.indexOf(s)>=0);
      c.hidden=!ok; if(ok) n++;
    }});
    count.textContent=n+' / '+cards.length;
  }}
  document.querySelectorAll('.f').forEach(function(b){{ b.addEventListener('click',function(){{ document.querySelectorAll('.f').forEach(function(x){{x.classList.remove('on')}}); b.classList.add('on'); persona=b.dataset.v; apply(); }}); }});
  [prio,area,auto].forEach(function(el){{ el.addEventListener('change',apply); }}); q.addEventListener('input',apply);
  apply();
}})();
</script>
'''
out.write_text(page, encoding='utf-8')
print(f'wrote {out} ({len(scen)} scenarios, {out.stat().st_size // 1024} KB)')
