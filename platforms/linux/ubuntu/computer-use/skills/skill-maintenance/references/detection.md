# Detecting Maintenance Needs

Read this file explicitly when looking for missing, overlapping, or stale
skill coverage. Detection produces evidence and a bounded recommendation; it
does not authorize unrelated edits.

## Signals

### New capability

A new application, framework, file type, or repeated workflow may need a skill
when the existing catalog has no clear route for likely user requests. A new
dependency alone is not sufficient; prefer project instructions or ordinary
documentation unless reusable agent behavior is needed.

### Repeated operating convention

Look for the same safety rule, verification sequence, setup procedure, or
failure mode across several tasks. A skill is useful when loading that guidance
on demand would reliably improve future execution.

### Missing routing coverage

Compare actual user intents and repository responsibilities with the routing
table in root `AGENTS.md` and the catalog in `skills/README.md`. A gap exists
only when no current skill reasonably owns the workflow.

### Drifted content

Confirm claims against current code and authoritative documentation. Common
drift includes moved paths, changed commands, obsolete versions, incorrect
permissions, missing confirmation gates, and references that no longer exist.

### Overlap or excess scope

Skills that trigger on the same requests or duplicate most instructions may
need clearer boundaries or consolidation. Do not merge or retire them without
checking all references and obtaining deletion confirmation where required.

### Catalog or deployment drift

Check whether `skills/README.md` reflects source directories and whether the
generated deployed bundle recursively matches canonical source. Treat a
deployment mechanism that copies only `SKILL.md` as incomplete for split
skills.

## Decision record

For each finding, report:

- evidence and affected paths
- whether the issue is in requested scope
- smallest proposed correction
- verification needed
- unrelated opportunities, clearly separated and left unchanged
