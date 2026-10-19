# CodeReview development scope

The current stage is repository-to-Code-IR conversion and durable persistence.
Reuse mature parsers/indexers. Deliver inspectable intermediate files, source
snapshots, schema versions, provenance and coverage reports.

Codex may later provide the Agent/reasoning layer. This does not make the entire
project a Codex plugin. Do not add MCP tools, plugin manifests, agent workflows,
question-answering interfaces or analysis features during this stage.

- Preserve raw SCIP alongside normalized IR; do not invent call/dataflow edges.
- Persist enough source and location information to interpret a snapshot after
  the original repository changes or becomes unavailable.
- Keep file-local symbols scoped; retain ranges, enclosing ranges, diagnostics,
  relationships, external symbols and unknown encoding values.
- Schema versions and artifact checksums are part of the storage contract.
- Distinguish semantic coverage from file inventory and syntactic/type validity.
- Never execute inspected applications or install their dependencies implicitly.
- Keep indexes, source snapshots and credentials out of Git.
- Run `npm test` from `semantic-model/`; use real Python and TypeScript indexers
  for adapter verification, plus offline persistence and corruption checks.
- User-facing documentation is Chinese; test fixtures/assertions are English.
- Preserve old local Git history without restoring the previous implementation.
