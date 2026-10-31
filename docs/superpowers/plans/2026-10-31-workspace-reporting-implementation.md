# Workspace reporting implementation

Authority: user-approved plan in this conversation, October 31, 2026.

1. Latest bid application location, bidder visibility, country filtering and row styling.
2. Complete notification retirement, including database dependencies and old push workers.
3. Mail-check negotiated v2 publisher with durable deltas and bounded retry backoff.
4. Transactional bid daily summaries; normalized mail summaries; versioned bundled reports and collection status.
5. Dashboard/interview/earnings UI, consistent interview rate, shared sidebar status and scoped browser request cache.
6. Full regression verification, audit evidence and rollout/reconciliation instructions.

Constraints: preserve tenant/financial/file authorization, private responses, existing date/earning semantics and screenshot retention. Latest location persists until bid deletion. No remote deployment or production data mutations during local implementation.
