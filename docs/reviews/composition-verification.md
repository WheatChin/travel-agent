# Composition Focused Verification

Date: 2026-09-08

Status: passed within focused guarded run

## Result

`tests/composition.test.ts` passed as part of the authorized six-file guarded
baseline. Across the complete run, 155 of 156 tests passed; the only failure was
an independent D2 fixture-classification assertion in
`tests/d2-verification.test.ts`, outside Composition implementation and tests.

The run used resolved local Node and Vitest, one worker, no file parallelism,
and the guarded runner defaults of 1536 MiB, 120 seconds, and 8 processes.
Guard/process exit was `1` because of that D2 assertion. Total Vitest duration
was 7.16 seconds and guarded wall time was 8.79 seconds. No guard timeout,
memory, or process-count diagnostic was emitted.

## Covered Contract

The frozen finite Composition suite exercised admission without model calls,
strict schema and supplied-ID closure, malicious-text isolation, duplicate and
day coverage rules, must/exclusion/free-day behavior, lock and explicit-duration
preservation, local frozen days and facts, repair prompting, and sanitized
terminal failure without retry.

This focused result does not prove live model planning quality, provider
availability, persistence atomicity, broader workflow acceptance, builds,
browser behavior, or typecheck status. No retry or additional command was run,
and execution ownership was returned to main.
