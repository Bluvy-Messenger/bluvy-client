# Security Policy

## Scope

This policy covers the frontend client in this repository, including the MLS
end-to-end encryption implementation, secure local storage, and sync/backup
encryption logic. The backend is closed-source and is currently out of scope
for external security reports, since it is not publicly available for review.

## Reporting a vulnerability

Do not open a public GitHub issue for a security or cryptography
vulnerability. Public issues are visible to everyone, including before a fix
is available.

Instead, report the vulnerability privately by submitting it through:

https://userinput.app/#/s/did:plc:yz47u7jw457mzifjdk7ojanh/3mposmgdddq2g

Include in your report:

1. A description of the vulnerability and its potential impact.
2. Steps to reproduce, or a proof of concept if available.
3. The affected platform (web, Android, tablet) and app version/commit hash.
4. Whether the issue affects message confidentiality, integrity, key material,
   or availability.

## What happens next

Reports are reviewed as a priority over regular bug reports and feature work.
Once a report is confirmed, a fix is prepared privately, and public disclosure
happens only after the fix has been released, to avoid exposing users in the
meantime.

## Out of scope

- Vulnerabilities that require physical access to an already-unlocked device.
- Reports about the backend implementation, since it is not open-source.
- Social engineering, phishing, or issues unrelated to the code in this
  repository.
