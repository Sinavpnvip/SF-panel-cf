# SF-Panel Audit Ledger (v2.1.0)

**Baseline commit:** `1fdcf44eb330c9ebb861646b86814c536b361e68`  
**Audit date:** 2026-09-17  
**Auditor role:** Static + targeted code review against assignment findings.

## Preliminary findings disposition

| ID | Severity | Status | Evidence / Fix |
|----|----------|--------|----------------|
| SF-001 | Critical | **Fixed** | `app.py` removed `DEFAULT_ADMIN_USER/PASS`. `seed_from_env` only acts when both env vars are set and strong enough. First-run uses `/api/setup`. |
| SF-002 | High | **Fixed** | `api/handlers_auth.py` `seed_first_data` column order corrected (`enable=1`, `internal_port=port`). `db.repair_seed_port_bug()` detects classic swapped pattern on startup. |
| SF-003 | High | **Fixed** | `api/common.py` `client_ip` only trusts `X-Forwarded-For` when `request.remote` is in `TRUSTED_PROXIES` (or loopback in PaaS). |
| SF-004 | High | **Fixed** | `telegram/panel_link.py` `extend_account` returns `(ok, err)`, rolls back DB on Xray restart failure. |
| SF-005 | High | **Fixed** | `export_all(include_secrets=False)` by default strips `tg_token`, `totp_secret`, `admin_pass`, `secret`. Full export opt-in via `?full=1`. |
| SF-006 | High | **Fixed** | `auth_required` checks token username against live `admin_user`. `import_all` always rotates `secret` after restore. |
| SF-007 | Medium | **Fixed** | `api_tg_test` uses `run_ex` (thread pool) instead of blocking `requests.get`. |
| SF-008 | Medium | **Fixed** | `api_set` validates all fields into `updates` dict first, then writes atomically. |
| SF-009 | Medium | **Fixed** | README rewritten for aiohttp (not Django). Env vars aligned with `core/config.py`. |
| SF-010 | Medium | **Partially fixed** | Dockerfile pins Xray version via `ARG`, runs as non-root `sfpanel` user. Full checksum verification of Xray release still recommended for production (documented). |

## Additional findings addressed

| Area | Finding | Remediation |
|------|---------|-------------|
| Auth | Password min length 6 too weak | Raised to 8 in setup/password change |
| Auth | Token accepted any signed username | Bound to active admin_user |
| Browser | Missing security headers | Middleware: X-CTO, X-Frame-Options, Referrer-Policy, CSP (VPS) |
| Settings | Secret masking in GET | `tg_token` returned as `***` / `tg_token_set` flag |
| Restore | Sessions survive restore | Secret rotation forces re-login |

## Remaining limitations (honest)

- No automated test suite was executed end-to-end against a live Xray binary in this environment (no long-running privileged container with full network).
- Encrypted-at-rest backup (AEAD) not implemented; secrets are simply omitted from default export.
- Telegram bot concurrency (wallet/coupon races) improved only at the provisioning layer; full ledger idempotency would need deeper shop DB redesign.
- Cloudflare Workers control plane is provided as a **hybrid skeleton** (see `docs/DEPLOY_CLOUDFLARE.md`); full TypeScript rewrite of the control API is out of scope for a single pass and would break behavioral parity without extensive contract tests.
- Xray integrity: version pinned, but SHA256 of the release asset is not verified at build time (supply-chain residual risk).

## Regression notes

Characterization tests under `tests/` cover seed mapping, token binding, and export redaction. Run:

```bash
python -m pytest tests/ -q
```
