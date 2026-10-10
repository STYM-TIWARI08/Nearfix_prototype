# NearFix architecture

## Runtime

- Node.js serves the static SPA and REST API.
- Supabase Auth manages credentials and sessions. The backend verifies access tokens with Supabase and resolves roles from `public.profiles`.
- The backend stores business state in a private Supabase PostgreSQL `nearfix_state` JSONB row. It uses the service-role key server-side; browser clients have no table access.

## Authorization

- Public signup can create customer or technician profiles only.
- A database trigger creates profiles on Auth signup. Administrator promotion is an owner-only SQL operation.
- The SQL migration enables RLS on the profile and service tables and denies browser access to the compatibility state row.
- API handlers additionally check the authenticated role and ownership/assignment before returning or changing private data.

## Database migration status

`docs/sql-persistence.sql` defines normalized profiles, technician skills/areas/availability, service requests, assignments, and service history with constraints, indexes and RLS. The existing service handlers still use the JSONB compatibility record; moving those workflows to the normalized tables remains unfinished.

## External services

- Arrival OTP delivery requires Twilio; the OTP is not returned from the API.
- Online payment requires Razorpay credentials and a valid verified signature. Manual Cash/UPI submissions stay pending until confirmed.
- The existing rules-based diagnosis and price estimate are preliminary guidance, not a verified service result.
