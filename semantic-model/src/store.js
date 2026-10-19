import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import protobuf from 'protobufjs';
import { inside, hash } from './inventory.js';

export const schema = protobuf.loadSync(fileURLToPath(new URL('../vendor/scip.proto', import.meta.url)));
export const Index = schema.lookupType('scip.Index');
export function openStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,language TEXT,sha256 TEXT,bytes INTEGER);
    CREATE TABLE IF NOT EXISTS documents(indexer TEXT,path TEXT,encoding INTEGER,PRIMARY KEY(indexer,path));
    CREATE TABLE IF NOT EXISTS symbols(id TEXT PRIMARY KEY,raw TEXT,name TEXT,kind INTEGER,documentation TEXT,relationships TEXT);
    CREATE TABLE IF NOT EXISTS occurrences(symbol TEXT,path TEXT,indexer TEXT,start_line INTEGER,start_col INTEGER,end_line INTEGER,end_col INTEGER,roles INTEGER);
    CREATE INDEX IF NOT EXISTS occurrence_symbol ON occurrences(symbol);
    CREATE INDEX IF NOT EXISTS occurrence_path ON occurrences(path);
    CREATE INDEX IF NOT EXISTS symbol_name ON symbols(name);`);
  return db;
}

export function setMetadata(db, key, value) { db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(key, JSON.stringify(value)); }
export function getMetadata(db, key) { const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
export function addInventory(db, data) {
  const insert = db.prepare('INSERT INTO files VALUES (?,?,?,?)');
  for (const f of data.files) insert.run(f.path, f.language, f.sha256, f.bytes);
  setMetadata(db, 'snapshot', { ...data, files: undefined, skipped: undefined });
}

export function rangeOf(o) {
  let full;
  if (o.singleLineRange) { const r = o.singleLineRange; full = [r.line || 0, r.startCharacter || 0, r.line || 0, r.endCharacter || 0]; }
  else if (o.multiLineRange) { const r = o.multiLineRange; full = [r.startLine || 0, r.startCharacter || 0, r.endLine || 0, r.endCharacter || 0]; }
  else {
    const r = o.range || [];
    if (r.length !== 3 && r.length !== 4) throw new Error('Invalid SCIP occurrence range');
    full = r.length === 3 ? [r[0], r[1], r[0], r[2]] : r;
  }
  if (full.some(v => !Number.isInteger(v) || v < 0) || full[2] < full[0] || (full[2] === full[0] && full[3] < full[1])) throw new Error('Invalid SCIP range coordinates');
  return full;
}

export function importScip(db, filename, repositoryRoot, indexer) {
  const data = Index.decode(fs.readFileSync(filename));
  if (!data.metadata?.projectRoot) throw new Error('SCIP project root is required');
  const indexRoot = fs.realpathSync(fileURLToPath(data.metadata.projectRoot));
  const prefix = path.relative(repositoryRoot, indexRoot);
  if (prefix.startsWith('..') || path.isAbsolute(prefix)) throw new Error('SCIP root is outside repository');
  const file = db.prepare('SELECT * FROM files WHERE path=?');
  const docInsert = db.prepare('INSERT INTO documents VALUES (?,?,?)');
  const symbolInsert = db.prepare('INSERT OR IGNORE INTO symbols VALUES (?,?,?,?,?,?)');
  const symbolDefinition = db.prepare(`INSERT INTO symbols VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    name=excluded.name,kind=excluded.kind,documentation=excluded.documentation,relationships=excluded.relationships`);
  const occurrenceInsert = db.prepare('INSERT INTO occurrences VALUES (?,?,?,?,?,?,?,?)');
  const scoped = (raw, p) => raw.startsWith('local ') ? JSON.stringify([indexer, p, raw]) : raw;
  const stats = { documents: 0, occurrences: 0, skippedDocuments: 0, normalizedWindowsPaths: 0, diagnostics: 0, positionEncodings: {}, tool: data.metadata.toolInfo };
  db.exec('BEGIN');
  try {
    for (const doc of data.documents) {
      // Both pinned indexers emit backslashes on Windows despite SCIP's POSIX
      // path contract. Normalize separators only; still reject dot/traversal paths.
      const relativePath = doc.relativePath.replaceAll('\\', '/');
      if (relativePath !== doc.relativePath) stats.normalizedWindowsPaths++;
      inside(indexRoot, relativePath);
      const p = path.relative(repositoryRoot, path.join(indexRoot, relativePath)).split(path.sep).join('/');
      if (!file.get(p)) { stats.skippedDocuments++; continue; }
      docInsert.run(indexer, p, doc.positionEncoding || 0);
      stats.documents++;
      stats.positionEncodings[doc.positionEncoding || 0] = (stats.positionEncodings[doc.positionEncoding || 0] || 0) + 1;
      for (const symbol of doc.symbols) {
        symbolDefinition.run(scoped(symbol.symbol, p), symbol.symbol, symbol.displayName || symbol.symbol, symbol.kind || 0,
          JSON.stringify(symbol.documentation), JSON.stringify(symbol.relationships));
      }
      for (const o of doc.occurrences) {
        stats.diagnostics += o.diagnostics.length;
        if (!o.symbol) continue;
        const id = scoped(o.symbol, p), r = rangeOf(o);
        symbolInsert.run(id, o.symbol, o.symbol, 0, '[]', '[]');
        occurrenceInsert.run(id, p, indexer, ...r, o.symbolRoles || 0);
        stats.occurrences++;
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return stats;
}

export function summary(db) {
  const total = db.prepare('SELECT count(*) n FROM files').get().n;
  const indexed = db.prepare('SELECT count(DISTINCT path) n FROM documents').get().n;
  return { snapshot: getMetadata(db, 'snapshot'), runs: getMetadata(db, 'runs'), files: total, indexedFiles: indexed,
    unindexedFiles: total - indexed, symbols: db.prepare('SELECT count(*) n FROM symbols').get().n,
    occurrences: db.prepare('SELECT count(*) n FROM occurrences').get().n,
    coverage: db.prepare('SELECT f.language,count(*) files,count(d.path) indexedFiles FROM files f LEFT JOIN (SELECT DISTINCT path FROM documents) d ON d.path=f.path GROUP BY f.language').all() };
}
export function findSymbols(db, name, limit = 30) {
  return db.prepare(`SELECT s.*, (SELECT count(*) FROM occurrences o WHERE o.symbol=s.id AND (o.roles & 1)=1) definitions,
    (SELECT count(*) FROM occurrences o WHERE o.symbol=s.id AND (o.roles & 1)=0) AS "references" FROM symbols s
    WHERE instr(lower(s.name),lower(?)) > 0 ORDER BY definitions DESC,s.name,s.id LIMIT ?`).all(name, limit);
}
export function references(db, symbol) {
  return db.prepare(`SELECT o.*,d.encoding position_encoding FROM occurrences o
    JOIN documents d ON d.path=o.path AND d.indexer=o.indexer
    WHERE o.symbol=? ORDER BY o.path,o.start_line,o.start_col`).all(symbol);
}
export function context(db, relative, line, radius = 5) {
  const root = getMetadata(db, 'snapshot').root;
  const indexed = db.prepare('SELECT * FROM files WHERE path=?').get(relative);
  if (!indexed) throw new Error('File is not in this snapshot');
  const bytes = fs.readFileSync(inside(root, relative));
  if (hash(bytes) !== indexed.sha256) throw new Error('Source changed since scan; rescan before requesting evidence');
  const lines = bytes.toString('utf8').split(/\r?\n/);
  if (!Number.isInteger(line) || line < 1 || line > lines.length) throw new Error('Line is outside file');
  const start = Math.max(1, line - radius), end = Math.min(lines.length, line + radius);
  return { path: relative, sha256: indexed.sha256, startLine: start, endLine: end,
    text: lines.slice(start - 1, end).map((v, i) => `${start + i}: ${v}`).join('\n'),
    occurrences: db.prepare(`SELECT o.*,d.encoding position_encoding FROM occurrences o
      JOIN documents d ON d.path=o.path AND d.indexer=o.indexer
      WHERE o.path=? AND o.start_line>=? AND o.start_line<? ORDER BY o.start_line,o.start_col`).all(relative, start - 1, end) };
}
