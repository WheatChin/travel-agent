# Travel Agent Development Workflow

## Goal

Use expensive reasoning where it matters and cheap execution where it does not:

- `gpt-6-astra` for the main thread, orchestration, architecture, and design decisions.
- `gpt-5.6-sol` for bounded implementation and verification work.

## Phase Model

### 1. Orchestrate and Design

Run on the main thread with `gpt-6-astra` and `model_reasoning_effort = "high"`.
For complex subproblems, spawn the `orchestrator` custom agent.
Output: an approved design document under `docs/design/` with explicit scope,
component boundaries, interfaces, and test expectations.

The canonical acceptance matrix is [design Section 20](design/0001-mvp-product-and-workflow.md#20-verification-strategy).
Use its stable `AC-01` through `AC-17` IDs instead of maintaining another checklist with different rules.

### 2. Implement

Delegate bounded coding tasks to the `coder` agent, which runs
`gpt-5.6-sol` at low reasoning effort. The coder follows the approved
design and does not change architecture.

Each assignment names its phase, owned files/modules, applicable acceptance IDs,
inputs/outputs, and exclusions. Add tests alongside the behavior. Tasks involving
scheduling or live adapters must first pin the concrete policy values required by
the design; the coder must not invent unresolved policy. Independent phases may
proceed while credentials block an external integration, but blocked gates remain open.

### 3. Test

Delegate verification to the `tester` agent, which runs `gpt-5.6-sol` at
low reasoning effort. The tester adds or runs tests, reports failures with
reproduction steps, and returns a pass/fail summary.

For every assigned acceptance ID, report `pass`, `fail`, `blocked`, or `not_run`,
with implementation revision, fixture/prompt/policy versions, test command or
manual steps, and observed evidence. Document review can confirm contract coverage,
but cannot mark an application acceptance test as passed. Fixture success is not
live-provider success; normal CI uses fakes and a separate report records live smoke tests.

The main thread checks the phase exit rules before declaring a phase complete.
Route implementation failures back to `coder`; return design contradictions to
orchestration before further coding. Hard invariant failures block the affected
gate. Record startup, test, migration, and verification commands here once the
scaffold supplies real commands; do not invent them before implementation.

## Local Desktop Development

Execution safety override: commands below are reference commands, not direct
execution instructions. The runner in `design/0008-bounded-local-execution.md`
has passed finite acceptance (see `reviews/guarded-runner-verification.md`).
Business implementation and explicitly authorized focused tests may resume.
Main grants one command execution owner at a time; run the resolved executable/CLI
through the guard, with one worker and no file parallelism for Vitest.
Builds, browsers and broad verification remain separately gated.
Do not invoke the existing startup/verification scripts until their execution
paths have been reviewed for the same protection.

Run commands from the `travel-agent` project directory. Phase 1 serves local
fixture data only and requires no provider credentials, database, or migrations.
The supported acceptance viewports are 1024x768, 1280x800, and 1440x900.

```powershell
npm ci
npx playwright install chromium
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Use another free port when 3000 is occupied. For a production-mode check, run
`npm run build`, then `npm run start -- --hostname 127.0.0.1 --port 3000`.

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

The browser suite manages its own test server through `playwright.config.ts`.
Commands are not evidence of success by themselves. Actual results and Phase 1
limitations are recorded in [the verification report](reviews/phase1-verification.md).
The implementation scope is [design 0002](design/0002-phase1-desktop-implementation.md).
Do not put provider keys in source, fixtures, public assets, or test commands.

## Model Map

| Role | Custom agent file | Model | Reasoning |
| --- | --- | --- | --- |
| Main thread | `.codex/config.toml` | `gpt-6-astra` | `high` |
| Orchestration / design | `.codex/agents/orchestrator.toml` | `gpt-6-astra` | `high` |
| Implementation | `.codex/agents/coder.toml` | `gpt-5.6-sol` | `low` |
| Testing / verification | `.codex/agents/tester.toml` | `gpt-5.6-sol` | `low` |

Project-wide subagent defaults are in `.codex/config.toml`. The model catalog
and provider credentials are machine-level configuration under `~/.codex/`.

## Escalation Rules

- If implementation cannot follow the design, the `coder` agent stops and
  returns to orchestration; it does not invent a new design.
- If testing reveals design-level defects, the `tester` agent reports them and
  orchestration revises the design before coding resumes.
- Model routing changes go through `.codex/agents/*.toml` and the user-level
  default, not through ad-hoc prompt instructions.
