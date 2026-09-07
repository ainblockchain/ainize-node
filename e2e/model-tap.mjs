/**
 * Transparent logging reverse proxy in front of the demo serving model.
 *   :8012  →  http://localhost:8002   (the e2e vLLM instance; :8000 / :8001 are never touched)
 * Appends one JSON line per request to results/verify/model-wire.jsonl so the node→model wire can be read back.
 * Point the cluster at it with:  AINIZE_RUNTIME_API=http://localhost:8012 scripts/cluster-restart.sh
 */
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

const UPSTREAM = 'http://localhost:8002';
const LOG = new URL('./results/verify/model-wire.jsonl', import.meta.url).pathname;
writeFileSync(LOG, '');
let seq = 0;

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    const n = ++seq;
    const t0 = Date.now();
    let entry = { n, t: new Date().toISOString(), method: req.method, url: req.url };
    if (req.method === 'POST' && /completions/.test(req.url)) {
      try { const b = JSON.parse(raw.toString('utf8')); entry.body = b; } catch { entry.body_raw = raw.toString('utf8').slice(0, 2000); }
    }
    try {
      const up = await fetch(UPSTREAM + req.url, {
        method: req.method,
        headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k))),
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw,
      });
      const buf = Buffer.from(await up.arrayBuffer());
      if (entry.body) {
        try { const j = JSON.parse(buf.toString('utf8')); entry.answer = j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.text ?? null; } catch { /* ignore */ }
        entry.ms = Date.now() - t0;
        appendFileSync(LOG, JSON.stringify(entry) + '\n');
      }
      res.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => !['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(k))));
      res.end(buf);
    } catch (e) {
      appendFileSync(LOG, JSON.stringify({ ...entry, error: String(e) }) + '\n');
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
}).listen(8012, '127.0.0.1', () => console.log('model tap listening on 127.0.0.1:8012 → ' + UPSTREAM + '  log: ' + LOG));
