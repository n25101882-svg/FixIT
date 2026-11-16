# FIX-17 — future Windows 11 QA checklist

**NOT RUN on Windows.** The owner currently has no local PC access. All required automated checks were performed independently in Codex Cloud; Windows manual QA is future corroboration, not a gate for creating PR #12. [Actual results/security limits](FIX_17_REFRESH_SESSIONS.md).

## Safe preparation

Use Git, Node24/npm11, PostgreSQL18 and Chromium. Switch to `fix/fix-17-refresh-sessions`. Create only a new authorised loopback database such as `fixit_sessions_windows_test`; set DATABASE_URL and TEST_DATABASE_URL to this same new DB in a private .env copied from .env.example. Never use fixit_dev, existing fixit_test/fixit_shadow, Render or production. Do not overwrite an existing role/password or database. No shadow is needed for migrate deploy. Set a private random JWT_SECRET, JWT_TTL_SECONDS=900 and SERVE_FRONTEND=0. Never share secret values, cookie contents or real connection strings.

```powershell
git fetch origin
git switch fix/fix-17-refresh-sessions
if (!(Test-Path .env)) { Copy-Item .env.example .env }
# Configure the private new test DB/secret before the following commands.
npm ci --include=dev
npm exec playwright install chromium
npm run release:verify
```

Use Windows Chromium normally; do not set the Cloud Linux executable path. release:verify runs typecheck, builds, four migrations/status/checks, all tests/coverage and the real browser scenarios. Existing test ports must be free:4100/5174/4200; Playwright does not reuse a running app. It builds a production React bundle for the single-origin server automatically. Nothing deploys to Render.

For migration evidence, separately create two additional NEW EMPTY *_test databases, set private CLEAN_DATABASE_URL and UPGRADE_DATABASE_URL, then run npm run test:migrations. Used pairs remain nonempty; rerun only with another new pair, never reset/drop/clean old data.

## Interactive local workflow

In separate PowerShell terminals at the repo root run npm run dev and npm run frontend:dev. Open **http://127.0.0.1:5173**, API **http://127.0.0.1:3000**. Use the **same hostname on both sides**; do not mix localhost and127.0.0.1 because SameSite cookie behaviour differs. The example exact CORS origins and Vite default support this workflow. Dev HTTP uses only fixit_refresh_dev on actual loopback; it is not a production Secure=false override. Production-like automated tests use a real Secure __Host cookie on browser-trusted localhost.

Use synthetic CLIENT/MASTER accounts registered through the UI. MASTER registration needs its existing profile/first-service fields. Check:

- [ ] Login as CLIENT. Open /dashboard and /orders, then press F5. Bootstrap shows loading, not a premature Login redirect; current user/role is retained.
- [ ] Open own CUSTOM and STANDARD detail URLs, then F5. Exact detail URL is retained; safe returnTo still rejects outside URLs when login is needed.
- [ ] Login as MASTER and F5 on /master/orders, assigned detail and /master/services. Private CLIENT routes remain forbidden to MASTER.
- [ ] In Network, business calls carry Bearer and auth calls carry Cookie/Origin/X-FixIT-CSRF. No refresh verifier appears in JSON or URL. Never publish header values.
- [ ] Inspect cookie **metadata only**. Development: host-only/HttpOnly/Lax/Path=/. Production after approved deployment: __Host-fixit_refresh plus Secure, no Domain. Confirm expiry is bounded, not extended seven days at each refresh.
- [ ] Check localStorage, sessionStorage and IndexedDB contain no tokens. Refresh token must not be JavaScript-readable. Access JWT exists only in memory.
- [ ] Open two tabs, refresh both. Normal recovery works; Logout in one clears the other. Switch accounts and verify the earlier account's cards never reappear.
- [ ] Logout then F5. Protected access requires login. Server row is revoked; the UI clears memory immediately.
- [ ] Take the API offline during Logout, then F5. Pending non-secret logout intent prevents refresh recovery; when the server returns, retry completes revocation. Do not interpret a network error as server revocation success.
- [ ] Check a temporary network/5xx refresh failure offers retry without destructive logout;403 and terminal401 remain distinct. Avoid intentionally replaying a real person's cookie.
- [ ] Run synthetic CUSTOM and STANDARD creation/selection/acceptance/execution to COMPLETED. Another CLIENT/MASTER cannot view private details. History survives F5; cancellation after work is forbidden.

Backend replay/expiry/concurrency checks are already automated against new isolated Cloud DBs; prefer those tests to manually copying refresh tokens. A spent verifier never receives new credentials. A replay outside the two-second window revokes only that session family. After Logout an already copied access JWT can still be valid until its15-minute expiry; this is documented, not full JWT revocation.

## Safe DB corroboration and evidence

With approved private libpq bindings for the new test DB only, a read-only query can inspect session metadata without hashes/verifiers:

```sql
SELECT id, created_at, last_used_at, expires_at, generation, revoked_at, revoked_reason
FROM auth_sessions
ORDER BY created_at DESC;
```

No passwords, connection strings, token_hash, previous_token_hash, Authorization, Cookie or Set-Cookie **values** in screenshots/reports. Record actual timestamp, OS/browser, tested SHA and statuses; leave unperformed steps NOT RUN. No screenshots are supplied or fabricated by this task. Real Render HTTPS/edge/free-plan/backup checks require separate deployment approval and are listed in DEPLOYMENT_RENDER.md.
