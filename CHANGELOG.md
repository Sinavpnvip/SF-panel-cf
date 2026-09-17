# Changelog

## 2.1.0 — 2026-09-17

### Security
- Removed hardcoded default admin credentials (SF-001).
- Trusted-proxy-aware client IP (SF-003).
- Session tokens bound to active administrator identity (SF-006).
- Backup export redacts secrets by default (SF-005).
- Secret rotated on restore and password change.
- Security response headers added.
- Non-root Docker user; pinned Xray version (SF-010).

### Bug fixes
- Inbound seed column mapping corrected; automatic repair for legacy swapped ports (SF-002).
- `extend_account` no longer reports success when Xray restart fails (SF-004).
- Settings updates validate fully before any write (SF-008).
- Telegram test no longer blocks the event loop (SF-007).
- Minimum password length raised to 8 characters.

### UI / UX
- CSS polish: focus rings, reduced-motion, LTR isolation for technical values, empty states, status badges.

### Documentation
- Accurate aiohttp-based README and deployment guides.
- Architecture, VPS, Cloudflare hybrid, migration, and test report docs.

### Deployment
- Hybrid Cloudflare Workers + VPS node-agent path documented and scaffolded under `workers/` and `node-agent/`.
