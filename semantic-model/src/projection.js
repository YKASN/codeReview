import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, setMetadata } from './store.js';
import { readIRRecords, verifyIR } from './verify-ir.js';

// Rebuild a disposable projection entirely from the saved IR. No repository
// paths, parser subprocesses, target dependencies or application code are read.
export function rebuildSQLite(directory, filename) {
  const validation = verifyIR(directory);
  if (validation.schema_version !== 'code-ir/2') throw new Error('SQLite rebuild requires code-ir/2');
  directory = path.resolve(directory); filename = path.resolve(filename);
  const relative = path.relative(directory, filename);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('Projection must be outside canonical IR directory');
  const temporary = filename + '.' + randomUUID() + '.tmp';
  const db = openStore(temporary);
  let closed = false;
  try {
    db.exec('CREATE TABLE ir_records(dataset TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(dataset,id)); BEGIN;');
    const insert = db.prepare('INSERT INTO ir_records VALUES (?,?,?)');
    for (const dataset of Object.keys(validation.counts)) {
      for (const record of readIRRecords(directory, dataset)) insert.run(dataset, record.id, JSON.stringify(record));
    }
    const files = new Map();
    const insertFile = db.prepare('INSERT INTO files VALUES (?,?,?,?)');
    for (const file of readIRRecords(directory, 'files')) { files.set(file.id, file); insertFile.run(file.path, file.language, file.sha256, file.bytes); }
    const encoding = { UnspecifiedPositionEncoding: 0, UTF8CodeUnitOffsetFromLineStart: 1, UTF16CodeUnitOffsetFromLineStart: 2, UTF32CodeUnitOffsetFromLineStart: 3 };
    const insertDocument = db.prepare('INSERT INTO documents VALUES (?,?,?)');
    for (const document of readIRRecords(directory, 'documents')) insertDocument.run(document.project_id, files.get(document.file_id).path, encoding[document.position_encoding] ?? 0);
    const insertSymbol = db.prepare('INSERT INTO symbols VALUES (?,?,?,?,?,?)');
    for (const symbol of readIRRecords(directory, 'symbols')) insertSymbol.run(symbol.id, symbol.producer_symbol, symbol.name || symbol.producer_symbol, 0, JSON.stringify(symbol.documentation), '[]');
    const insertOccurrence = db.prepare('INSERT INTO occurrences VALUES (?,?,?,?,?,?,?,?)');
    for (const occurrence of readIRRecords(directory, 'occurrences')) insertOccurrence.run(occurrence.symbol_id, files.get(occurrence.file_id).path, occurrence.project_id, ...occurrence.range, occurrence.raw.symbolRoles || 0);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    setMetadata(db, 'snapshot', manifest.snapshot);
    setMetadata(db, 'state', manifest.state);
    setMetadata(db, 'code_ir', { schema_version: manifest.schema_version, directory: path.relative(path.dirname(filename), directory), projection_version: 'code-ir-sqlite/2' });
    setMetadata(db, 'runs', manifest.producers);
    db.exec('COMMIT'); db.close(); closed = true;
    fs.renameSync(temporary, filename);
    return { filename, projection_version: 'code-ir-sqlite/2', records: Object.values(validation.counts).reduce((a, b) => a + b, 0), validation };
  } finally {
    if (!closed) db.close();
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
}
