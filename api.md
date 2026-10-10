# NearFix API

All authenticated requests use `Authorization: Bearer <Supabase access token>`. The backend validates the token with Supabase Auth and resolves the user's role from `public.profiles`; client metadata is not used for authorization.

## Authentication

- `POST /api/auth/register` — customer or technician signup; administrator role is rejected.
- `POST /api/auth/login` — email and password sign-in through Supabase Auth.
- `POST /api/auth/refresh` — rotate an expired access token using the Supabase refresh token.
- `POST /api/auth/logout` — invalidate the Supabase session.
- `POST /api/auth/password-reset` — send the Supabase recovery email.
- `POST /api/auth/password-update` — update a password using the recovery access token.

## Service API

- `GET /api/public`, `GET /api/technicians`, `GET /api/parts`
- `GET /api/bootstrap`, `GET /api/bookings`, `POST /api/bookings`, `PATCH /api/bookings/:id`
- `POST /api/quotes`, `POST /api/quotes/:id/approve`, `POST /api/quotes/:id/reject`
- `POST /api/payments/manual`, `POST /api/payments/order`, `POST /api/payments/verify`
- `POST /api/invoices`, `GET /api/invoices`, `POST /api/reviews`
- `GET /api/messages`, `POST /api/messages`, `GET /api/notifications`, `PATCH /api/notifications/read`
- `POST /api/disputes`, `GET /api/admin/analytics`, `PATCH /api/admin/technicians/:id`

`POST /api/payments` is disabled (410); it was the fake payment path. Cash and UPI submissions remain pending until a technician or administrator confirms receipt. Razorpay marks a payment paid only after its signature is verified.

## Arrival verification

- `GET /api/bookings/:id/arrival-verification` returns the authorized booking's verification status, never the code.
- `POST /api/bookings/:id/arrival-otp/verify` is restricted to the assigned technician.
- A technician cannot move an `ARRIVED` booking to `INSPECTION` without a valid code.
- Codes expire after five minutes, allow five attempts and are delivered by Twilio. If Twilio or a customer phone number is missing, the job remains unadvanced.

Business endpoints are currently served through the private `nearfix_state` compatibility record. The normalized tables in `docs/sql-persistence.sql` are not yet the source used by those handlers.
