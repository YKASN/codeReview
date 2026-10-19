import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isDeepStrictEqual } from 'node:util';
import { hash, inside } from './inventory.js';
import { deriveFileReferences, deriveOverview } from './relations.js';
import { deriveCandidates } from './rules.js';
import { classifySymbolOrigins } from './symbols.js';

function* records(directory, name) {
  const fd = fs.openSync(inside(directory, name + '.jsonl'), 'r');
  const buffer = Buffer.alloc(64 * 1024), decoder = new StringDecoder('utf8');
  let pending = '';
  try {
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      pending += decoder.write(buffer.subarray(0, size));
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.trim()) throw new Error('Empty JSONL record: ' + name);
        yield JSON.parse(line);
      }
    }
    pending += decoder.end();
    if (pending.trim()) yield JSON.parse(pending);
  } finally { fs.closeSync(fd); }
}
export function readIRRecords(directory, name) { return records(directory, name); }

export function verifyIR(directory) {
  const manifest = JSON.parse(fs.readFileSync(inside(directory, 'manifest.json'), 'utf8'));
  if (!['code-ir/1', 'code-ir/2'].includes(manifest.schema_version)) throw new Error(`Unsupported IR schema: ${manifest.schema_version}`);
  if (!['indexed', 'partial'].includes(manifest.state)) throw new Error(`IR snapshot is not finalized: ${manifest.state}`);
  const artifacts = new Map();
  for (const artifact of manifest.artifacts) {
    if (artifacts.has(artifact.path)) throw new Error(`Duplicate artifact: ${artifact.path}`);
    artifacts.set(artifact.path, artifact);
    const bytes = fs.readFileSync(inside(directory, artifact.path));
    if (bytes.length !== artifact.bytes || hash(bytes) !== artifact.sha256) throw new Error(`IR artifact checksum mismatch: ${artifact.path}`);
  }
  const names = ['files', 'documents', 'symbols', 'occurrences', 'relationships', 'diagnostics', 'external-symbols'];
  if (manifest.schema_version === 'code-ir/2') names.unshift('projects');
  for (const name of ['structures', 'imports', 'calls', 'syntax-diagnostics', 'file-references', 'template-expressions', 'candidates']) if (manifest.counts[name] !== undefined) names.push(name);
  const maps = Object.fromEntries(names.map(name => [name, new Map()]));
  const entityIds = new Set();
  const prefixes = { projects: 'project', files: 'file', documents: 'document', symbols: 'symbol', occurrences: 'occurrence', relationships: 'relationship', diagnostics: 'diagnostic', 'external-symbols': 'external', structures: 'structure', imports: 'import', calls: 'call', 'syntax-diagnostics': 'syntax-diagnostic', 'file-references': 'file-reference', 'template-expressions':'template-expression', candidates:'candidate' };
  for (const name of names) {
    if (!artifacts.has(`${name}.jsonl`)) throw new Error(`IR dataset missing: ${name}`);
    let count = 0;
    for (const row of records(directory, name)) {
      count++;
      if (name === 'files') {
        const source = artifacts.get(row.source);
        if (!source || row.source !== `sources/${row.sha256}` || row.sha256 !== source.sha256 || row.bytes !== source.bytes) throw new Error('IR source mapping mismatch');
      }
      if (manifest.schema_version === 'code-ir/2') {
        if (typeof row.id !== 'string' || !row.id.startsWith(prefixes[name] + ':') || entityIds.has(row.id)) throw new Error(`Missing or duplicate entity ID in ${name}`);
        entityIds.add(row.id);
        // Keep only fields needed for cross-record checks, not large raw payloads.
        const { raw, origins, documentation, ...small } = row;
        maps[name].set(row.id, small);
      }
    }
    if (count !== manifest.counts[name]) throw new Error(`IR record count mismatch: ${name}`);
  }
  const report = { valid: true, schema_version: manifest.schema_version, snapshot: manifest.snapshot,
    counts: manifest.counts, artifacts_verified: artifacts.size };
  if (manifest.schema_version === 'code-ir/1') return report;
  const need = (dataset, id) => {
    const value = maps[dataset].get(id);
    if (!value) throw new Error(`Dangling ${dataset} reference: ${id}`);
    return value;
  };
  const producers = new Map();
  for (const producer of manifest.producers) {
    if (producers.has(producer.id)) throw new Error('Duplicate producer ID');
    need('projects', producer.project_id);
    if (!artifacts.has(producer.raw)) throw new Error('Producer raw artifact missing');
    if (producer.overlay && !artifacts.has(producer.overlay)) throw new Error('Producer config overlay missing');
    if (producer.environment?.metadata_artifact && artifacts.get(producer.environment.metadata_artifact)?.sha256 !== producer.environment.metadata_sha256) throw new Error('Producer environment metadata mismatch');
    producers.set(producer.id, producer);
  }
  for (const project of maps.projects.values()) {
    for (const id of project.input_file_ids) {
      if (!need('files', id).project_ids.includes(project.id)) throw new Error('Project input membership mismatch');
    }
    if (project.configuration.path) {
      const file = [...maps.files.values()].find(f => f.path === project.configuration.path);
      if (!file || project.configuration.sha256 && file.sha256 !== project.configuration.sha256) throw new Error('Project config provenance mismatch');
    }
  }
  for (const file of maps.files.values()) {
    for (const id of file.project_ids) need('projects', id);
    for (const id of file.document_ids) if (need('documents', id).file_id !== file.id) throw new Error('File/document membership mismatch');
    if (!file.analysis_status || !Array.isArray(file.parse_results)) throw new Error('Missing per-file parse status');
  }
  const provenance = row => {
    const document = need('documents', row.document_id), file = need('files', row.file_id);
    need('projects', row.project_id);
    const producer = producers.get(row.producer_id);
    if (!producer || producer.project_id !== row.project_id || document.producer_id !== row.producer_id || document.project_id !== row.project_id || document.file_id !== file.id || file.sha256 !== row.source_sha256) throw new Error('IR provenance mismatch');
    return { document, file };
  };
  const sourceLines = new Map();
  let unspecifiedColumns = 0;
  const checkRange = (row, range) => {
    if (!Array.isArray(range) || range.length !== 4 || range.some(n => !Number.isInteger(n) || n < 0) || range[2] < range[0] || range[2] === range[0] && range[3] < range[1]) throw new Error('Invalid normalized source range');
    const file = row.document_id ? provenance(row).file : need('files', row.file_id);
    const encoding = row.document_id ? need('documents', row.document_id).position_encoding : row.position_encoding;
    if (file.sha256 !== row.source_sha256) throw new Error('Syntax source provenance mismatch');
    if (!sourceLines.has(file.id)) sourceLines.set(file.id, fs.readFileSync(inside(directory, file.source), 'utf8').split(/\r?\n/));
    const lines = sourceLines.get(file.id);
    if (range[0] >= lines.length || range[2] >= lines.length) throw new Error('Source range line out of bounds: ' + file.path);
    if(row.range_encoding_evidence==='ascii-prefix' && range===row.range && (range[0]!==range[2] || range[3]>lines[range[0]].length || /[^\x00-\x7f]/.test(lines[range[0]].slice(0,range[3]))))throw new Error('Unproven ASCII range evidence');
    const length = encoding === 'UTF8CodeUnitOffsetFromLineStart' ? text => Buffer.byteLength(text)
      : encoding === 'UTF16CodeUnitOffsetFromLineStart' ? text => text.length
        : encoding === 'UTF32CodeUnitOffsetFromLineStart' ? text => [...text].length : null;
    if (!length) unspecifiedColumns++;
    else if (range[1] > length(lines[range[0]]) || range[3] > length(lines[range[2]])) throw new Error('Source range column out of bounds: ' + file.path);
  };
  for (const document of maps.documents.values()) {
    provenance(document);
    if (!need('files', document.file_id).document_ids.includes(document.id)) throw new Error('Document/file membership mismatch');
    if (typeof document.position_encoding !== 'string') throw new Error('Missing document position encoding');
  }
  for (const symbol of maps.symbols.values()) {
    if (!symbol.producer_symbol || !['defined', 'declared', 'external', 'unresolved'].includes(symbol.resolution_status)) throw new Error('Invalid normalized symbol');
    for (const id of symbol.project_ids) need('projects', id);
    for (const id of symbol.definition_ids) {
      const occurrence = need('occurrences', id);
      if (occurrence.symbol_id !== symbol.id || occurrence.role !== 'definition') throw new Error('Symbol definition mismatch');
    }
  }
  if([...maps.symbols.values()].some(s=>s.origin_classification!==undefined)){
    const classified=[...maps.symbols.values()].map(s=>({...s}));classifySymbolOrigins(classified);
    for(const expected of classified){const actual=maps.symbols.get(expected.id);if(!isDeepStrictEqual(actual.identity,expected.identity)||actual.origin_classification!==expected.origin_classification)throw new Error('Symbol origin evidence mismatch');}
  }
  for (const occurrence of maps.occurrences.values()) {
    checkRange(occurrence, occurrence.range);
    if (occurrence.enclosing_range) checkRange(occurrence, occurrence.enclosing_range);
    if (occurrence.symbol_id !== null) need('symbols', occurrence.symbol_id);
  }
  for (const relationship of maps.relationships.values()) {
    provenance(relationship); need('symbols', relationship.source_symbol_id); need('symbols', relationship.target_symbol_id);
  }
  for (const diagnostic of maps.diagnostics.values()) {
    checkRange(diagnostic, diagnostic.range);
    const occurrence = need('occurrences', diagnostic.occurrence_id);
    if (occurrence.document_id !== diagnostic.document_id) throw new Error('Diagnostic occurrence mismatch');
  }
  for (const external of maps['external-symbols'].values()) {
    need('symbols', external.symbol_id); need('projects', external.project_id);
    if (!producers.has(external.producer_id)) throw new Error('External symbol producer missing');
  }
  for (const structure of maps.structures?.values() || []) {
    checkRange(structure, structure.range);
    if (structure.name_range) checkRange(structure, structure.name_range);
    if (structure.parent_id) {
      const parent = need('structures', structure.parent_id);
      if (parent.file_id !== structure.file_id || parent.id === structure.id) throw new Error('Structure parent file mismatch');
    }
    if (structure.symbol_id) need('symbols', structure.symbol_id);
  }
  for (const dataset of ['imports', 'calls']) for (const record of maps[dataset]?.values() || []) {
    checkRange(record, record.range);
    if (record.callee_range) checkRange(record, record.callee_range);
    if (record.enclosing_structure_id && need('structures', record.enclosing_structure_id).file_id !== record.file_id) throw new Error('Syntax containing structure mismatch');
    if (dataset === 'calls') {
      for (const id of record.candidate_symbol_ids) need('symbols', id);
      for (const id of record.binding_occurrence_ids) {
        const occurrence = need('occurrences', id);
        if (occurrence.file_id !== record.file_id || occurrence.role === 'definition' || !record.candidate_symbol_ids.includes(occurrence.symbol_id)) throw new Error('Call binding evidence mismatch');
      }
      if (record.target_symbol_id) {
        const target = need('symbols', record.target_symbol_id);
        if (record.resolution_status !== 'resolved-static' || target.resolution_status !== 'defined' || !['Function', 'Method', 'Class', 'Constructor'].includes(target.kind) || record.candidate_symbol_ids.length !== 1 || !record.candidate_symbol_ids.includes(target.id) || !record.binding_occurrence_ids.length) throw new Error('Unproven static call target');
      } else if(record.resolution_status==='identified-external') {
        const external=need('symbols',record.external_symbol_id);
        if(!['standard-library','dependency'].includes(external.origin_classification)||external.resolution_status!=='external'||record.candidate_symbol_ids.length!==1||record.candidate_symbol_ids[0]!==external.id||!record.binding_occurrence_ids.length||record.unresolved_reason)throw new Error('Unproven external call identity');
      } else if (record.resolution_status !== 'unresolved' || !record.unresolved_reason) throw new Error('Missing unresolved call reason');
    }
  }
  for (const diagnostic of maps['syntax-diagnostics']?.values() || []) if (need('files', diagnostic.file_id).sha256 !== diagnostic.source_sha256) throw new Error('Syntax diagnostic source mismatch');
  for(const expression of maps['template-expressions']?.values()||[])checkRange(expression,expression.range);
  if(maps.candidates){
    for(const candidate of maps.candidates.values())checkRange(candidate,candidate.range);
    const rows=Object.fromEntries(Object.entries(maps).map(([name,map])=>[name,[...map.values()]]));
    const derived=deriveCandidates(rows);
    if(derived.candidates.length!==rows.candidates.length||derived.candidates.some(c=>!isDeepStrictEqual(c,maps.candidates.get(c.id))))throw new Error('Rule candidate evidence mismatch');
    if(!artifacts.has('rule-report.json')||!isDeepStrictEqual(JSON.parse(fs.readFileSync(inside(directory,'rule-report.json'),'utf8')),derived.report))throw new Error('Rule report mismatch');
  }
  if (maps['file-references']) {
    const rows = Object.fromEntries(Object.entries(maps).map(([name, map]) => [name, [...map.values()]]));
    const derived = deriveFileReferences(rows);
    if (derived.references.length !== rows['file-references'].length) throw new Error('File reference projection count mismatch');
    for (const expected of derived.references) {
      if (!isDeepStrictEqual(maps['file-references'].get(expected.id), expected)) throw new Error('File reference evidence mismatch');
    }
    if (!artifacts.has('overview.json')) throw new Error('Derived overview missing');
    const overview = JSON.parse(fs.readFileSync(inside(directory, 'overview.json'), 'utf8'));
    if (!isDeepStrictEqual(overview, deriveOverview(rows, derived.coverage))) throw new Error('Derived overview mismatch');
  }
  return { ...report, entity_links_verified: true, range_columns_unchecked_encoding_unspecified: unspecifiedColumns };
}
