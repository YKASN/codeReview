import { hash } from './inventory.js';

// A reference-to-definition projection, not a runtime dependency/call graph.
// Multiple definition files remain candidates; project contexts never collapse.
export function deriveFileReferences(rows) {
  const occurrences = new Map(rows.occurrences.map(o => [o.id, o]));
  const definitions = new Map(rows.symbols.map(s => [s.id, (s.definition_ids || []).map(id => occurrences.get(id))]));
  const groups = new Map();
  const coverage = { reference_occurrences: 0, missing_symbol: 0, no_indexed_definition: 0, same_file_only: 0, cross_file: 0, ambiguous_cross_file: 0 };
  for (const reference of rows.occurrences) {
    if (reference.role === 'definition') continue;
    coverage.reference_occurrences++;
    if (!reference.symbol_id) { coverage.missing_symbol++; continue; }
    const targets = new Map();
    for (const definition of definitions.get(reference.symbol_id) || []) {
      if (!definition) throw new Error('Missing symbol definition while deriving file references');
      if (!targets.has(definition.file_id)) targets.set(definition.file_id, []);
      targets.get(definition.file_id).push(definition);
    }
    if (!targets.size) { coverage.no_indexed_definition++; continue; }
    const crossFile = [...targets].filter(([file]) => file !== reference.file_id);
    if (!crossFile.length) { coverage.same_file_only++; continue; }
    coverage.cross_file++;
    if (targets.size > 1) coverage.ambiguous_cross_file++;
    for (const [targetFile, definitions] of crossFile) {
      const key = JSON.stringify([reference.project_id, reference.file_id, targetFile]);
      if (!groups.has(key)) groups.set(key, { id: 'file-reference:' + hash(key), kind: 'symbol-reference', source_project_id: reference.project_id,
        source_file_id: reference.file_id, target_file_id: targetFile, evidence: [] });
      groups.get(key).evidence.push({ occurrence_id: reference.id, symbol_id: reference.symbol_id,
        definition_ids: definitions.map(d => d.id).sort(), target_status: targets.size === 1 ? 'unique-target-file' : 'candidate-target-file' });
    }
  }
  const references = [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const record of references) {
    record.evidence.sort((a, b) => a.occurrence_id.localeCompare(b.occurrence_id));
    record.evidence_count = record.evidence.length;
    record.symbol_ids = [...new Set(record.evidence.map(e => e.symbol_id))].sort();
    record.target_project_ids = [...new Set(record.evidence.flatMap(e => e.definition_ids.map(id => occurrences.get(id).project_id)))].sort();
    record.resolution_status = record.evidence.some(e => e.target_status === 'candidate-target-file') ? 'contains-candidate-targets' : 'unique-target-files';
  }
  return { references, coverage };
}

export function deriveOverview(rows, relationCoverage) {
  const fileCounts = {};
  const documentMap = new Map(rows.documents.map(d => [d.id, d]));
  for (const file of rows.files) fileCounts[file.language] = (fileCounts[file.language] || 0) + 1;
  return { schema_version: 'code-ir-overview/1', derived_from: 'code-ir/2',
    counts: Object.fromEntries(Object.entries(rows).map(([name, records]) => [name, records.length])),
    file_languages: fileCounts, reference_coverage: relationCoverage,
    projects: rows.projects.map(project => {
      const inputs = new Set(project.input_file_ids);
      return { project_id: project.id, root: project.root, language: project.language, kind: project.kind,
        configuration_path: project.configuration.path, run_status: project.run_status,
        input_files: inputs.size, indexed_input_files: rows.files.filter(f => inputs.has(f.id) && f.document_ids.some(id => documentMap.get(id)?.project_id === project.id)).length,
        observed_documents: rows.documents.filter(d => d.project_id === project.id).length,
        outgoing_file_relations: rows['file-references'].filter(r => r.source_project_id === project.id).length,
        limitations: project.limitations };
    }) };
}
