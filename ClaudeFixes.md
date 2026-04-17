That said, here are 100 adversarial questions to throw at the codebase — organised by domain so Copilot can work through them systematically.

---

**Authentication & Sessions (1–12)**

1. What happens if a user submits an empty string as their PIN during registration?
2. Can two users register with identical display names, and if so, how does the frontend distinguish them?
3. What is the bcrypt work factor and is it appropriate for a PIN (low-entropy secret)?
4. If `JWT_SECRET` falls back to a dev value in non-production, what exactly is that fallback value and is it hardcoded in source?
5. Can a JWT token be invalidated before its TTL expires — is there a token blacklist or revocation mechanism?
6. What happens if `SESSION_TTL_DAYS` is set to 0 or a negative number — does the clamp actually enforce the 1-day floor?
7. Is the PIN stored as a hash in the database, and is the raw PIN ever logged at any point in the request lifecycle?
8. Does the auth rate limiter reset per IP across server restarts, or is its state lost?
9. Can a user change their PIN while another session is active on a different device — and does the old token remain valid?
10. What happens if someone sends a `Content-Type: text/plain` body to `POST /api/auth/login` instead of JSON?
11. Is there any account lockout after repeated failed PIN attempts, or does the auth rate limiter alone handle this?
12. Can a user register with a PIN that is entirely whitespace?

---

**Authorization & Access Control (13–22)**

13. Does `PATCH /api/requests/:id` verify that the requester is actually a party to that request, or just that they're authenticated?
14. Can user A confirm or dispute a payment that was sent between user B and user C?
15. Can a user read messages on a request they have no relationship to by guessing the request ID?
16. Is `household_id` validated on every write operation, or only at registration time?
17. Can a user from household A send a payment request to a user from household B?
18. What prevents an authenticated user from brute-forcing sequential request/payment IDs to enumerate other households' data?
19. Is the admin role enforced server-side on invite creation, or is it just a frontend convention?
20. Can a non-admin member generate an invite code by calling `POST /api/auth/household/invites` directly?
21. What happens if a user is removed from a household — do their historical transactions remain accessible to other members?
22. Is there any ownership check when a user tries to delete or cancel a pending request they didn't create?

---

**Data Integrity & Edge Cases (23–38)**

23. What is the minimum and maximum value of `amount_cents` — can a user create a request for R0.00 or a negative amount?
24. What happens if `amount_cents` overflows a SQLite integer for a very large value?
25. Can a user accept their own money request (be both requester and requestee)?
26. What happens if a request is accepted twice due to a race condition or duplicate submission?
27. Is there a foreign key constraint between requests/payments and users — what happens if a user account is deleted mid-transaction?
28. Can a payment be confirmed before it has been accepted as a request?
29. What is the maximum length of a chat message and is it enforced server-side?
30. Can a message be sent on a request that is already in a terminal state (rejected/settled)?
31. What happens to pending requests if the requestee's account is deleted?
32. Is `amount` in API responses always exactly `amount_cents / 100`, or is there rounding logic that could produce drift?
33. Can two simultaneous `PATCH` requests on the same request ID produce an inconsistent state — is there row-level locking?
34. What happens if `offset` in a paginated request is larger than the total record count?
35. Is there a maximum on `limit` for paginated endpoints — can a client request 1,000,000 records in one call?
36. What happens if a user sends a payment for a different amount than the original request?
37. Can the household name be an empty string or only whitespace?
38. Is there a uniqueness constraint on invite codes — what happens if two admins generate codes at the same time?

---

**API Design & Input Validation (39–52)**

39. Are all user-supplied strings sanitised before being stored — is SQL injection possible through any field?
40. Is there protection against excessively long strings in display name or household name fields?
41. Does the API return different HTTP status codes for "not found" vs "forbidden" — or does it flatten both to 404 to avoid enumeration?
42. Are `limit` and `offset` query parameters validated as positive integers — what happens if they're strings or floats?
43. What does the API return if a required field is missing from a POST body entirely vs. present but null vs. present but empty string?
44. Is there any output encoding to prevent stored XSS if the frontend renders user-supplied display names or message content as HTML?
45. Does `PATCH /api/requests/:id` accept partial updates or does it require the full object?
46. What HTTP methods are accepted on endpoints that only define one — does `DELETE /api/requests/:id` accidentally work?
47. Are CORS headers configured and if so what origins are whitelisted?
48. Is there a `Content-Security-Policy` header served with the frontend?
49. Does the health endpoint at `GET /api/health` expose any sensitive runtime information (env vars, file paths, internal IPs)?
50. What is the behaviour when the JSON body limit is exceeded — does Express return a useful error or crash the request handler?
51. Are there any endpoints that accept `application/x-www-form-urlencoded` unintentionally due to Express body parser config?
52. Is the `X-Request-Id` header generated server-side or trusted from the client — can a client inject their own request ID?

