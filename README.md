# Meridian Trust Bank

Full-stack, role-based digital banking application with an auditable double-entry ledger, QR payment generation & camera scanning, Aadhaar KYC onboarding adapter, SMS notification adapter, OpenAPI 3.1 documentation, and automated security/ledger tests.

## Stack

- **Backend**: Node.js, Express, TypeScript (`tsx`), SQLite (`better-sqlite3` with WAL mode and `BEGIN IMMEDIATE` serializable ledger commits)
- **Frontend**: React 19, Vite, Tailwind CSS v4, Lucide icons, `qrcode`, `jsqr`
- **Testing**: Vitest + Supertest

## Local Development Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure environment (copy `.env.example` to `.env` if customizing):
   ```bash
   cp .env.example .env
   ```
3. Run database migrations & seed development data:
   ```bash
   npm run migrate
   ```
4. Start the full-stack server on port 3000:
   ```bash
   npm run dev
   ```
5. Run automated tests:
   ```bash
   npm test
   ```

## Local Development Sample Credentials

> **Security Note**: Development seeding runs **only** when `NODE_ENV !== "production"` and `ALLOW_DEV_SEED !== "false"`. Never enable dev seeding in production.

- **Manager**: `manager` / `1234` *(Mandatory password change enforced on first login)*
- **Employee (Retail Ops)**: `teller.priya` / `BankStaff#2026`
- **Employee (KYC & Onboarding)**: `teller.rohan` / `BankStaff#2026`
- **Customers**: `aarav.sharma`, `meera.iyer`, `kabir.verma` / `Customer#2026`

## Production Deployment

1. Set `NODE_ENV=production` and `ALLOW_DEV_SEED=false`.
2. Generate strong random secrets for `SESSION_SECRET`, `QR_SIGNING_SECRET`, and `PAYMENT_WEBHOOK_SECRET`.
3. Provide `BOOTSTRAP_MANAGER_USERNAME` and `BOOTSTRAP_MANAGER_PASSWORD` (minimum 12 characters) for initial production manager provisioning.
4. Build and run:
   ```bash
   npm run build
   npm run migrate
   npm start
   ```

## API Documentation (OpenAPI 3.1)

- JSON specification: `GET /api/openapi.json`
- Interactive endpoint directory: `GET /api/docs`

## Integrations Requiring Production Credentials & Regulatory Approval

The application uses explicit adapter boundaries (`server/providers/`) operating in **sandbox mode** by default. Live operation requires:

1. **UPI & Mobile-Number Resolution (`PAYMENT_PROVIDER_MODE=live`)**: Requires NPCI/PSP partner onboarding, API keys (`PAYMENT_PROVIDER_BASE_URL`, `PAYMENT_PROVIDER_API_KEY`), and signed webhook verification (`PAYMENT_WEBHOOK_SECRET`). Mobile numbers are resolved strictly through the provider directory and never assumed to be UPI IDs.
2. **Bank-Account Transfers — NEFT / IMPS / RTGS (`PAYMENT_PROVIDER_MODE=live`)**: Requires sponsor-bank corporate API approval, clearing house registration, and webhook/reconciliation settlement. Online banking passwords, PINs, and OTPs are never collected by this application.
3. **Aadhaar e-KYC Verification (`KYC_PROVIDER_MODE=live`)**: Requires licensed UIDAI KUA/ASA or DigiLocker partner credentials (`KYC_PROVIDER_BASE_URL`, `KYC_PROVIDER_API_KEY`). Raw Aadhaar numbers are never persisted or logged; only the provider reference and masked last-4 digits are stored.
4. **Transaction SMS Notifications (`SMS_PROVIDER_MODE=live`)**: Requires DLT template registration and SMS provider credentials (`SMS_PROVIDER_ACCOUNT_SID`, `SMS_PROVIDER_AUTH_TOKEN`, `SMS_PROVIDER_FROM_NUMBER`). Delivery failures are recorded without altering ledger status.
