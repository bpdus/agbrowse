Self-review of the auth review fixes.
ensureKey no longer treats a post-rename directory fsync error as success.
revokeDevice marks the device revoked before save and commitState merges disk revocations before every later save.
assertStoragePath lstats every path component and atomicWrite revalidates owner uid and mode 0700.
expiredChallenges is capped at 1024.
APPROVAL-FLOW no longer offers chat or alternate decision paths.
No commit was made.
