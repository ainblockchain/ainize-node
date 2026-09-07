#!/usr/bin/env python3
"""Render docs/ux-test-scenarios.json into a self-contained HTML page (docs/ux-test-scenarios.html)
AND the Markdown companion (docs/ux-test-scenarios.md). The JSON is the single source of truth — edit it, then re-run.

Usage: python3 scripts/render-ux-scenarios.py [json] [html] [md]
The HTML page has: summary counts, persona/priority/area filters, free-text search, and one card per scenario
with steps / expected results / evidence. No external assets except Google Fonts.
The Markdown has the "How to use" intro (below), computed summary tables, and one section per scenario grouped by persona.
"""
import html
import json
import sys
from collections import Counter
from pathlib import Path

root = Path(__file__).resolve().parents[1]
src = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'docs' / 'ux-test-scenarios.json'
out = Path(sys.argv[2]) if len(sys.argv) > 2 else root / 'docs' / 'ux-test-scenarios.html'
out_md = Path(sys.argv[3]) if len(sys.argv) > 3 else root / 'docs' / 'ux-test-scenarios.md'
data = json.loads(src.read_text(encoding='utf-8'))
scen = data['scenarios'] if isinstance(data, dict) else data

personas = list(dict.fromkeys(s['persona'] for s in scen))   # first-appearance order (persona sections in the md)
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

# ---------------------------------------------------------------- Markdown companion
MD_INTRO = """# Ainize UX Test Scenarios ({n})

This document lists {n} user-experience test scenarios for **Ainize** (ai-nize = AI + -ize): a P2P marketplace where verified knowledge is plugged into an AI model. Every scenario is grounded in the current code (web routes, i18n dictionaries, node API, CLI, agent) and executable on the live demo. A machine-readable copy lives next to this file: `docs/ux-test-scenarios.json` (this file is generated from it by `scripts/render-ux-scenarios.py`).

## How to use

- **Live demo:** three nodes on one machine — `http://localhost:3402` (node-a: web UI + seller + verifier + serving), `http://localhost:3403` (node-b: verifier), `http://localhost:3404` (node-c: verifier + serving) — sharing a local AIN dev chain (`http://localhost:8081`, app `/apps/knowledge`) and one vLLM model server (`http://localhost:8000`, Qwen3.8-Flash-Next). Every node also serves the web UI.
- **Demo knowledge ids:** `krx-all-2761` (LISTED / "Verified"), `krx-all-2761-ep12`, `krx-all-2761-ep6`, `pixelplus-087600` (SUPERSEDED — the chip reads "Newer version: krx-all-2761" on Explore and the knowledge page, "Newer version available" where no successor id is passed; still purchasable and testable). Names shown in the UI are English (`KRX ticker codes for 2,761 listed companies (final)`, `Pixelplus ticker code (single fact)`, …). Right after a fresh cluster start the items are still ANNOUNCED/VERIFYING for a few minutes; most scenarios assume verification has finished (`GET /api/info` → `counts.listed = 1`).
- **Addresses are live values.** Node identities are regenerated by `scripts/cluster-restart.sh --fresh`. Read the node-a address from `GET http://localhost:3402/api/info` (`node.address`; at the time of writing `0xF7A9dE49902C95661AC6556D631e2B60a081A1F5`), node-b/node-c from `/api/nodes`. Detail URLs have the form `/<creator address>/<knowledge id>`; the page resolves by id, so an outdated address segment still renders.
- **Operator password flow:** the first visit to `/signing` on a node shows "Create the operator password" (`needsSetup`); afterwards it shows "Sign in to your node". The same password works for the CLI (`ainize login --password …`; the first CLI login also sets it). Visitors never need to sign in — the sign-in page says so, and `/new-patch` shows a public pre-screen when signed out.
- **Teach mode (AZ-101…AZ-122, TM-090/091):** run against a node with `teach.enabled: true` and `backend: 'stub'` (+ `stubOffline: true` when no model server is available) so no GPU job is ever started — e.g. the dev node `node packages/cli/dist/bin.js --home ~/.ainize-teach/node-t start` on `http://localhost:3412` (operator password `teach-pass`). Browser specs: `packages/e2e/tests/web-teach.spec.ts` (visitor flow) and `web-teach-operator.spec.ts` (landing / sign-in / pre-screen / Teaching tab): `AINIZE_URL=http://localhost:3412 AINIZE_PASS=teach-pass npx playwright test tests/web-teach*.spec.ts --project=web`.
- **CLI:** run `node packages/cli/dist/bin.js --home ~/.ainize-cluster/node-a …` from `/mnt/newdata/ainize/knowledge-marketplace` (or the globally installed `ainize`). The agent is `node packages/agent/dist/bin.js`. Node 24: `export PATH="$HOME/.local/node/bin:$PATH"`.
- **Currency and quota:** prices are shown in AIN (local dev chain; fund test accounts with `ainize chain fund <address> <amount>`). Anonymous live tests are limited to 20 per IP per hour; operators are unlimited.
- **Language:** English is the default UI language; the header button `한국어` switches to Korean (persisted in `localStorage.ainize.locale`). All quoted UI strings are the English (`en`) values of `packages/web/src/i18n/**`.
- **Format:** each scenario has an id (`AZ-001`…`AZ-122`, plus `TM-090`/`TM-091` filed by the multi-knowledge work), persona, imperative title, goal, priority (P0 must-pass / P1 important / P2 nice-to-have), area, automation hint (manual / api / cli / e2e), preconditions, numbered steps, observable expected results and evidence (source files / dictionary keys). Scenarios are ordered by persona, then priority.

## Summary

"""

