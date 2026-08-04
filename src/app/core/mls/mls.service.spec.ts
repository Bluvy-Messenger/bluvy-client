// applyCommit's epoch guard (Root Cause #1) now lives in
// mls-commit.service.spec.ts, alongside the rest of MlsCommitService
// (Phase 1 Step 2 of the split).

// processWelcomeForConversation's "no matching KeyPackage" regression
// (forensic audit finding F7) now lives in mls-welcome.service.spec.ts,
// alongside the rest of MlsWelcomeService (Phase 1 Step 1 of the split).

// The commit-lock behavior suite (provisionDevice / reprovisionLostStateDevice /
// removeRevokedDeviceFromAllGroups -- every R1/R10/F10/F1 regression) now lives
// in mls-membership.service.spec.ts, alongside the rest of MlsMembershipService
// (Phase 1 Step 3 of the split).
//
// What's left directly on MlsService after Phase 1 Steps 1-3 (initializeForSession,
// ensureGroupReady, encryptMessage/decryptMessage, key package generation, ...)
// has no dedicated spec file yet -- tracked for Phase 1 Steps 4-5.
