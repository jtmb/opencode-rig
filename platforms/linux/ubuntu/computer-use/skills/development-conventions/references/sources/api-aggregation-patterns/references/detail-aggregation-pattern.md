# Bounded Detail Aggregation Pattern

## Purpose
Provide a single endpoint that returns the related data required by one detail
view, while keeping ownership and authorization at the correct boundary.

## Endpoint
- `GET /api/resources/:id/detail` (illustrative shape only)

## Response Structure
```json
{
  "metadata": { ... },
  "items": [...],
  "events": [...],
  "status": "..."
}
```

## Benefits
- Reduces several dependent API calls to one bounded request
- Simplifies frontend state management
- Consistent data snapshot for the view

Do not aggregate unrelated resources just to reduce request count. Keep the
response bounded, document its cache/auth behavior, and add focused success and
failure checks before exposing the endpoint.
