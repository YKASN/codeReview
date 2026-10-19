import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { parse as parseSFC, version as vueVersion } from '@vue/compiler-sfc';
import { hash } from './inventory.js';

const id = (kind, ...parts) => kind + ':' + hash(JSON.stringify(parts));
const knownCallable = new Set(['Function', 'Method', 'Class', 'Constructor']);
const normalizedKinds = { module: 'Module', class: 'Class', function: 'Function', method: 'Method', getter: 'GetAccessor', setter: 'SetAccessor', constructor: 'Constructor', parameter: 'Parameter', variable: 'Variable', property: 'Property', interface: 'Interface', enum: 'Enum', type: 'Type' };

function typescriptFacts(directory, files) {
  const result = { structures: [], imports: [], calls: [], diagnostics: [], files: [] }, parser = 'typescript/' + ts.version;
  for (const file of files) {
    const text = file.syntax_text ?? fs.readFileSync(path.join(directory, file.source), 'utf8');
    const source = ts.createSourceFile(file.path, text, ts.ScriptTarget.Latest, true, file.script_kind);
    const scopes = [];
    const range = node => {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source));
      const end = source.getLineAndCharacterOfPosition(node.end);
      return [start.line, start.character, end.line, end.character];
    };
    const add = (kind, node, name = null, nameNode = null, extra = {}) => {
      const index = result.structures.length;
      result.structures.push({ file_id: file.id, parser, position_encoding: 'UTF16CodeUnitOffsetFromLineStart', kind, name,
        range: range(node), name_range: nameNode ? range(nameNode) : null, parent_index: scopes.at(-1) ?? null,
        exported: Boolean(node.modifiers?.some(m => [ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.DefaultKeyword].includes(m.kind))),
        decorators: ts.canHaveDecorators(node) ? (ts.getDecorators(node) || []).map(d => d.getText(source)) : [], ...extra });
      return index;
    };
    const last=source.getLineAndCharacterOfPosition(source.end);
    const module = add('module', source, file.path, null, {range:[0,0,last.line,last.character]}); scopes.push(module);
    function visit(node) {
      let structure = null;
      const nameNode = node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name : null;
      const name = nameNode?.text || null;
      const annotation = node.type?.getText(source) || null;
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) structure = add('class', node, name, nameNode, { bases: node.heritageClauses?.flatMap(c => c.types.map(t => t.getText(source))) || [] });
      else if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
        const kind = ts.isConstructorDeclaration(node) ? 'constructor' : ts.isGetAccessorDeclaration(node) ? 'getter' : ts.isSetAccessorDeclaration(node) ? 'setter' : ts.isMethodDeclaration(node) ? 'method' : 'function';
        const signature = text.slice(node.getStart(source), node.body ? node.body.getStart(source) : node.end);
        structure = add(kind, node, name, nameNode, { parameters: node.parameters.map(p => ({ name: p.name.getText(source), annotation: p.type?.getText(source) || null, default: p.initializer?.getText(source) || null, optional: Boolean(p.questionToken), rest: Boolean(p.dotDotDotToken) })), returns: annotation, signature: signature.slice(0, 2000), signature_truncated: signature.length > 2000 });
      } else if (ts.isVariableDeclaration(node)) structure = add('variable', node, name, nameNode, { annotation });
      else if (ts.isParameter(node)) structure = add('parameter', node, name, nameNode, { annotation });
      else if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) structure = add('property', node, name, nameNode, { annotation });
      else if (ts.isInterfaceDeclaration(node)) structure = add('interface', node, name, nameNode);
      else if (ts.isTypeAliasDeclaration(node)) structure = add('type', node, name, nameNode);
      else if (ts.isEnumDeclaration(node)) structure = add('enum', node, name, nameNode);
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause, names = [];
        if (clause?.name) names.push({ name: 'default', alias: clause.name.text });
        if (clause?.namedBindings) {
          const bindings = clause.namedBindings;
          if (ts.isNamespaceImport(bindings)) names.push({ name: '*', alias: bindings.name.text });
          else for (const element of bindings.elements) names.push({ name: element.propertyName?.text || element.name.text, alias: element.propertyName ? element.name.text : null, type_only: Boolean(clause.isTypeOnly || element.isTypeOnly) });
        }
        result.imports.push({ file_id: file.id, parser, position_encoding: 'UTF16CodeUnitOffsetFromLineStart', range: range(node), enclosing_index: scopes.at(-1), module: node.moduleSpecifier.text, names, type_only: Boolean(clause?.isTypeOnly), relative_level: null });
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const target = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : ts.isIdentifier(node.expression) ? node.expression : null;
        result.calls.push({ file_id: file.id, parser, position_encoding: 'UTF16CodeUnitOffsetFromLineStart', range: range(node), callee_range: target ? range(target) : null,
          callee_name: target?.text || null, callee_expression: node.expression.getText(source), enclosing_index: scopes.at(-1), argument_count: node.arguments?.length || 0, construction: ts.isNewExpression(node) });
      }
      if (structure !== null) scopes.push(structure);
      ts.forEachChild(node, visit);
      if (structure !== null) scopes.pop();
    }
    ts.forEachChild(source, visit);
    for (const diagnostic of source.parseDiagnostics) result.diagnostics.push({ file_id: file.id, parser, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'), code: diagnostic.code });
    result.files.push({ file_id: file.id, parser, status: source.parseDiagnostics.length ? 'partial' : 'parsed' });
  }
  return result;
}

