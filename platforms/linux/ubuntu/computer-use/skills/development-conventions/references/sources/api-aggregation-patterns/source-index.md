---
name: api-aggregation-patterns
description: "Patterns for designing bounded aggregation endpoints that combine related data for one view without creating client-side waterfalls."
---

---
name: api-aggregation-patterns
description: "Patterns for designing bounded aggregation endpoints that combine related data for one view without creating client-side waterfalls."
created: 2026-07-11T19:01:12.550Z
---

# API Aggregation Patterns

## 🔴 HARD RULEs
- When one view requires multiple independently fetched data sources, use a
  dedicated aggregation boundary only when it gives a coherent snapshot and
  does not move unrelated ownership into one endpoint.
- Aggregation endpoints should return a single JSON response containing all necessary nested data.

## Description
The bundled example is a generic detail-view pattern. Adapt its fields to the
actual API contract; do not copy project, skill, or observation names into an
unrelated Open Rig surface.

## Reference Files

| File | Content |
|------|--------|
| [`references/detail-aggregation-pattern.md`](references/detail-aggregation-pattern.md) | Detailed specification of the bounded detail aggregation pattern |
