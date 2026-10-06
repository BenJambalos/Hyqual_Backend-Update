# HyQual Backend

A real REST API for the HyQual app: Node.js + Express + MySQL, JWT auth,
bcrypt password hashing, and SQL-driven reports (real AVG/MIN/MAX
aggregation over `water_quality_readings`, not fake numbers).

Tested end-to-end against a live MySQL instance before delivery — every
endpoint below was hit with real HTTP requests and verified to return
correct data (see the "What was actually tested" section).

## 1. Set up the database

You need MySQL or MariaDB running. Then:

```bash
mysql -u root -p -e "CREATE DATABASE hyquai_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p hyquai_db < database/schema.sql
mysql -u root -p hyquai_db < database/seed_data.sql
```

`database/schema.sql` is **your** ERD schema (from `ERD2.mwb`) with 6
corrections — each one is marked with a `-- CORRECTION:` comment in the
file explaining exactly what changed and why (short version: forecasts
and notifications needed a `pond_id` since your farms have multiple
ponds; notifications needed `is_read` separate from `is_resolved`;
devices needed a `device_key` for IoT auth; added a `password_resets`
table for the Forgot Password flow). Everything else is untouched.

`database/seed_data.sql` populates it with the same demo data the app
already shows: farm owner Juan Dela Cruz, 4 ponds (Normal/Warning/
Critical/Offline), 5 devices, ~7 days of realistic readings, and 5
notifications. Login with `farmer@hyquai.demo` / `HyQuai123!`.

Then create a database user for the app (or reuse root for local dev):

```sql
CREATE USER 'hyquai_app'@'localhost' IDENTIFIED BY 'choose_a_real_password';
GRANT ALL PRIVILEGES ON hyquai_db.* TO 'hyquai_app'@'localhost';
FLUSH PRIVILEGES;
```

## 2. Configure and run the server

```bash
cp .env.example .env
# edit .env: set DB_USER/DB_PASSWORD to what you created above,
# and set JWT_SECRET to a real random string:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

npm install
node server.js
```

You should see `HyQual API listening on port 4000`. Check it's alive:

```bash
curl http://localhost:4000/api/health
```

## 3. Point the Flutter app at it

Open `lib/data/api_client.dart` in the Flutter project and set `baseUrl`
to wherever this server is reachable from your phone/emulator — see the
comment block right above it for the Android-emulator-vs-physical-phone
gotchas (this is the #1 thing that trips people up: `localhost` from a
phone means the phone itself, not your computer).

## Regenerating demo data

`seed_generator.js` (in this folder) is the script that built
`seed_data.sql` — it writes realistic random-walk readings directly into
a running MySQL instance, then you'd `mysqldump` the result. Useful if
you want a fresh batch with today's timestamps:

```bash
node seed_generator.js
```

## API overview

- `POST /api/auth/login`, `/signup`, `/forgot-password`, `/reset-password`
  - `signup` now creates the account as **PENDING** and returns no token.
  - `login` answers 403 (`code: ACCOUNT_PENDING` / `ACCOUNT_REJECTED`) until a Super Admin approves; on success it also returns `role`, `accountStatus` and `setup` (`hasFarm`, `pondCount`, `deviceCount`).