def md_section(s):
    o = [f"### {s['id']} - {s['title']}\n\n**Goal:** {s['goal']}\n\n**Priority:** {s['priority']} - **Area:** {s['area']} - **Automation:** {s['automation']}\n\n**Preconditions**\n\n"]
    o.append(''.join(f"- {p}\n" for p in s['preconditions']) or '- —\n')
    o.append("\n**Steps**\n\n" + ''.join(f"{i + 1}. {p}\n" for i, p in enumerate(s['steps'])))
    o.append("\n**Expected**\n\n" + ''.join(f"- {p}\n" for p in s['expected']))
    o.append("\n**Evidence**\n\n" + ''.join(f"- `{p}`\n" for p in s['evidence']))
    return ''.join(o)

def render_md():
    parts = [MD_INTRO.format(n=len(scen))]
    parts.append('| Persona | Count | P0 | P1 | P2 |\n|---|---:|---:|---:|---:|\n')
    for p in personas:
        ps = [s for s in scen if s['persona'] == p]
        c = Counter(s['priority'] for s in ps)
        parts.append(f"| {p} | {len(ps)} | {c.get('P0', 0)} | {c.get('P1', 0)} | {c.get('P2', 0)} |\n")
    parts.append(f"| **Total** | **{len(scen)}** | **{prio.get('P0', 0)}** | **{prio.get('P1', 0)}** | **{prio.get('P2', 0)}** |\n\n")
    parts.append('| Area | Count |\n|---|---:|\n')
    area_counts = Counter(s['area'] for s in scen)
    for a, n in sorted(area_counts.items(), key=lambda kv: (-kv[1], kv[0])):
        parts.append(f'| {a} | {n} |\n')
    parts.append('\n| Automation | Count |\n|---|---:|\n')
    for a, n in sorted(auto.items(), key=lambda kv: (-kv[1], kv[0])):
        parts.append(f'| {a} | {n} |\n')
    parts.append('\n')
    for p in personas:
        parts.append(f"## {p}\n\n" + '\n'.join(md_section(s) for s in scen if s['persona'] == p) + '\n')
    return ''.join(parts).rstrip('\n') + '\n'

out_md.write_text(render_md(), encoding='utf-8')
print(f'wrote {out_md} ({len(scen)} scenarios, {out_md.stat().st_size // 1024} KB)')
