import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Index, rangeOf } from './store.js';
import { hash, inside } from './inventory.js';
import { discoverProjects } from './projects.js';
import { enrichStructures } from './structures.js';
import { deriveFileReferences, deriveOverview } from './relations.js';
import { classifySymbolOrigins } from './symbols.js';
import { deriveCandidates } from './rules.js';
export { verifyIR } from './verify-ir.js';

export const IR_VERSION = 'code-ir/2';
export const IR_DATASETS = ['projects', 'files', 'documents', 'symbols', 'occurrences', 'relationships', 'diagnostics', 'external-symbols', 'structures', 'imports', 'calls', 'syntax-diagnostics', 'file-references', 'template-expressions', 'candidates'];
export const entityId = (kind, ...identity) => kind + ':' + hash(JSON.stringify(identity));
const scopedId = (raw, project, file) => raw.startsWith('local ') ? entityId('symbol', project, file, raw) : entityId('symbol', raw);
const knownEncoding = value => value && value !== 'UnspecifiedPositionEncoding' ? value : 'UnspecifiedPositionEncoding';
const roles = value => [[1,'definition'],[2,'import'],[4,'write'],[8,'read'],[16,'generated'],[32,'test'],[64,'forward-definition']].filter(([bit]) => (value & bit) !== 0).map(([,name]) => name);

