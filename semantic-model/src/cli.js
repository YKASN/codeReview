#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scan } from './scan.js';
import { summary, findSymbols, references, context, getMetadata } from './store.js';

const help = `Repository semantic model (Node 24+)
  scan --repo PATH --out PATH [--languages python,typescript] [--python ABSOLUTE_PATH] [--timeout-seconds 600]
  summary --db PATH
  symbols --db PATH --name TEXT
  refs --db PATH --symbol EXACT_SYMBOL_ID
  context --db PATH --file REPO_RELATIVE_PATH --line ONE_BASED_LINE [--radius 5]
  uncovered --db PATH
Ranges in refs/occurrences are zero-based, end-exclusive. Context lines are one-based.
--db accepts model.sqlite, a scan directory, or the output directory with latest.json.
`;
function options(args) {
  const result = {};
  const valid = new Set(['repo', 'out', 'languages', 'python', 'timeout-seconds', 'db', 'name', 'symbol', 'file', 'line', 'radius']);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    if (!args[i]?.startsWith('--') || !valid.has(key) || args[i + 1] === undefined) throw new Error(`Invalid option: ${args[i]}`);
    result[key] = args[i + 1];
  }
  return result;
}
function required(o, name) { if (!o[name]) throw new Error(`--${name} is required`); return o[name]; }
function integer(value, name, min, max) { const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`); return n; }
try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') { console.log(help); }
  else {
    const o = options(args);
    let result;
    if (command === 'scan') {
      result = await scan(required(o, 'repo'), required(o, 'out'), { languages: o.languages?.split(','), python: o.python,
        timeoutMs: integer(o['timeout-seconds'] ?? 600, 'timeout-seconds', 1, 7200) * 1000 });
      if (result.state !== 'indexed') process.exitCode = 2;
    } else {
      let filename = path.resolve(required(o, 'db'));
      if (fs.statSync(filename).isDirectory()) {
        if (fs.existsSync(path.join(filename, 'latest.json'))) filename = JSON.parse(fs.readFileSync(path.join(filename, 'latest.json'), 'utf8')).runDir;
        filename = path.join(filename, 'model.sqlite');
      }
      const db = new DatabaseSync(filename, { readOnly: true });
      try {
        const state = getMetadata(db, 'state');
        if (state === 'source-changed') throw new Error('Source changed during scan; create a stable scan before querying');
        if (!['indexed', 'partial'].includes(state)) throw new Error('Scan is incomplete; wait for a completed scan before querying');
        if (command === 'summary') result = { state: getMetadata(db, 'state'), ...summary(db) };
        else if (command === 'symbols') result = findSymbols(db, required(o, 'name'));
        else if (command === 'refs') result = references(db, required(o, 'symbol'));
        else if (command === 'context') result = context(db, required(o, 'file'), integer(required(o, 'line'), 'line', 1, 10000000), integer(o.radius ?? 5, 'radius', 0, 100));
        else if (command === 'uncovered') result = db.prepare('SELECT * FROM files WHERE path NOT IN (SELECT path FROM documents) ORDER BY language,path').all();
        else throw new Error(`Unknown command: ${command}`);
      } finally { db.close(); }
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
