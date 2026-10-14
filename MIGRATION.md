# Backend Audit and Migration Notes

## Current Backend

The service is a single CommonJS Express 5 entry point using the MongoDB native driver, Firebase Admin for identity-token verification, Stripe Checkout, `cors`, and `dotenv`. It is deployed through the Vercel Node builder. The configured MongoDB connection is constructed, but the explicit `client.connect()` call is commented out. Firebase service-account JSON is decoded from `FB_SERVICE_KEY` at module load. The credential JSON file in the workspace is ignored and is not tracked by Git.

The existing untracked `encode.js` helper reads the service-account JSON file and prints its base64 contents to stdout; avoid running it where command output is captured or shared.

The separate Next.js frontend is not present in this workspace. Its exact request payloads, Auth.js version, and reliance on currently unauthenticated routes cannot be confirmed here. The route list below is inferred from the server implementation; collection document schemas are implicit rather than formally validated.

## Existing HTTP Contract

| Method and path | Current behavior | Current access control |
| --- | --- | --- |
| `GET /health` | Liveness response (`{ status: "ok" }`) | Public |
| `GET /` | Basic service response | Public |
| `GET /users?searchText=` | Search users, returns at most two | Firebase token; self only unless admin |
| `GET /users/:email/role` | Return a user's role, defaulting to `user` | Firebase token; self or admin |
| `POST /users` | Insert user with forced `user` role | Firebase token; email comes from verified token |
| `PATCH /users/:id` | Change role | Firebase token and database `admin` role |
| `GET /parcels?email=&delivery_status=` | List matching parcels | Firebase token; sender only unless admin |
| `GET /parcels/rider?riderEmail=&delivery_status=` | List rider parcels | Firebase token; rider role and own email |
| `GET /parcels/:id` | Fetch one parcel | Firebase token; sender, assigned rider, or admin |
| `GET /parcels/delivery-status/stats` | Aggregate counts by delivery status | Firebase token and admin role |
| `POST /parcels` | Insert parcel and create tracking event | Firebase token; sender email comes from verified token |
| `PATCH /parcels/:id` | Assign rider and mark rider busy | Firebase token and admin role |
| `PATCH /parcels/:id/status` | Change assigned parcel status and release rider on delivery | Firebase token and rider role; assigned parcel only |
| `DELETE /parcels/:id` | Delete parcel | Firebase token and admin role |
| `POST /create-checkout-session` | Create Stripe Checkout session | Firebase token; sender must own parcel; price and metadata read from stored parcel |
| `PATCH /payment-success?session_id=` | Retrieve Stripe session and mark parcel paid | Public; payment status checked with Stripe |
| `GET /payments?email=` | List payment records | Firebase token; self only unless admin |
| `GET /riders?...` | List riders | Firebase token and admin role |
| `POST /riders` | Insert rider application | Firebase token; email comes from verified token |
| `PATCH /riders/:id` | Change rider approval and possibly user role | Firebase token and database `admin` role |
| `DELETE /riders/:id` | Delete rider | Firebase token and admin role |
| `GET /tracking/:trackingId/logs` | Return projected tracking event fields | Public; identifier validation and rate-limited |

There is no `/api/v1` prefix, OpenAPI document, request validation layer, or API integration test suite. This pass adds a liveness endpoint, request IDs, JSON 404 handling, centralized safe error responses with structured server-error logs, Helmet, a 100 KB JSON body limit, CORS allow-listing via `CORS_ORIGINS` (falling back to `SITE_DOMAIN`), a global rate limit, a stricter tracking rate limit, and focused Node unit tests for request-security helpers. Configure `CORS_ORIGINS` as a comma-separated list of exact frontend origins in deployment. The built-in rate-limit store is process-local and is not a sufficient distributed abuse-control strategy for serverless or multi-instance deployment; use a shared store before relying on it operationally. No Cloudinary or Firebase Storage upload flow is present in this server. Payment status and delivery status share parcel records but are not modeled with explicit schemas.

## Findings and Immediate Changes


- Checkout now reads cost from the stored parcel, but parcel booking still accepts a caller-supplied cost; calculate it from an approved server-side tariff before production use.
- `PATCH /payment-success` remains a public browser-return flow. Replace it with a signed, idempotent Stripe webhook before treating it as a reliable payment ledger.
- Existing roles are only lowercase `admin`, `rider`, and default `user`; the requested merchant, branch, support, and customer permissions are not modeled.
- Requests still lack Zod validation and Mongoose schemas; parcel writes and tracking events are separate operations and are not transactionally consistent.
- The new tests cover request-security helpers only; route authorization, persistence, payments, and frontend compatibility lack integration tests.
- Several existing endpoints now require Firebase Bearer tokens where they did not before; coordinate those header changes with the frontend before deployment.

1. Capture real frontend calls and representative MongoDB documents; preserve the current paths as compatibility aliases until the Next.js client is migrated.
2. Add startup environment validation, explicit database connection lifecycle, request IDs, structured error responses/logging, security headers, configured CORS, and rate limits for public endpoints.
3. Introduce TypeScript and a testable `app`/`server` split without changing existing route behavior; add Supertest coverage for current contracts.
4. Add validated Mongoose schemas/indexes against existing collection names and migrate route-by-route, preserving existing document fields and tracking identifiers.
5. Confirm the frontend's Auth.js version and session/token strategy. Continue verifying Firebase ID tokens only if Firebase remains the identity provider; otherwise integrate a cryptographically verified shared token or session strategy. Expand current role and ownership checks to branch/rider scope and account suspension.
6. Move parcel transitions, rider assignments, and tracking writes into services with atomic updates and tests. Introduce `/api/v1` while keeping legacy routes during client migration.
7. Calculate parcel prices from an approved server tariff, add idempotent signed Stripe webhook processing, and separate payment from delivery state.
8. Add Cloudinary only after confirming upload requirements and any existing Firebase Storage assets. Keep existing asset references until migration is verified and rollback is documented.
9. Add OpenAPI, isolated database tests, CI checks, deployment health checks, and remove compatibility paths only after frontend adoption is verified.

## Compatibility and Limitations

No legacy path was removed or renamed in this first pass, but several existing endpoints now require Firebase Bearer tokens and customer/rider ownership filters. The frontend must send those headers before deployment. The frontend source, database contents, deployment environment, and usable test credentials are unavailable in this workspace, so frontend compatibility, live database behavior, Stripe flows, and production secret validity remain unverified. Never commit `.env` or service-account credentials; rotate any key that has been exposed outside the ignored local workspace.