# NearFix

NearFix is a Node.js service marketplace with a browser-based customer, technician and admin interface. Authentication is provided by Supabase Auth. The backend verifies Supabase access tokens and reads account roles from the protected `profiles` table; signup metadata cannot create administrators.

## Supabase setup

1. Create a Supabase project and open **SQL Editor**.
2. Run [`docs/sql-persistence.sql`](docs/sql-persistence.sql) once. It creates the profiles, technician, request, assignment and service-history tables, signup trigger, indexes and RLS policies.
3. In **Authentication → URL Configuration**, set the local Site URL to `http://localhost:5050`. Add your Vercel URL to the allowed redirect URLs. Enable email confirmation if you want new accounts to verify their email.
4. Copy `.env.example` to `.env`, then set `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` from the Supabase project settings. The service-role secret is for the Node backend only. Never put it in frontend code or share it in a public repository.
5. For real arrival OTP delivery, configure the Twilio variables. Arrival check-in fails safely when SMS is not configured; the code is not shown in the app or API.

### Administrator provisioning

Create the first account through the regular signup flow and verify its email. Then, in the Supabase SQL Editor as the project owner, promote that exact account:

```sql
update public.profiles
set role = 'admin', area = 'All Areas'
where email = lower('verified-admin@example.com');
```

Replace the example email with the verified administrator's address. Do not run this from the browser or grant clients permission to update `role`.

## Run locally

```powershell
npm install
Copy-Item .env.example .env
# Edit .env with your Supabase project values
npm start
```

Open the local URL printed by the server (normally `http://localhost:5050`). Syntax checks are available with `npm run check`.

## GitHub and Vercel

Push the project to a private GitHub repository if it contains any user-provided assets. Connect the repository to Vercel with the project root as the root directory and `npm install` / `npm start` as install and start commands where supported. For a serverless deployment, configure the same environment variables in **Vercel → Project → Settings → Environment Variables**, then redeploy. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` for each environment. Keep `.env` out of Git; `.gitignore` already excludes it.

## Data and migration status

The app's existing REST/business layer persists its application state to a private PostgreSQL `nearfix_state` JSONB row through the backend service role. RLS is enabled on that private compatibility table and browser roles have no access. The migration also creates normalized, RLS-protected profile and service tables for the target data model, but the existing booking, payment, messaging and admin handlers have not yet been migrated from the compatibility JSON state to those normalized tables. Do not treat the normalized tables as the active source for those workflows yet.

The local JSON state is an offline development fallback; it is not durable on Vercel. Configure Supabase before accepting real accounts or bookings. The repository's seeded demo accounts, technicians, booking, catalog records and demo seeding scripts have been removed. Existing Supabase state is retained except for records carrying explicit demo markers or reserved demo email domains, which the backend strips during load. Legacy password hashes are removed because Supabase Auth now owns credentials.

## Current limits

- The full booking/service/payment API has not been migrated to normalized Postgres rows. This is a remaining production task.
- The supplied local data contained seeded demo accounts only. If an existing Supabase `nearfix_state` row contains real users or bookings, migrate their user IDs to Supabase Auth and update dependent references before deploying; that live-data migration was not possible without the project credentials. Users will need Supabase Auth accounts and password resets.
- RLS policy SQL was reviewed but could not be exercised against a live Supabase project from this workspace.
- Password reset email delivery and email verification behavior depend on the Supabase project's Auth provider and URL settings.
- Arrival OTP delivery requires configured Twilio credentials.
- Razorpay requires valid server-side test/live credentials. No payment is marked successful by the removed demo endpoint.
