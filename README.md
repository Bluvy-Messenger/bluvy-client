# Bluvy Messenger — Frontend

Bluvy Messenger is a private, end-to-end encrypted messaging application built on
the AT Protocol / Bluesky identity ecosystem. This repository contains the
frontend client only: an Ionic Angular application packaged with Capacitor for
Android, tablets, and web.

End-to-end encryption is implemented with MLS (Messaging Layer Security). All
encryption and decryption happens on this client. The server never has access
to plaintext messages or private key material.

## Status

This project is under active development (V1). Scope for V1:

- Bluesky authentication (DID-based, no local accounts)
- Mutual-followers contacts
- Private one-to-one conversations
- Presence, typing indicators, read receipts
- Multi-device support
- Encrypted backups and full history synchronization

Explicitly out of scope for now: group conversations, media/audio/video, calls,
push notifications, reactions, replies, and link/GIF embeds. Do not open issues
requesting these — see [Feedback](#feedback) below.

## Tech stack

- Ionic Angular
- Capacitor
- TypeScript
- MLS end-to-end encryption

## Getting started

```
npm install
npm start
```

The app runs in a browser first. Android and iOS builds are validated after the
web version works correctly.

## Backend

The backend (Node.js, Express, SQLite, Drizzle ORM, Socket.IO) is closed-source
for now. It remains proprietary while the codebase is being cleaned up and
stabilized. Source access may be granted later to a small number of vetted
individuals who want to directly verify the security model.

This restriction does not weaken the trust model of the product, because of how
responsibilities are split:

- All encryption and decryption happen exclusively on the client, which is the
  code published in this repository.
- The backend is transport-only: it stores and relays encrypted messages,
  encrypted sync blobs, and metadata, and never has the keys required to
  decrypt any of it.
- Private keys, the Master Backup Key, and any other cryptographic secret are
  never transmitted to or stored by the backend.

In addition to this repository being open, the project intends to:

- Publish a public protocol and threat-model document describing the
  cryptographic design in detail, independent of the backend implementation.
- Pursue an independent third-party security audit of the client-side
  cryptography as the codebase matures.

These are treated as roadmap goals, not a firm commitment to a specific vendor
or date.

## Feedback

Feedback is collected at:

https://userinput.app/#/s/did:plc:yz47u7jw457mzifjdk7ojanh/3mposmgdddq2g

This is the primary channel for feedback, ideas, and feature suggestions.
**Feature requests are not accepted through this repository.** Issues opened as
feature requests will be closed and redirected to the link above. See
[CONTRIBUTING.md](CONTRIBUTING.md) for what this repository's issue tracker is
actually for.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a bug report or a pull
request. Both follow a strict, defined procedure.

## Security

Do not open a public issue for a security or cryptography vulnerability. Read
[SECURITY.md](SECURITY.md) for the private disclosure procedure.

## License

Licensed under the MIT License. See [LICENSE](LICENSE).