export function persistIR(runDir, snapshot, runs, catalog = discoverProjects(snapshot)) {
  const directory = path.join(runDir, 'code-ir');
  fs.mkdirSync(directory);
  fs.mkdirSync(path.join(directory, 'sources'));
  fs.mkdirSync(path.join(directory, 'raw'));
  const artifacts = [], producers = [], rows = Object.fromEntries(IR_DATASETS.map(name => [name, []]));
  const fileMap = new Map(snapshot.files.map(file => [file.path, { ...file, id: entityId('file', file.path),
    source: `sources/${file.sha256}`, project_ids: [...catalog.membership[file.path]], document_ids: [], parse_results: [] }]));
  const projects = catalog.projects.map(project => ({ ...project, input_file_ids: project.files.map(f => fileMap.get(f).id), files: undefined,
    run_status: !project.files.length ? 'descriptor-only' : 'not-requested' }));
  const projectMap = new Map(projects.map(p => [p.id, p]));
  const symbols = new Map(), parsed = new Map();
  const artifact = relative => {
    const bytes = fs.readFileSync(path.join(directory, relative));
    artifacts.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
  };
  const symbol = (raw, project, file) => {
    const id = scopedId(raw, project, file);
    if (!symbols.has(id)) symbols.set(id, { id, producer_symbol: raw, scope: raw.startsWith('local ') ? 'document-local' : 'global',
      name: null, kind: 'unknown', documentation: [], origins: [], definition_ids: [], project_ids: [], resolution_status: 'unresolved', raw: null });
    const value = symbols.get(id);
    if (!value.project_ids.includes(project)) value.project_ids.push(project);
    return value;
  };
  for (const file of fileMap.values()) {
    const bytes = fs.readFileSync(inside(snapshot.root, file.path));
    if (hash(bytes) !== file.sha256) throw new Error(`Source changed while persisting IR: ${file.path}`);
    if (!fs.existsSync(path.join(directory, file.source))) {
      fs.writeFileSync(path.join(directory, file.source), bytes, { flag: 'wx' }); artifact(file.source);
    }
  }
  for (const run of runs) {
    const project = projectMap.get(run.project_id) || projects.find(p => p.language === run.indexer && p.root === '.') || projects.find(p => p.language === run.indexer);
    if (!project) throw new Error('Indexer run has no discovered project');
    project.run_status = run.status;
    project.run_error = run.error || null;
    if (run.status !== 'indexed') continue;
    const key = run.id || run.indexer;
    const rawPath = `raw/${key}.scip`;
    fs.copyFileSync(path.join(runDir, run.artifact || `${run.indexer}.scip`), path.join(directory, rawPath)); artifact(rawPath);
    const data = Index.toObject(Index.decode(fs.readFileSync(path.join(directory, rawPath))), { enums: String, longs: String, bytes: String });
    const indexRoot = fileURLToPath(data.metadata.projectRoot), prefix = path.relative(snapshot.root, indexRoot);
    if (prefix.startsWith('..') || path.isAbsolute(prefix)) throw new Error('SCIP root is outside snapshot');
    const producerId = entityId('producer', project.id, key);
    const environmentIndex = run.args?.indexOf('--environment') ?? -1;
    let environment = run.environment;
    if (environmentIndex >= 0) {
      const original = run.args[environmentIndex + 1], metadata = `raw/${key}.environment.json`;
      fs.copyFileSync(original, path.join(directory, metadata)); artifact(metadata);
      environment = { ...run.environment, metadata_artifact: metadata, metadata_sha256: hash(fs.readFileSync(original)) };
      project.environment = environment;
    }
    let overlay = null;
    if (run.indexer === 'typescript' && run.args?.[0] === 'index' && run.args[1]?.endsWith('.json')) {
      overlay = `raw/${key}.tsconfig.json`;
      fs.copyFileSync(run.args[1], path.join(directory, overlay)); artifact(overlay);
    }
    producers.push({ id: producerId, project_id: project.id, name: data.metadata.toolInfo?.name || run.indexer,
      version: data.metadata.toolInfo?.version || null, metadata: data.metadata, raw: rawPath, configuration: run.configuration, overlay, environment });
    for (const rawDocument of data.documents || []) {
      const relative = rawDocument.relativePath.replaceAll('\\', '/');
      inside(indexRoot, relative);
      const filePath = path.relative(snapshot.root, path.join(indexRoot, relative)).split(path.sep).join('/');
      const file = fileMap.get(filePath);
      if (!file) continue;
      if (project.language === 'python' && !project.input_file_ids.includes(file.id)) continue;
      const documentId = entityId('document', project.id, filePath);
      if (parsed.has(documentId)) throw new Error('Duplicate document in one project: ' + filePath);
      parsed.set(documentId, true);
      const { occurrences = [], symbols: declarations = [], ...metadata } = rawDocument;
      const provenance = { producer_id: producerId, project_id: project.id, document_id: documentId, file_id: file.id, source_sha256: file.sha256 };
      rows.documents.push({ id: documentId, ...provenance, language: rawDocument.language || file.language,
        position_encoding: knownEncoding(rawDocument.positionEncoding), parse_status: 'indexed', raw: metadata });
      file.document_ids.push(documentId);
      if (!file.project_ids.includes(project.id)) file.project_ids.push(project.id);
      let relationshipOrdinal = 0;
      for (const info of declarations) {
        const value = symbol(info.symbol, project.id, filePath);
        value.name ||= info.displayName || null;
        if (info.kind && info.kind !== 'UnspecifiedKind') value.kind = info.kind;
        value.documentation = [...new Set([...value.documentation, ...(info.documentation || [])])];
        value.origins.push({ ...provenance, raw: info }); value.raw ||= info;
        if (value.resolution_status === 'unresolved') value.resolution_status = 'declared';
        for (const relation of info.relationships || []) {
          const target = symbol(relation.symbol, project.id, filePath);
          rows.relationships.push({ id: entityId('relationship', documentId, relationshipOrdinal++), ...provenance,
            source_symbol_id: value.id, target_symbol_id: target.id,
            kinds: ['isReference','isImplementation','isTypeDefinition','isDefinition'].filter(flag => relation[flag]), raw: relation });
        }
      }
      for (let ordinal = 0; ordinal < occurrences.length; ordinal++) {
        const occurrence = occurrences[ordinal], range = rangeOf(occurrence);
        const value = occurrence.symbol ? symbol(occurrence.symbol, project.id, filePath) : null;
        const id = entityId('occurrence', documentId, ordinal);
        const enclosing = occurrence.enclosingRange?.length || occurrence.singleLineEnclosingRange || occurrence.multiLineEnclosingRange
          ? rangeOf({ range: occurrence.enclosingRange, singleLineRange: occurrence.singleLineEnclosingRange, multiLineRange: occurrence.multiLineEnclosingRange }) : null;
        const roleList = roles(occurrence.symbolRoles || 0);
        rows.occurrences.push({ id, ...provenance, symbol_id: value?.id || null, range, enclosing_range: enclosing,
          position_encoding: knownEncoding(rawDocument.positionEncoding), role: !value ? 'unresolved' : roleList.includes('definition') ? 'definition' : 'reference',
          roles: roleList, resolution_status: value ? 'producer-linked' : 'unresolved', raw: occurrence });
        if (value && roleList.includes('definition')) { value.definition_ids.push(id); value.resolution_status = 'defined'; }
        for (const [ordinal, diagnostic] of (occurrence.diagnostics || []).entries()) rows.diagnostics.push({
          id: entityId('diagnostic', id, ordinal), ...provenance, occurrence_id: id, range,
          severity: diagnostic.severity || 'UnspecifiedSeverity', message: diagnostic.message || '', code: diagnostic.code || null, raw: diagnostic });
      }
    }
    for (const [ordinal, info] of (data.externalSymbols || []).entries()) {
      const value = symbol(info.symbol, project.id, '<external>');
      if (['declared', 'unresolved'].includes(value.resolution_status)) value.resolution_status = 'external';
      value.name ||= info.displayName || null;
      if (value.kind === 'unknown' && info.kind && info.kind !== 'UnspecifiedKind') value.kind = info.kind;
      rows['external-symbols'].push({ id: entityId('external', producerId, ordinal), symbol_id: value.id,
        producer_symbol: info.symbol, project_id: project.id, producer_id: producerId, raw: info });
    }
  }
  for (const file of fileMap.values()) {
    for (const projectId of file.project_ids) {
      const project = projectMap.get(projectId);
      const emitted = file.document_ids.filter(id => rows.documents.find(d => d.id === id)?.project_id === projectId);
      file.parse_results.push({ project_id: projectId, is_input: project.input_file_ids.includes(file.id),
        status: emitted.length ? 'indexed' : project.run_status === 'indexed' ? 'not-emitted' : project.run_status,
        reason: emitted.length ? null : project.run_error || (project.run_status === 'indexed' ? 'indexer-did-not-emit-document' : project.run_status), document_ids: emitted });
    }
    file.analysis_status = !file.project_ids.length ? 'source-only' : file.document_ids.length
      ? file.parse_results.some(r => r.status !== 'indexed') ? 'partial' : 'indexed'
      : file.parse_results.some(r => r.status === 'failed') ? 'failed' : 'not-indexed';
    file.analysis_reason = !file.project_ids.length ? 'language-not-supported' : null;
  }
  rows.files = [...fileMap.values()]; rows.projects = projects; rows.symbols = [...symbols.values()];
  classifySymbolOrigins(rows.symbols);
  for (const relation of rows.relationships) relation.resolution_status = symbols.get(relation.target_symbol_id).resolution_status;
  const structureCoverage = enrichStructures(directory, rows, symbols);
  const fileRelations = deriveFileReferences(rows);
  rows['file-references'] = fileRelations.references;
  const ruleResults = deriveCandidates(rows); rows.candidates = ruleResults.candidates;
  fs.writeFileSync(path.join(directory, 'rule-report.json'), JSON.stringify(ruleResults.report,null,2)); artifact('rule-report.json');
  const counts = {};
  for (const name of IR_DATASETS) {
    const filename = `${name}.jsonl`, fd = fs.openSync(path.join(directory, filename), 'wx');
    try { for (const row of rows[name]) fs.writeSync(fd, JSON.stringify(row) + '\n'); }
    finally { fs.closeSync(fd); }
    counts[name] = rows[name].length; artifact(filename);
  }
  fs.writeFileSync(path.join(directory, 'overview.json'), JSON.stringify(deriveOverview(rows, fileRelations.coverage), null, 2)); artifact('overview.json');
  const manifest = { schema_version: IR_VERSION, state: 'pending-validation', created_at: new Date().toISOString(),
    snapshot: { id: entityId('snapshot', snapshot.commit, snapshot.fingerprint), root: snapshot.root, commit: snapshot.commit, dirty: snapshot.dirty, fingerprint: snapshot.fingerprint },
    project_configuration_fingerprint: hash(JSON.stringify(catalog)),
    coverage: { ...structureCoverage, rule_candidates:rows.candidates.length, file_reference_relations: rows['file-references'].length, reference_coverage: fileRelations.coverage, inventoried_files: rows.files.length, indexed_files: rows.files.filter(f => f.document_ids.length).length,
      indexed_documents: rows.documents.length, excluded_files: snapshot.skipped.length,
      configuration_gaps: projects.filter(p => p.kind === 'inferred' || p.configuration.diagnostics?.length).map(p => p.id),
      unresolved_symbols: rows.symbols.filter(s => s.resolution_status === 'unresolved').length,
      unknown_symbol_names: rows.symbols.filter(s => s.name === null).length,
      unknown_symbol_kinds: rows.symbols.filter(s => s.kind === 'unknown').length },
    coordinate_system: 'zero-based, end-exclusive; producer encoding retained; unspecified columns are not inferred',
    producers, counts, artifacts };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return { directory, schema_version: IR_VERSION, counts, artifacts: artifacts.length };
}

export function finalizeIR(directory, state) {
  const filename = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8')); manifest.state = state;
  fs.writeFileSync(filename + '.tmp', JSON.stringify(manifest, null, 2)); fs.renameSync(filename + '.tmp', filename);
}