---

**Frontend & Client-Side (53–63)**

53. Is the JWT stored in `localStorage`, a cookie, or memory — and what are the XSS implications of that choice?
54. Does the frontend sanitise message content before rendering it in the chat thread?
55. What happens in the UI if the server returns a 429 rate limit response — is there user-facing feedback?
56. Is the retry logic for GET requests idempotency-safe, and does it retry on 5xx as well as network failures?
57. Does `window.POCKETTAB_CONFIG` get validated before use — can a malicious script on the page override retry behaviour?
58. What happens in the frontend if the JWT expires mid-session — is there a redirect to login or a silent failure?
59. Is there any CSRF protection given the app uses JWT — what prevents a malicious site from triggering authenticated requests?
60. Does the frontend handle the case where `amount` in an API response is `null` or `undefined` without crashing?
61. Is there a loading/disabled state on submit buttons to prevent double-submission of requests or payments?
62. What happens in the UI if two devices are logged in as the same user and one makes a state change — does the other update?
63. Are there any `console.log` statements in production frontend code that could leak token values or user data?

---

**Multi-tenancy & Household Logic (64–72)**

64. Is every database query that returns household data filtered by `household_id` at the query level, or does application code do the filtering?
65. What happens if a user somehow has a null `household_id` — do they see all records or none?
66. Can an invite code be used more than once, enabling multiple users to join with the same code?
67. Is there a maximum number of members per household?
68. Can a household exist with zero members — what happens to its data if the last member leaves or is deleted?
69. Is there an audit log of who joined a household via invite code and when?
70. If a user creates a household and then joins a different one via invite code, what happens to the original household?
71. Can a user be a member of more than one household simultaneously?
72. Is `household_id` exposed in any API response where it shouldn't be (e.g. in the user list endpoint)?

---

**Database & Persistence (73–82)**

73. Is WAL mode enabled on SQLite — what are the read/write concurrency implications under load?
74. Are database migrations versioned — what happens if the schema changes and an old backup is restored?
75. Is there a database connection pool or is a single connection shared across all requests?
76. What happens if the SQLite file becomes corrupted mid-write — is there any integrity check on startup?
77. Are there indexes on foreign key columns (e.g. `user_id`, `household_id`) — what is query performance like at scale?
78. Does the backup script verify the integrity of the backup file after writing (`PRAGMA integrity_check`)?
79. What is the restore procedure's behaviour if the target DB path doesn't exist vs. exists and has active connections?
80. Is the backup directory itself protected — can a web request reach any file under `./backups`?
81. What happens if `DB_BACKUP_KEEP` is set to 0 — does the pruning logic delete all backups?
82. Is `better-sqlite3` used in synchronous mode throughout — are there any async wrappers that could introduce ordering issues?

---

**Operational & Infrastructure (83–92)**

83. Does `GET /api/health` distinguish between "database reachable" and "database writeable" — a read-only DB would pass a simple ping?
84. Are structured logs written to stdout or to a file — and is there log rotation configured?
85. Is there any alerting if the process crashes and restarts — or does a silent crash go unnoticed until the next health check?
86. What is the behaviour when `TRUST_PROXY` is set incorrectly — can IP-based rate limiting be bypassed by spoofing `X-Forwarded-For`?
87. Is `ALLOW_DATA_RESET=true` blocked at the middleware level or only by the environment variable check — could a code bug expose it?
88. What is the memory footprint of `better-sqlite3` under concurrent load — is there a known ceiling before the process OOMs?
89. Is there any protection against the SQLite file being read directly from disk if the server is compromised?
90. Does the CI pipeline run tests against a real SQLite instance or a mock — could schema drift go undetected?
91. Is `npm ci` used in CI (pinned lockfile) or `npm install` (which could pull updated dependencies)?
92. Are any secrets (JWT_SECRET, etc.) ever written to CI logs through environment variable dumps or test output?

---

**Business Logic & Product (93–100)**

93. What is the defined lifecycle of a request — can it move from rejected back to pending, and is that transition blocked?
94. Is there a timeout on unaccepted requests — do they sit as pending forever?
95. If a payment is disputed, what state does the original request return to — pending, or does it remain accepted?
96. Can a user send a payment without a corresponding accepted request — i.e. unsolicited payments?
97. Is there any idempotency key mechanism on `POST /api/payments` to prevent duplicate payments from a retry?
98. What is the canonical "settled" state — is it when a payment is confirmed, and does that automatically close the linked request?
99. Is there a notification mechanism (push, email, in-app badge) when a request or payment arrives — or is it pull-only?
100. What happens to the balance calculation if a request is accepted but the payment is never sent — does the debt persist indefinitely with no nudge mechanism?

---

