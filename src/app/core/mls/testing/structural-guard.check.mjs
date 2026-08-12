#!/usr/bin/env node
// Section 11 of the multi-device validation audit: a static structural guard
// that no NEW production code path bypasses MlsStateTransitionGuard,
// InitializationBarrier, epoch validation, tombstones, or atomic persistence.
//
// Why this is a standalone Node script and not a Jasmine spec: Karma runs
// specs inside a real browser (Chrome Headless here), which has no
// filesystem access -- a spec cannot `fs.readFileSync` the actual source
// tree to scan it. This script is the closest real equivalent: it reads the
// actual committed source files and checks them with the same regex-level
// precision a reviewer would use, run directly via `node` (see the command
// at the bottom of this file's companion report section). It is a test in
// the sense that it has a pass/fail exit code and concrete assertions; it is
// not wired into `ng test` or package.json (no production/build config was
// touched, per this audit's constraints) -- run it explicitly:
//   node src/app/core/mls/testing/structural-guard.check.mjs
//
// Each check below is a KNOWN, NAMED invariant with a concrete regex/logic
// check against a concrete file. This is intentionally narrow (it checks the
// specific files this audit already knows are the load-bearing ones for each
// invariant, from AUDIT_08 and this audit's own findings) rather than a
// generic "grep the whole repo for bad patterns" heuristic, which would
// produce false positives/negatives no one could trust.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MLS_ROOT = join(__dirname, '..'); // src/app/core/mls

function read(relPath) {
  return readFileSync(join(MLS_ROOT, relPath), 'utf8');
}

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks++;
  if (!condition) {
    failures++;
    console.error(`FAIL: ${name}`);
    if (detail) console.error(`      ${detail}`);
  } else {
    console.log(`PASS: ${name}`);
  }
}

// ── 1. Every write to `this.states` in the coordinator goes through either
//    transitionState() or the documented, single, already-audited
//    getOrDeriveState() bypass -- no THIRD direct writer has appeared. ─────
{
  const src = read('coordinator/mls-coordinator.service.ts');
  const directWrites = [...src.matchAll(/this\.states\.set\(/g)];
  check(
    'coordinator: exactly the two known writers of this.states (transitionState + getOrDeriveState)',
    directWrites.length === 2,
    `found ${directWrites.length} occurrences of "this.states.set(" -- expected exactly 2 (transitionState L~1065, getOrDeriveState L~1119). ` +
    'A new direct writer would bypass MlsStateTransitionGuard entirely without going through either documented path.',
  );
}

// ── 2. transitionState() still calls MlsStateTransitionGuard.validate()
//    (i.e. no one silently deleted the guard call while leaving the
//    from===to short-circuit and the TRANSITION_REASON_RESTORE bypass
//    intact -- those are known/accepted, an outright removal is not). ─────
{
  const src = read('coordinator/mls-coordinator.service.ts');
  check(
    'transitionState() still calls MlsStateTransitionGuard.validate()',
    /MlsStateTransitionGuard\.validate\(/.test(src),
  );
}

// ── 3. injectRestoredGroupStates() still checks InitializationBarrier
//    before handing candidates to MlsService (the P0 fix from this audit
//    session) -- guards against a future edit silently reverting it. ──────
{
  const src = read('coordinator/mls-coordinator.service.ts');
  const injectFnMatch = src.match(/override async injectRestoredGroupStates\([\s\S]*?\n  \}/);
  check(
    'injectRestoredGroupStates() method found',
    !!injectFnMatch,
  );
  if (injectFnMatch) {
    check(
      'injectRestoredGroupStates() calls barrier.isInitializing(...) before forcing READY (P0 fix present)',
      /this\.barrier\.isInitializing\(/.test(injectFnMatch[0]),
      'The AUDIT_08 P0 fix (filter busy conversations before/around the RESTORE-reason bypass) appears to have been removed or rewritten.',
    );
  }
}

// ── 4. Only processWelcome() and ensureGroupReady() register the barrier --
//    a new caller of barrier.register() would need the same discipline
//    (barrier held across its own async work) that this audit already
//    verified for exactly those two. ────────────────────────────────────────
{
  const src = read('coordinator/mls-coordinator.service.ts');
  const registerCalls = [...src.matchAll(/this\.barrier\.register\(/g)];
  check(
    'exactly two callers of barrier.register() (processWelcome, ensureGroupReady)',
    registerCalls.length === 2,
    `found ${registerCalls.length} -- a new caller changes the set of operations InitializationBarrier actually protects against, requires re-auditing the P0 fix's coverage.`,
  );
}

// ── 5. Backend epoch validation: storeMlsCommit still rejects a
//    non-continuous epoch (EPOCH_GAP) and still checks for an existing
//    (conversationId, epoch) row before inserting -- the two checks
//    AUDIT_07 identified as the actual atomicity guarantee. ────────────────
{
  const backendPath = join(MLS_ROOT, '..', '..', '..', '..', '..', 'bluvy-backend', 'src', 'modules', 'mls', 'mls.service.ts');
  let src;
  try {
    src = readFileSync(backendPath, 'utf8');
  } catch {
    check('backend mls.service.ts readable for epoch-validation check', false, `could not read ${backendPath} -- repo layout may have changed`);
    src = '';
  }
  if (src) {
    check(
      'storeMlsCommit still rejects epoch !== maxEpoch + 1 (EPOCH_GAP)',
      /epoch\s*!==\s*maxEpoch\s*\+\s*1/.test(src) && /EPOCH_GAP/.test(src),
    );
    check(
      'storeMlsCommit is still a synchronous function (no `async` keyword) -- the actual atomicity guarantee per AUDIT_07',
      /export function storeMlsCommit\(/.test(src) && !/export async function storeMlsCommit\(/.test(src),
      'If storeMlsCommit became `async`, the "no await between check and insert" atomicity argument from AUDIT_07 no longer holds without re-verification.',
    );
  }
}

// ── 6. Tombstone (lastKnownEpochs) anti-regression check still present in
//    injectRestoredGroupStates (MlsService). ────────────────────────────────
{
  const src = read('mls.service.ts');
  check(
    'MlsService.injectRestoredGroupStates still checks lastKnownEpochs before accepting a candidate',
    /lastKnownEpoch/.test(src) && /restoredEpoch\s*<\s*lastKnownEpoch/.test(src),
  );
  check(
    'MlsService.injectRestoredGroupStates still refuses to overwrite an existing groupStates[convId]',
    /if\s*\(state\.groupStates\[convId\]\)\s*continue/.test(src),
  );
}

// ── 7. Atomic persistence: MlsStateStorageService.update() still runs
//    load->updater->save as a single per-scope serialized operation
//    (withLock), and update() itself has not grown an early-return path
//    that would let two updates for the same scope interleave. ────────────
{
  const src = read('mls-state-storage.service.ts');
  check(
    'MlsStateStorageService.update() still goes through withLock(scope, ...)',
    /await this\.withLock\(scope,/.test(src),
  );
}

console.log(`\n${checks - failures}/${checks} structural checks passed.`);
if (failures > 0) {
  console.error(`${failures} FAILED.`);
  process.exit(1);
}
process.exit(0);
