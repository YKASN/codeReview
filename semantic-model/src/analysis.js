import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { hash, inside, inventory } from './inventory.js';
import { scan } from './scan.js';
import { getMetadata, summary, findSymbols, context } from './store.js';

function locateIndex(input) {
  let filename = path.resolve(input);
  if (!fs.existsSync(filename)) return null;
  if (fs.statSync(filename).isDirectory()) {
    const latest = path.join(filename, 'latest.json');
    if (fs.existsSync(latest)) filename = JSON.parse(fs.readFileSync(latest, 'utf8')).runDir;
    filename = path.join(filename, 'model.sqlite');
  }
  return fs.existsSync(filename) ? fs.realpathSync(filename) : null;
}

export class AnalysisService {
  constructor(dataRoot = process.env.PLUGIN_DATA || path.join(os.homedir(), '.cache', 'codex-code-review')) {
    this.dataRoot = path.resolve(dataRoot);
    this.repositories = new Map();
  }
  repository(id) {
    const repo = this.repositories.get(id);
    if (!repo) throw new Error('Unknown repository_id. Call open_repository first.');
    return repo;
  }
  open({ repository_path, index_path }) {
    if (!path.isAbsolute(repository_path)) throw new Error('repository_path must be absolute');
    const root = fs.realpathSync(repository_path);
    if (!fs.statSync(root).isDirectory()) throw new Error('Repository must be a directory');
    // Validate Git discovery before selecting the target; do not execute its code.
    const current = inventory(root);
    const id = hash(root).slice(0, 24), output = path.join(this.dataRoot, 'indexes', id);
    const filename = locateIndex(index_path || output);
    if (index_path && !filename) throw new Error('Requested index_path does not contain an index');
    if (filename) {
      const db = new DatabaseSync(filename, { readOnly: true });
      try {
        const snapshot = getMetadata(db, 'snapshot');
        if (!snapshot || fs.realpathSync(snapshot.root) !== root) throw new Error('Index belongs to a different repository');
      } finally { db.close(); }
    }
    if (this.repositories.get(id)?.busy) throw new Error('Repository indexing is in progress');
    this.repositories.set(id, { root, output, filename, busy: false });
    return { repository_id: id, repository_path: root, index_available: Boolean(filename),
      current_commit: current.commit, next_tool: filename ? 'repository_status' : 'index_repository' };
  }
  withIndex(id, action) {
    const repo = this.repository(id);
    if (repo.busy) throw new Error('Repository indexing is in progress');
    if (!repo.filename) throw new Error('Index missing. Call index_repository.');
    const db = new DatabaseSync(repo.filename, { readOnly: true });
    try {
      const state = getMetadata(db, 'state');
      if (!['indexed', 'partial'].includes(state)) throw new Error(`Index is not queryable (${state || 'incomplete'}). Reindex.`);
      const snapshot = getMetadata(db, 'snapshot');
      if (fs.realpathSync(snapshot.root) !== repo.root) throw new Error('Index repository mismatch');
      return action(db, repo, { state, ...snapshot });
    } finally { db.close(); }
  }
  status({ repository_id }) {
    const repo = this.repository(repository_id);
    if (!repo.filename || repo.busy) return { repository_id, indexed: Boolean(repo.filename), indexing: repo.busy };
    return this.withIndex(repository_id, (db, r, snapshot) => {
      const current = inventory(r.root);
      return { repository_id, indexed: true, fresh: current.fingerprint === snapshot.fingerprint,
        current_commit: current.commit, state: snapshot.state, ...summary(db) };
    });
  }
  async index({ repository_id, languages = ['python', 'typescript'] }) {
    const repo = this.repository(repository_id);
    if (repo.busy) throw new Error('Repository indexing is already in progress');
    repo.busy = true;
    try {
      const report = await scan(repo.root, repo.output, { languages });
      // Never silently fall back to an older successful scan after a failed scan.
      repo.filename = null;
      if (['indexed', 'partial'].includes(report.state) && report.indexedFiles > 0) repo.filename = path.join(report.runDir, 'model.sqlite');
      return { repository_id, queryable: Boolean(repo.filename), ...report };
    } catch (error) { repo.filename = null; throw error; }
    finally { repo.busy = false; }
  }
  symbols({ repository_id, query, limit = 20 }) {
    return this.withIndex(repository_id, db => ({ trust: 'untrusted_discovery_metadata', source_verified: false,
      matches: findSymbols(db, query, limit), limit,
      note: 'Use get_symbol_evidence before drawing conclusions; symbol search is a bounded substring search.' }));
  }
  evidence(db, snapshot, relative, line, radius) {
    const value = context(db, relative, line, radius);
    if (value.text.length > 20000) { value.text = value.text.slice(0, 20000); value.text_truncated = true; }
    if (value.occurrences.length > 100) {
      value.occurrence_total = value.occurrences.length;
      value.occurrences = value.occurrences.slice(0, 100);
      value.occurrences_truncated = true;
    }
    return { ...value, trust: 'untrusted_source_data', source_verified: true,
      evidence_id: hash(JSON.stringify([snapshot.fingerprint, relative, value.sha256, value.startLine, value.endLine])),
      snapshot_commit: snapshot.commit, snapshot_fingerprint: snapshot.fingerprint,
      citation: `${relative}:${line}`, columns: 'zero-based-end-exclusive; see occurrence.position_encoding' };
  }
  read({ repository_id, file, line, radius = 8 }) {
    return this.withIndex(repository_id, (db, repo, snapshot) => this.evidence(db, snapshot, file, line, radius));
  }
  symbolEvidence({ repository_id, symbol_id, offset = 0, limit = 10, radius = 3 }) {
    return this.withIndex(repository_id, (db, repo, snapshot) => {
      const symbol = db.prepare('SELECT * FROM symbols WHERE id=?').get(symbol_id);
      if (!symbol) throw new Error('Unknown symbol_id. Use the exact id from search_symbols.');
      const total = db.prepare('SELECT count(*) n FROM occurrences WHERE symbol=?').get(symbol_id).n;
      const locations = db.prepare(`SELECT o.*,d.encoding position_encoding FROM occurrences o
        JOIN documents d ON d.path=o.path AND d.indexer=o.indexer WHERE o.symbol=?
        ORDER BY (o.roles & 1) DESC,o.path,o.start_line,o.start_col LIMIT ? OFFSET ?`).all(symbol_id, limit, offset);
      return { symbol_id, total, offset, next_offset: offset + locations.length < total ? offset + locations.length : null,
        relation_semantics: 'Definition or reference only. A reference is not a proven call.',
        locations: locations.map(o => ({ kind: (o.roles & 1) ? 'definition' : 'reference', occurrence: o,
          evidence: this.evidence(db, snapshot, o.path, o.start_line + 1, radius) })) };
    });
  }
  search({ repository_id, query, path_prefix = '', language, offset = 0, limit = 20 }) {
    return this.withIndex(repository_id, (db, repo, snapshot) => {
      const files = db.prepare('SELECT * FROM files WHERE substr(path,1,length(?))=? ORDER BY path').all(path_prefix, path_prefix);
      const hits = [];
      let matched = 0;
      for (const file of files) {
        if (language && file.language !== language) continue;
        const bytes = fs.readFileSync(inside(repo.root, file.path));
        if (hash(bytes) !== file.sha256) throw new Error(`Source changed since scan: ${file.path}. Reindex before searching.`);
        const lines = bytes.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].toLowerCase().includes(query.toLowerCase())) continue;
          if (matched++ < offset) continue;
          if (hits.length === limit) return { matches: hits, next_offset: offset + limit, truncated: true, search_semantics: 'case-insensitive literal; indexed file inventory only' };
          const evidence = this.evidence(db, snapshot, file.path, i + 1, 0);
          if (evidence.text.length > 2000) { evidence.text = evidence.text.slice(0, 2000); evidence.text_truncated = true; }
          hits.push(evidence);
        }
      }
      return { matches: hits, next_offset: null, truncated: false, search_semantics: 'case-insensitive literal; indexed file inventory only' };
    });
  }
}