- `GET /api/auth/me` — same account/setup state, for resuming setup
- `PUT /api/auth/change-password` (requires current password)
- `GET/PUT /api/profile`, `GET/PUT /api/farm`, `POST /api/farm` (create the farm during setup, once approved)
- **Super Admin only** — `GET /api/admin/accounts/pending`, `PUT /api/admin/accounts/:accountId/approve`, `PUT /api/admin/accounts/:accountId/reject`
- `GET/POST /api/ponds`, `PUT/DELETE /api/ponds/:id`, `GET /api/ponds/:id` (detail), `GET /api/ponds/:id/forecast`
- `GET/POST /api/devices`, `PUT/DELETE /api/devices/:id`, `GET /api/devices/:id`, `POST /api/devices/:id/assign`
- `PUT /api/devices/:id/pond` `{ "pond_id": 2 }` — remote reassignment from the app (pond must belong to the caller's farm)
- `GET /api/devices/:deviceId/config` — polled by the ESP32; authenticates with header `x-device-key` (not a user JWT) and returns `{ device_id, farm_id, pond_id, pond_name }`
- `POST /api/ingest/readings`, `POST /api/ingest/status` — called by the physical device (authenticated via `device_key`, not a user JWT). Posting a reading automatically creates or resolves alerts by comparing against `parameter_thresholds` — see `routes/ingest.js`.
- `GET /api/notifications` (+ `PUT .../read`, `PUT .../mark-all-read`)
- `GET /api/reports/trend`, `/reading-logs`, `/alert-logs`, `/summary`, `/list` — the real SQL aggregation endpoints

Every mutating/list endpoint except `/auth/*`, `/ingest/*` and
`GET /devices/:deviceId/config` requires `Authorization: Bearer <token>`
from login. Farm-scoped endpoints (ponds, devices, notifications, reports)
answer `409 { code: "FARM_REQUIRED" }` until the account has created its farm.

## Account approval (Super Admin)

New registrations are `accounts.status = 'pending'`. A Super Admin
(`accounts.role = 'super_admin'`, `status = 'active'`) approves or rejects
them. Mapping used by the API: `pending` = PENDING, `active` = APPROVED
(the status that already existed), `rejected` = REJECTED.

**Existing database (local or Railway):** run
`database/migrations/001_account_approval.sql` once. It only ALTERs two
columns on `accounts`; existing accounts stay `active`. Check your live
column values first (the file explains how). Fresh installs get the same
change from `database/schema.sql`.

**Create the Super Admin yourself** (SQL example at the bottom of the
migration file). It needs a bcrypt hash:
`node -e "console.log(require('bcryptjs').hashSync('YourPassword',10))"`.

## Deploying on Railway

1. Railway project with a **MySQL** service and a service from this repo
   (set the service's *Root Directory* to `hyquai_backend`; start command
   is `npm start`).
2. On the Node service add variables: `JWT_SECRET` (long random string),
   `NODE_ENV=production`, and reference the MySQL service's `MYSQLHOST`,
   `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD`, `MYSQLDATABASE`
   (`${{MySQL.MYSQLHOST}}` etc. — use your MySQL service's actual name).
   `db.js` reads these automatically; `DB_*` is only for local `.env`.
3. Settings > Networking > **Generate Domain** on the Node service. That
   HTTPS URL is what the Flutter app and the ESP32 use (never localhost).
4. Run the migration against Railway's MySQL (public connection string
   from the MySQL service's `MYSQL_PUBLIC_URL`):
   `mysql -h <host> -P <port> -u root -p railway < database/migrations/001_account_approval.sql`
5. Flutter: `flutter run --dart-define=API_BASE_URL=https://<domain>/api`
   (or `flutter build apk --dart-define=API_BASE_URL=...`).

## Tests

`node tests/approval_flow.js` runs the whole flow (register, pending,
reject, approve, farm/pond/device setup, remote pond change, device config,
cross-farm protections) against a LOCAL server. See the header of that
file for the Super Admin credentials it expects.

## What was actually tested

Every endpoint above was exercised with real HTTP requests against a
live MySQL database during development, including: signup, duplicate-
signup rejection, login, change password + re-login, forgot password,
full pond/device CRUD, device assignment, a simulated device posting a
threshold-breaching reading (confirmed it auto-created a CRITICAL
notification with the right message) followed by a normal reading
(confirmed the notification auto-resolved), and the reports summary
endpoint's AVG/MIN/MAX numbers were spot-checked against a manual SQL
query. A fresh database loaded from *only* `schema.sql` + `seed_data.sql`
was used for the final pass, so what you're getting is exactly what was
tested.

**Not tested:** the Flutter side calling this API. There's no Flutter
SDK in the environment this was built in, so the Dart code was written
carefully and cross-checked field-by-field against these exact API
response shapes, but not run. If something doesn't line up, it's most
likely a small field-name mismatch — paste the error back and it's a
quick fix.

## Known gaps (clearly marked with `TODO(db)` / `TODO(email)` in the code)

- CSV/XLSX report export and real PDF generation are stubbed (show a
  confirmation message but don't produce a real file yet)
- Forgot-password generates a real token but doesn't email it (needs a
  mail provider — logs the token to the server console for now)
- Forecast values are a simple heuristic based on the current reading,
  not a real prediction model
