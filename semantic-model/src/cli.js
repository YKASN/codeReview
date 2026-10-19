#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { scan } from './scan.js';
import { verifyIR } from './ir.js';

const help = `Repository to persistent Code IR (Node 24+)
  scan --repo ABSOLUTE_PATH --out OUTPUT_PATH [--languages python,typescript] [--python ABSOLUTE_PATH]
  verify --ir PATH_TO_CODE_IR_DIRECTORY
Each completed scan persists code-ir/manifest.json, JSONL records, source blobs,
raw SCIP, model.sqlite and report.json. No agent or analysis tools are started.
`;
try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') console.log(help);
  else {
    const options = {};
    const allowed = new Set(command === 'scan' ? ['repo', 'out', 'languages', 'python'] : command === 'verify' ? ['ir'] : []);
    if (!allowed.size) throw new Error(`Unknown command: ${command}`);
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].slice(2);
      if (!args[i].startsWith('--') || !allowed.has(key) || !args[i + 1]) throw new Error(`Invalid option: ${args[i]}`);
      options[key] = args[i + 1];
    }
    let result;
    if (command === 'verify') {
      if (!options.ir) throw new Error('--ir is required');
      result = verifyIR(path.resolve(options.ir));
    } else {
      if (!options.repo || !options.out) throw new Error('--repo and --out are required');
      if (!fs.statSync(options.repo).isDirectory()) throw new Error('Repository must be a directory');
      result = await scan(options.repo, options.out, { languages: options.languages?.split(','), python: options.python });
      if (result.state !== 'indexed') process.exitCode = 2;
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