function vueFacts(directory, files) {
  const result = { structures: [], imports: [], calls: [], diagnostics: [], files: [], templateExpressions: [] };
  for (const file of files) {
    const text = fs.readFileSync(path.join(directory, file.source), 'utf8');
    const { descriptor, errors } = parseSFC(text, { filename: file.path });
    const blocks = [descriptor.script, descriptor.scriptSetup].filter(Boolean), supported = blocks.filter(b => !b.src && (!b.lang || ['js','ts','jsx','tsx'].includes(b.lang)));
    let masked = '', cursor = 0;
    for (const block of supported.sort((a,b) => a.loc.start.offset-b.loc.start.offset)) {
      masked += text.slice(cursor, block.loc.start.offset).replace(/[^\r\n]/g, ' ') + block.content;
      cursor = block.loc.end.offset;
    }
    masked += text.slice(cursor).replace(/[^\r\n]/g, ' ');
    const parsed = typescriptFacts(directory, [{ ...file, syntax_text: masked, script_kind: blocks.some(b => b.lang === 'tsx' || b.lang === 'jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS }]);
    const offset = result.structures.length;
    result.structures.push(...parsed.structures.map(s => ({ ...s, parent_index: s.parent_index === null ? null : s.parent_index+offset })));
    for (const name of ['imports', 'calls']) result[name].push(...parsed[name].map(r => ({ ...r, enclosing_index:r.enclosing_index+offset })));
    result.diagnostics.push(...parsed.diagnostics);
    for (const error of errors) result.diagnostics.push({file_id:file.id, parser:'vue-sfc/'+vueVersion, message:typeof error==='string'?error:error.message});
    result.files.push({file_id:file.id, parser:'vue-sfc/'+vueVersion+'+typescript/'+ts.version, status:errors.length || parsed.diagnostics.length || blocks.length!==supported.length ? 'partial':'parsed', limitations:['template-symbol-bindings-not-resolved', ...(blocks.length!==supported.length?['unsupported-or-external-script-block']:[])]});
    const record = (node, kind, expression) => result.templateExpressions.push({file_id:file.id, parser:'vue-sfc/'+vueVersion, position_encoding:'UTF16CodeUnitOffsetFromLineStart', kind, expression,
      range:[node.loc.start.line-1,node.loc.start.column-1,node.loc.end.line-1,node.loc.end.column-1]});
    function visit(node) {
      if (node.type===5) record(node.content,'interpolation',node.content.content);
      if (node.type===1) {
        if(node.tagType===1) record(node,'component',node.tag);
        for(const prop of node.props) if(prop.type===7 && prop.exp) record(prop.exp,'directive-'+prop.name,prop.exp.content);
      }
      for(const child of node.children || []) visit(child);
    }
    if(descriptor.template?.ast) visit(descriptor.template.ast);
  }
  return result;
}

export function enrichStructures(directory, rows, symbols) {
  const facts = { structures: [], imports: [], calls: [], diagnostics: [], files: [], templateExpressions: [] };
  const merge = result => {
    const offset = facts.structures.length;
    facts.structures.push(...result.structures.map(s => ({ ...s, parent_index: s.parent_index === null ? null : s.parent_index + offset })));
    for (const dataset of ['imports', 'calls']) facts[dataset].push(...result[dataset].map(r => ({ ...r, enclosing_index: r.enclosing_index + offset })));
    facts.diagnostics.push(...result.diagnostics); facts.files.push(...result.files);
    facts.templateExpressions.push(...(result.templateExpressions || []));
  };
  merge(typescriptFacts(directory, rows.files.filter(f => ['typescript', 'javascript'].includes(f.language))));
  merge(vueFacts(directory, rows.files.filter(f => f.language === 'vue')));
  const pythonFiles = rows.files.filter(f => f.language === 'python');
  if (pythonFiles.length) {
    const interpreter = rows.projects.find(p => p.language === 'python' && p.environment.available)?.environment.interpreter;
    const binary = interpreter || (process.platform === 'win32' ? 'py' : 'python3');
    const args = [...(!interpreter && process.platform === 'win32' ? ['-3'] : []), '-I', '-S', fileURLToPath(new URL('./parse-python.py', import.meta.url))];
    try { merge(JSON.parse(execFileSync(binary, args, { input: JSON.stringify({ directory, files: pythonFiles }), encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }))); }
    catch (error) {
      for (const file of pythonFiles) facts.files.push({ file_id: file.id, parser: 'python-ast', status: 'failed' });
      facts.diagnostics.push({ file_id: pythonFiles[0].id, parser: 'python-ast', message: 'Parser unavailable or failed: ' + error.message });
    }
  }
  const fileMap = new Map(rows.files.map(f => [f.id, f])), documentMap = new Map(rows.documents.map(d => [d.id, d]));
  const lines = new Map(rows.files.filter(f => ['python', 'typescript', 'javascript', 'vue'].includes(f.language)).map(f => [f.id, fs.readFileSync(path.join(directory, f.source), 'utf8').split(/\r?\n/)]));
  function anchor(file, range, encoding) {
    if (!range || range[0] !== range[2]) return null;
    const text = lines.get(file)?.[range[0]];
    if (text === undefined) return null;
    const unspecified = !encoding || encoding === 'UnspecifiedPositionEncoding';
    if (unspecified && /[^\x00-\x7F]/.test(text.slice(0, range[3]))) return null;
    const offset = value => encoding === 'UTF8CodeUnitOffsetFromLineStart' ? [...Buffer.from(text).subarray(0, value).toString('utf8')].length
      : encoding === 'UTF32CodeUnitOffsetFromLineStart' ? value : [...text.slice(0, value)].length;
    return `${file}:${range[0]}:${offset(range[1])}:${offset(range[3])}`;
  }
  const definitions = new Map(), references = new Map(), bindings = new Map();
  for (const occurrence of rows.occurrences) {
    const key = anchor(occurrence.file_id, occurrence.range, documentMap.get(occurrence.document_id).position_encoding);
    if(key && (!occurrence.position_encoding || occurrence.position_encoding==='UnspecifiedPositionEncoding')) occurrence.range_encoding_evidence='ascii-prefix';
    if (!key || !occurrence.symbol_id) continue;
    const map = occurrence.role === 'definition' ? definitions : references;
    if (!map.has(key)) map.set(key, new Set()); map.get(key).add(occurrence.symbol_id);
    if (occurrence.role !== 'definition') {
      if (!bindings.has(key)) bindings.set(key, []); bindings.get(key).push(occurrence.id);
    }
  }
  rows.structures = facts.structures.map((structure, ordinal) => {
    const { parent_index, ...record } = structure;
    return { id: id('structure', structure.file_id, structure.range, structure.kind, ordinal), ...record,
      source_sha256: fileMap.get(structure.file_id).sha256, parent_id: parent_index === null ? null : 'pending:' + parent_index, symbol_id: null };
  });
  for (const structure of rows.structures) {
    if (structure.parent_id) structure.parent_id = rows.structures[Number(structure.parent_id.slice(8))].id;
    const candidates = definitions.get(anchor(structure.file_id, structure.name_range, structure.position_encoding));
    if (candidates?.size === 1) {
      structure.symbol_id = [...candidates][0];
      const symbol = symbols.get(structure.symbol_id);
      symbol.structure_ids ||= []; symbol.structure_ids.push(structure.id);
      if (!symbol.name && structure.name) { symbol.name = structure.name; symbol.name_origin = 'syntax'; }
      if (symbol.kind === 'unknown' && normalizedKinds[structure.kind]) { symbol.kind = normalizedKinds[structure.kind]; symbol.kind_origin = 'syntax'; }
    }
  }
  const locate = r => ({ source_sha256: fileMap.get(r.file_id).sha256, enclosing_structure_id: rows.structures[r.enclosing_index]?.id || null });
  rows.imports = facts.imports.map((record, ordinal) => { const { enclosing_index, ...rest } = record; return { id: id('import', record.file_id, ordinal), ...rest, ...locate(record), resolution_status: 'syntax-only' }; });
  rows.calls = facts.calls.map((record, ordinal) => {
    const { enclosing_index, ...rest } = record;
    const key = anchor(record.file_id, record.callee_range, record.position_encoding);
    const candidates = references.get(key);
    const ids = [...(candidates || [])], candidate = ids.length === 1 ? symbols.get(ids[0]) : null;
    const linked = candidate && knownCallable.has(candidate.kind) && candidate.resolution_status === 'defined';
    const external = candidate && ['standard-library', 'dependency'].includes(candidate.origin_classification);
    return { id: id('call', record.file_id, ordinal), ...rest, ...locate(record), candidate_symbol_ids: ids,
      binding_occurrence_ids: bindings.get(key) || [], resolution_evidence: ids.length ? 'syntax-callee-range+producer-occurrence' : null,
      target_symbol_id: linked ? candidate.id : null, external_symbol_id: external ? candidate.id : null, resolution_status: linked ? 'resolved-static' : external ? 'identified-external' : 'unresolved',
      unresolved_reason: linked || external ? null : !record.callee_range ? 'dynamic-callee-expression' : ids.length > 1 ? 'ambiguous-producer-binding' : ids.length === 1 ? 'callable-definition-not-established' : 'no-compatible-producer-binding' };
  });
  rows['syntax-diagnostics'] = facts.diagnostics.map((record, ordinal) => ({ id: id('syntax-diagnostic', record.file_id, ordinal), ...record, source_sha256: fileMap.get(record.file_id).sha256 }));
  rows['template-expressions'] = facts.templateExpressions.map((record, ordinal) => ({id:id('template-expression',record.file_id,ordinal),...record,source_sha256:fileMap.get(record.file_id).sha256,resolution_status:'syntax-only'}));
  for (const file of rows.files) file.structure_result = facts.files.find(f => f.file_id === file.id) || { file_id: file.id, parser: null, status: 'source-only' };
  return { parsed_files: facts.files.filter(f => f.status === 'parsed').length, failed_files: facts.files.filter(f => f.status !== 'parsed').length,
    structures: rows.structures.length, imports: rows.imports.length, calls: rows.calls.length, resolved_static_calls: rows.calls.filter(c => c.resolution_status === 'resolved-static').length,
    identified_external_calls: rows.calls.filter(c => c.resolution_status === 'identified-external').length,
    unresolved_calls: rows.calls.filter(c => c.resolution_status === 'unresolved').length, template_expressions:rows['template-expressions'].length, syntax_diagnostics: rows['syntax-diagnostics'].length };
}
