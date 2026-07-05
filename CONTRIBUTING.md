# Contributing

This document defines the procedure for reporting bugs and submitting pull
requests to the Bluvy Messenger frontend. Both are strict. Submissions that do
not follow this procedure will be closed without review.

## Before you start

- This repository covers the frontend client only. The backend is closed-source
  and out of scope for contributions.
- Feature requests are not accepted here. Submit ideas and feedback at
  https://userinput.app/#/s/did:plc:yz47u7jw457mzifjdk7ojanh/3mposmgdddq2g
  instead. Issues or pull requests that add new features without a prior
  accepted issue will be closed.
- Security or cryptography vulnerabilities must never be reported as a public
  issue. Follow [SECURITY.md](SECURITY.md) instead.

## Reporting a bug

Use the bug report issue template. Do not open a blank issue. A valid bug
report must include:

1. A clear, specific title.
2. Exact steps to reproduce the issue.
3. Expected behavior.
4. Actual behavior.
5. Environment: platform (web, Android, tablet), browser or OS version, and app
   version/commit hash.
6. Logs, console errors, or screenshots when relevant.

Reports missing reproduction steps or environment details will be labeled
incomplete and closed if not completed within a reasonable time.

## Submitting a pull request

1. **An accepted issue is required first.** Do not open a pull request for a
   change that was not discussed and accepted in an issue, except for trivial
   fixes (typos, broken links, obviously dead code).
2. **One logical change per pull request.** Do not bundle unrelated fixes or
   refactors together.
3. **No unrelated changes.** Do not rename, move, or reformat code outside the
   scope of the linked issue. Do not introduce new dependencies without prior
   discussion in the issue.
4. **Branch naming:** `fix/<short-description>` for bug fixes,
   `chore/<short-description>` for maintenance changes. Feature branches are
   only created after a feature has been explicitly accepted by a maintainer.
5. **Code style:** follow the existing Ionic/Angular conventions already used
   in the codebase. Prefer existing Ionic components over custom UI. Do not
   introduce a new state management pattern, folder structure, or library
   without prior discussion.
6. **Build and lint must pass** before requesting review:
   ```
   npm run lint
   npm run build
   ```
7. **Reference the issue** the pull request resolves in the pull request
   description, using `Fixes #<issue-number>`.
8. **Review is required.** A maintainer must approve the pull request before
   it is merged. Do not self-merge.

Pull requests that do not follow this procedure will be closed and asked to be
resubmitted correctly.
