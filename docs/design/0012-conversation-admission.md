# Durable Conversation Admission

Status: main-approved C1 implementation scope below. C2 dispatch integration
remains a subsequent slice; C1 alone does not satisfy full AC-02/09/15.
This implements the preacceptance obligations of 0011 without a new framework.

## C1 Submission Ledger

Extend the existing SQLite repository, not a second database/connection owner.
The repository hides transactions, credential validation, payload equality,
attempt limits and claim fencing. Interpretation remains an injected module.
Use migration 3 and real SQLite tests, including close/reopen and two connections.

Add these credential-scoped operations with strict Turn parsing:

```text
reserveInterpretation(credential, turn)
  -> {status: "accepted", outcome: AcceptedTurn}
   | {status: "saved", output: unknown}
   | {status: "busy"}
   | {status: "exhausted"}
   | {status: "reserved", claim: InterpretationClaim}

saveInterpretation(credential, claim, output)
releaseInterpretation(credential, claim)
```

Claims are internal capabilities, never HTTP payloads. A claim exposes only
Conversation ID, Turn ID, attempt number and lease expiry; its object identity
is registered in a private WeakMap to Owner and durable fence. Copied, forged,
cross-Owner and expired claims fail. Reopening a repository cannot reuse an old
in-memory claim, but an expired durable lease allows a new reservation.

The table key is Owner + Conversation + Turn ID. Store canonical full Turn,
attempt count (0..2), monotonically increasing fence, lease expiry, accepted
normalized output JSON or null, and creation/update timestamps. Never store
credentials, model transport bodies or trusted prompts. Output is internal JSON
already validated by interpretation; bound it to 128 KiB UTF-8 and reject
non-JSON values, cycles, non-finite numbers and values lost by JSON encoding.
Return independent deserialized values. C2 revalidates its expected schema.

Each operation authorizes the credential afresh and checks owned Conversation
linkage. A missing or foreign resource returns the same NOT_FOUND.
`reserveInterpretation` only admits `user_message`; Typed Commands do not use it.
Do not call providers, generate a Run, update a Brief or supersede anything.

Within one short BEGIN IMMEDIATE transaction:

1. Look for an already accepted Turn with this key. Compare canonical input
   before returning its saved outcome. Different input is IDEMPOTENCY_CONFLICT.
   An exact accepted replay takes precedence over current bases and any old
   interpretation lease, even if a newer itinerary now exists.
2. Check an existing ledger row's canonical input. A changed input conflicts
   before any attempt or lease change. Saved output returns immediately, without
   consuming another attempt and without requiring the base to remain current.
3. Validate the original request's resource references before a new reservation.
   An empty Conversation requires null Trip/version and Brief revision zero.
   An existing Conversation requires its exact Trip. A non-null version must
   belong to that Trip. The requested Brief revision must exist in that Trip's
   immutable brief_revisions. For a null version, require the current Brief
   revision and current version also null. For a non-null historical version,
   permit the historical reference, but reject a Brief revision older than that
   version's own revision. Historical admission does not authorize mutation.
4. A still-live lease returns busy. Otherwise, if two attempts were consumed,
   return exhausted. Never reset attempts due to a new connection, expiry,
   transient provider failure or page reload.
5. Atomically increment attempt and fence and grant a 90-second lease, then
   commit before returning a registered claim. This exceeds the adapter's
   60-second deadline. No polling, automatic retry or lease renewal is inside
   this operation.

`saveInterpretation` requires the live registered claim, matching durable fence,
attempt and Owner/Conversation/Turn linkage. Persist normalized accepted output
and clear the lease atomically. Do not require current mutation bases here:
the accepted interpretation may still support a historical read; C2 must
recheck current bases before any mutation. A late worker cannot replace a saved
output. An exact repeated save through the original claim may return the saved
output without another write, even after expiry; changed output conflicts.
Replay still requires live Owner authorization and matching claim binding.

`releaseInterpretation` relinquishes a live matching claim after a transient
failure, without decrementing attempts or storing failure text. A stale claim
cannot clear a newer lease. Non-retryable interpretation failures may be saved
as the normalized closed failure output, ensuring stable replay. The caller
applies provider policy and performs at most the one remaining attempt.

No public general-purpose SQL, transaction callback or caller-supplied Owner ID
is introduced. Preserve existing repository acceptance/commit behavior and its
tests. Reuse the existing clock and transaction/error conventions.

## C1 Verification

Finite tests through repository public methods prove:

- Invalid/expired credentials, foreign Conversation/Trip/version and mismatched
  Brief are rejected without creating a reservation or changing a Run.
- Same payload has one live reservation across two SQLite connections; changed
  payload conflicts. JSON key order differences compare canonically.
- Saved normalized output replays as independent values with zero extra attempt.
- Close/reopen retains attempts; advancing injected time permits takeover once;
  attempt three is exhausted. No real sleep or unbounded producer.
- Forged/copied/cross-Owner/expired/old-fence claims cannot save or release.
- Exact repeated save is harmless; changed output cannot replace saved output.
- Release permits only the remaining attempt, never resets the budget.
- Already accepted exact Turns replay even after their bases advance; changed
  payload conflicts without a new reservation.
- Historical read references are admitted, but reserving/saving cannot alter a
  Trip, Brief, version, mutation sequence or active Run.
- Typed Commands reject this path before reservation. Oversized or non-JSON
  output cannot become durable accepted output.

## C2 Integration Obligations

The next implementation composes C1 with 0011 and existing deterministic
requirement assessment. It must persist the frozen interpretation context or
its reconstructable immutable references, use adapter reservation exactly once
per actual attempt (no double reservation), and reconstruct context only from
this owned Conversation. Existing accepted Turn replay precedes any model call.

Current-base rechecks remain in atomic mutation acceptance after interpretation.
Read-only history requests cannot supersede a Run. Uncertain interpretation
scope is a conversation question, not speculative Run acceptance. Deterministic
Requirement Issues for an unambiguous planning request follow the baseline
needs_input Run path; all known issues are returned together.

C2 must also persist question/read messages before any Trip exists, store
assistant outcomes, and atomically map an explicit new-destination request to
its new Conversation/Trip. It must not implement those through independent
create-then-save transactions that can orphan or duplicate work. A saved source
dispatch outcome must replay the same destination IDs. Bound clarification,
cancel and retry retain their strict existing contracts.

These C2 persistence and dispatch additions require a concrete implementation
amendment before coding them. H1 library reads remain independent of C1; no
claim, lease, prompt or accepted interpretation internals may appear in HTTP.
