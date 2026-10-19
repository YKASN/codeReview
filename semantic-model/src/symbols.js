// Read only the package header using SCIP's documented doubled-space escaping.
// Descriptor syntax is preserved verbatim; no name/kind is guessed from it.
export function parseSymbolIdentity(raw) {
  if (!raw || raw.startsWith('local ')) return null;
  let offset = 0; const fields = [];
  for (let field = 0; field < 4; field++) {
    let value = '', ended = false;
    while (offset < raw.length) {
      const char = raw[offset++];
      if (char !== ' ') { value += char; continue; }
      if (raw[offset] === ' ') { value += ' '; offset++; continue; }
      ended = true; break;
    }
    if (!value || !ended) return null;
    fields.push(value);
  }
  if (!raw.slice(offset)) return null;
  return { scheme: fields[0], manager: fields[1], package_name: fields[2], package_version: fields[3], descriptor: raw.slice(offset) };
}
const packageKey = identity => JSON.stringify([identity.scheme, identity.manager, identity.package_name, identity.package_version]);
export function classifySymbolOrigins(symbols) {
  const identities = new Map(symbols.map(s => [s.id, parseSymbolIdentity(s.producer_symbol)]));
  const owned = new Set(symbols.filter(s => s.definition_ids.length && identities.get(s.id)).map(s => packageKey(identities.get(s.id))));
  for (const symbol of symbols) {
    const identity = identities.get(symbol.id); symbol.identity = identity;
    symbol.origin_classification = symbol.definition_ids.length ? 'snapshot' : !identity ? 'unknown'
      : identity.manager === 'python' && identity.package_name === 'python-stdlib' ? 'standard-library'
        : owned.has(packageKey(identity)) ? 'snapshot-package-unindexed'
          : ['python', 'npm'].includes(identity.manager) && !['.', ''].includes(identity.package_name) && !['.', ''].includes(identity.package_version) ? 'dependency' : 'unknown';
    if (!symbol.definition_ids.length && ['standard-library', 'dependency'].includes(symbol.origin_classification)) symbol.resolution_status = 'external';
  }
}
