# NearFix demo accounts

The project includes 12 fictional technician profiles for hackathon demonstrations. Their cards are marked **Demo profile** and their identity and skill checks are intentionally left unverified.

## One-click demo sign-in

The login page offers one-click access for Customer, Technician, and Admin. It signs in through the app backend and opens the selected role's dashboard.

- Customer: `demo.customer@nearfix.test`
- Technician: `demo.tech01@nearfix.test` (12 sample technician accounts are available)
- Admin: `demo.admin@nearfix.test`
- Shared demo password: `NearFixDemo26!`

To restore all demo accounts and technician profiles after resetting the local database, run `node scripts/seed-demo-technicians.js` from the project folder.

## Technician accounts

- Email addresses: `demo.tech01@nearfix.test` through `demo.tech12@nearfix.test`
- Shared demo password: `NearFixDemo26!`

These are sample accounts only. Replace them with real technicians and complete verification before using the marketplace with customers.
