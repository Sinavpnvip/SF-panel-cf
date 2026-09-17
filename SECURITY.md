# Security Policy

## Assumptions
- The panel is intended to be reachable only by the operator (or behind authentication + TLS).
- Xray node traffic is separate from the control plane.
- Telegram bot token and admin chat IDs are secrets.

## First-run
1. Prefer setting `ADMIN_USER` and `ADMIN_PASS` (min 8 chars) via environment, **or**
2. Open the panel once and complete `/api/setup` from a trusted network.
3. Immediately enable TOTP from Settings.
4. Change any temporary password.

Legacy installations that still use the old default credentials (`sinamzxr` / `Sina990`) **must** change the password and rotate the session secret (password change does this automatically).

## Secrets
- Never commit `.env`, `data/`, or full backups containing secrets.
- Default JSON backup omits `tg_token`, `totp_secret`, `admin_pass`, `secret`.
- Store full backups offline with filesystem encryption.

## Reporting
Report vulnerabilities privately to the repository owner. Do not open public issues with exploit details.
