import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Index, rangeOf } from './store.js';
import { hash, inside } from './inventory.js';

const version = 'code-ir/1';
const datasets = ['files', 'documents', 'symbols', 'occurrences', 'relationships', 'diagnostics', 'external-symbols'];
const symbolId = (raw, indexer, file) => raw.startsWith('local ') ? JSON.stringify([indexer, file, raw]) : raw;

// This is a serialization boundary, not an analysis/tool API. Raw SCIP is kept
// alongside normalized records so future consumers can recover producer fields.
export function persistIR(runDir, snapshot, runs) {
  const directory = path.join(runDir, 'code-ir');
  fs.mkdirSync(directory);
  fs.mkdirSync(path.join(directory, 'sources'));
  fs.mkdirSync(path.join(directory, 'raw'));
  const artifacts = [], counts = Object.fromEntries(datasets.map(name => [name, 0]));
  const descriptors = new Map();
  const addArtifact = relative => {
    const bytes = fs.readFileSync(path.join(directory, relative));
    artifacts.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
  };
  const write = (dataset, record) => {
    fs.writeSync(descriptors.get(dataset), JSON.stringify(record) + '\n');
    counts[dataset]++;
  };
  const files = new Map(snapshot.files.map(file => [file.path, file]));
  const producers = [];
  try {
    for (const name of datasets) descriptors.set(name, fs.openSync(path.join(directory, `${name}.jsonl`), 'wx'));
    for (const file of snapshot.files) {
      const bytes = fs.readFileSync(inside(snapshot.root, file.path));
      if (hash(bytes) !== file.sha256) throw new Error(`Source changed while persisting IR: ${file.path}`);
      const source = `sources/${file.sha256}`;
      if (!fs.existsSync(path.join(directory, source))) {
        fs.writeFileSync(path.join(directory, source), bytes, { flag: 'wx' });
        addArtifact(source);
      }
      write('files', { ...file, source });
    }
    for (const run of runs.filter(r => r.status === 'indexed')) {
      const rawPath = `raw/${run.indexer}.scip`;
      fs.copyFileSync(path.join(runDir, `${run.indexer}.scip`), path.join(directory, rawPath));
      addArtifact(rawPath);
      const data = Index.toObject(Index.decode(fs.readFileSync(path.join(directory, rawPath))), { enums: String, longs: String, bytes: String });
      const indexRoot = fileURLToPath(data.metadata.projectRoot);
      const prefix = path.relative(snapshot.root, indexRoot);
      if (prefix.startsWith('..') || path.isAbsolute(prefix)) throw new Error('SCIP root is outside snapshot');
      const indexer = run.indexer;
      producers.push({ indexer, metadata: data.metadata, configuration: run.configuration, environment: run.environment, raw: rawPath });
      for (const document of data.documents || []) {
        const relative = document.relativePath.replaceAll('\\', '/');
        // Apply the same path validation as the importer, before normalization.
        inside(indexRoot, relative);
        const file = path.relative(snapshot.root, path.join(indexRoot, relative)).split(path.sep).join('/');
        const info = files.get(file);
        if (!info) continue;
        const { occurrences = [], symbols = [], ...documentMetadata } = document;
        const provenance = { indexer, file, source_sha256: info.sha256 };
        write('documents', { ...provenance, metadata: documentMetadata });
        for (const symbol of symbols) {
          const id = symbolId(symbol.symbol, indexer, file);
          write('symbols', { ...provenance, id, raw: symbol });
          for (const relation of symbol.relationships || []) {
            write('relationships', { ...provenance, source_symbol_id: id,
              target_symbol_id: symbolId(relation.symbol, indexer, file), raw: relation });
          }
        }
        for (const occurrence of occurrences) {
          const position = rangeOf(occurrence);
          const id = occurrence.symbol ? symbolId(occurrence.symbol, indexer, file) : null;
          write('occurrences', { ...provenance, symbol_id: id, range: position,
            role: !id ? 'unresolved' : (occurrence.symbolRoles & 1) ? 'definition' : 'reference', raw: occurrence });
          for (const diagnostic of occurrence.diagnostics || []) {
            write('diagnostics', { ...provenance, range: position, symbol_id: id, raw: diagnostic });
          }
        }
      }
      for (const symbol of data.externalSymbols || []) {
        write('external-symbols', { indexer, id: symbol.symbol, raw: symbol });
      }
    }
  } finally { for (const fd of descriptors.values()) fs.closeSync(fd); }
  for (const name of datasets) addArtifact(`${name}.jsonl`);
  const manifest = { schema_version: version, state: 'pending-validation', created_at: new Date().toISOString(),
    snapshot: { root: snapshot.root, commit: snapshot.commit, dirty: snapshot.dirty, fingerprint: snapshot.fingerprint },
    coverage: { inventoried_files: snapshot.files.length, indexed_documents: counts.documents,
      excluded_files: snapshot.skipped.length, indexers: runs.map(r => ({ indexer: r.indexer, status: r.status, stats: r.stats, error: r.error })) },
    coordinate_system: 'zero-based, end-exclusive; preserve producer positionEncoding; unspecified is not inferred',
    producers, counts, artifacts };
  // Written last: its presence is the completion marker for this directory.
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return { directory, schema_version: version, counts, artifacts: artifacts.length };
}

export function finalizeIR(directory, state) {
  const filename = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  manifest.state = state;
  fs.writeFileSync(filename + '.tmp', JSON.stringify(manifest, null, 2));
  fs.renameSync(filename + '.tmp', filename);
}

// Offline verification deliberately never reads snapshot.root.
export function verifyIR(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schema_version !== version) throw new Error(`Unsupported IR schema: ${manifest.schema_version}`);
  if (!['indexed', 'partial'].includes(manifest.state)) throw new Error(`IR snapshot is not finalized: ${manifest.state}`);
  const listed = new Set();
  for (const artifact of manifest.artifacts) {
    if (listed.has(artifact.path)) throw new Error(`Duplicate artifact: ${artifact.path}`);
    listed.add(artifact.path);
    const bytes = fs.readFileSync(inside(directory, artifact.path));
    if (bytes.length !== artifact.bytes || hash(bytes) !== artifact.sha256) throw new Error(`IR artifact checksum mismatch: ${artifact.path}`);
  }
  for (const name of datasets) {
    if (!listed.has(`${name}.jsonl`)) throw new Error(`IR dataset missing: ${name}`);
    const text = fs.readFileSync(path.join(directory, `${name}.jsonl`), 'utf8');
    const lines = text.trimEnd() ? text.trimEnd().split('\n') : [];
    if (lines.length !== manifest.counts[name]) throw new Error(`IR record count mismatch: ${name}`);
    for (const line of lines) {
      const record = JSON.parse(line);
      if (name === 'files' && (!listed.has(record.source) || record.source !== `sources/${record.sha256}`)) throw new Error('IR source mapping mismatch');
    }
  }
  return { valid: true, schema_version: manifest.schema_version, snapshot: manifest.snapshot, counts: manifest.counts, artifacts_verified: listed.size };
}
