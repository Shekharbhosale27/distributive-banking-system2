export function buildOpenApiSpec(serverUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Meridian Trust Bank API',
      version: '1.0.0',
      description:
        'Role-based digital banking API featuring double-entry ledger integrity, idempotent transfers, QR payments, Aadhaar KYC provider integration, SMS notifications, and manager governance.',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        SessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'mtb_session',
        },
        BearerToken: {
          type: 'http',
          scheme: 'bearer',
        },
      },
    },
    security: [{ SessionCookie: [] }, { BearerToken: [] }],
    paths: {
      '/api/health': {
        get: { summary: 'Health & provider mode status', responses: { '200': { description: 'Service healthy' } } },
      },
      '/api/auth/login': {
        post: { summary: 'Authenticate user, employee, or manager', responses: { '200': { description: 'Authenticated session' }, '401': { description: 'Invalid credentials' }, '423': { description: 'Account locked' } } },
      },
      '/api/auth/logout': {
        post: { summary: 'Revoke current session', responses: { '200': { description: 'Logged out' } } },
      },
      '/api/auth/me': {
        get: { summary: 'Get authenticated profile and CSRF token', responses: { '200': { description: 'Current user' } } },
      },
      '/api/auth/change-password': {
        post: { summary: 'Change password (required on first login for seeded manager)', responses: { '200': { description: 'Password updated' } } },
      },
      '/api/auth/recover/request': {
        post: { summary: 'Initiate account recovery token', responses: { '200': { description: 'Generic recovery confirmation' } } },
      },
      '/api/auth/recover/confirm': {
        post: { summary: 'Complete password reset using recovery token', responses: { '200': { description: 'Password reset' } } },
      },
      '/api/auth/accept-invite': {
        post: { summary: 'Employee verifies email/mobile codes and activates account', responses: { '201': { description: 'Employee activated' } } },
      },
      '/api/accounts/me': {
        get: { summary: 'Get customer accounts, limits, and notification preferences (role: user)', responses: { '200': { description: 'Account summary' } } },
      },
      '/api/accounts/me/preferences': {
        patch: { summary: 'Update SMS/email notification consent preferences', responses: { '200': { description: 'Preferences updated' } } },
      },
      '/api/balances/me': {
        get: { summary: 'Get real-time ledger-computed balance for user', responses: { '200': { description: 'Balance in paise and formatted INR' } } },
      },
      '/api/transactions': {
        get: { summary: 'List authorized transaction history', responses: { '200': { description: 'Transaction list' } } },
      },
      '/api/transactions/{id}': {
        get: { summary: 'Get transaction receipt and double-entry ledger lines', responses: { '200': { description: 'Transaction receipt' } } },
      },
      '/api/transfers/internal': {
        post: { summary: 'Transfer funds to another internal account (role: user)', responses: { '201': { description: 'Transfer committed' } } },
      },
      '/api/transfers/resolve-mobile': {
        post: { summary: 'Resolve mobile number via configured payment provider', responses: { '200': { description: 'Resolution result' } } },
      },
      '/api/transfers/upi': {
        post: { summary: 'Execute UPI transfer via payment provider adapter (role: user)', responses: { '201': { description: 'Transfer result' } } },
      },
      '/api/transfers/bank': {
        post: { summary: 'Submit bank-account transfer (NEFT/IMPS/RTGS) via banking provider adapter', responses: { '201': { description: 'Transfer submitted (pending settlement)' } } },
      },
      '/api/qr/generate': {
        post: { summary: 'Generate signed QR payload & PNG data URL to receive payment', responses: { '201': { description: 'QR generated' } } },
      },
      '/api/qr/inspect': {
        post: { summary: 'Validate scanned QR payload without triggering payment', responses: { '200': { description: 'Verified recipient and amount' } } },
      },
      '/api/qr/pay': {
        post: { summary: 'Confirm and execute payment for an inspected QR token', responses: { '201': { description: 'QR payment committed' } } },
      },
      '/api/notifications': {
        get: { summary: 'View SMS and in-app notification delivery log', responses: { '200': { description: 'Notification list' } } },
      },
      '/api/help/tickets': {
        get: { summary: 'List user help tickets', responses: { '200': { description: 'Ticket list' } } },
        post: { summary: 'Submit bank help / dispute ticket', responses: { '201': { description: 'Ticket created' } } },
      },
      '/api/employee/customers': {
        get: { summary: 'Search customers by name, account number, or mobile (role: employee)', responses: { '200': { description: 'Matching customers' } } },
        post: { summary: 'Onboard new customer with Aadhaar KYC provider verification (role: employee)', responses: { '201': { description: 'Customer created' } } },
      },
      '/api/employee/customers/{id}': {
        get: { summary: 'View customer profile, balance, and transactions (role: employee)', responses: { '200': { description: 'Customer detail' } } },
      },
      '/api/employee/adjustments': {
        post: { summary: 'Audited teller credit or debit with reason, limit enforcement, and confirmation (role: employee)', responses: { '201': { description: 'Adjustment posted' } } },
      },
      '/api/employee/help-tickets': {
        get: { summary: 'View customer support queue (role: employee)', responses: { '200': { description: 'Tickets' } } },
      },
      '/api/employee/help-tickets/{id}': {
        patch: { summary: 'Update or resolve help ticket (role: employee)', responses: { '200': { description: 'Updated ticket' } } },
      },
      '/api/manager/overview': {
        get: { summary: 'Bank-wide aggregate balances, activity, and zero-sum ledger invariant check (role: manager)', responses: { '200': { description: 'Bank overview' } } },
      },
      '/api/manager/employees': {
        get: { summary: 'List employee profiles and pending invitations (role: manager)', responses: { '200': { description: 'Employees and invites' } } },
      },
      '/api/manager/employees/invite': {
        post: { summary: 'Invite employee using Gmail address and mobile number (role: manager)', responses: { '201': { description: 'Invitation issued' } } },
      },
      '/api/manager/employees/{id}/status': {
        patch: { summary: 'Activate or deactivate employee access with audit record (role: manager)', responses: { '200': { description: 'Status updated' } } },
      },
      '/api/manager/customers': {
        get: { summary: 'Minimal customer directory for management without secrets or raw KYC (role: manager)', responses: { '200': { description: 'Customer summary list' } } },
      },
      '/api/manager/transactions/{id}/reverse': {
        post: { summary: 'Execute audited double-entry reversal of settled transaction (role: manager)', responses: { '200': { description: 'Reversed' } } },
      },
      '/api/manager/transactions/{id}/reconcile': {
        post: { summary: 'Settle or fail a pending external transaction (role: manager)', responses: { '200': { description: 'Reconciled' } } },
      },
      '/api/manager/audit-logs': {
        get: { summary: 'View immutable security and operational audit trail (role: manager)', responses: { '200': { description: 'Audit logs' } } },
      },
      '/api/manager/credentials': {
        get: { summary: 'List all user & employee usernames and scrypt credential status without exposing hashes (role: manager)', responses: { '200': { description: 'Credential directory' } } },
      },
      '/api/manager/credentials/create': {
        post: { summary: 'Provision new user or employee login with hashed temporary password (role: manager)', responses: { '201': { description: 'Credential created' } } },
      },
      '/api/manager/credentials/{id}/reset-password': {
        post: { summary: 'Issue audited temporary password reset requiring change on next login (role: manager)', responses: { '200': { description: 'Password reset' } } },
      },
      '/api/manager/credentials/{id}/unlock': {
        post: { summary: 'Unlock locked user or employee account (role: manager)', responses: { '200': { description: 'Account unlocked' } } },
      },
      '/api/webhooks/payment-provider': {
        post: { summary: 'HMAC-signed payment provider settlement webhook', responses: { '200': { description: 'Webhook processed' } } },
      },
    },
  };
}

export function renderApiDocsHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Meridian Trust Bank — OpenAPI Reference</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 960px; margin: 40px auto; padding: 0 24px; color: #0f172a; background: #f8fafc; }
    h1 { font-size: 24px; margin-bottom: 6px; }
    p { color: #475569; margin-bottom: 24px; }
    .endpoint { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 18px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
    .method { font-family: monospace; font-weight: 700; font-size: 12px; padding: 3px 8px; border-radius: 4px; background: #ecfdf5; color: #065f46; min-width: 58px; text-align: center; }
    .path { font-family: monospace; font-size: 14px; font-weight: 600; color: #0f172a; }
    .summary { color: #475569; font-size: 13px; text-align: right; }
    a { color: #047857; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Meridian Trust Bank — API Documentation</h1>
  <p>OpenAPI 3.1 JSON specification available at <a href="/api/openapi.json">/api/openapi.json</a></p>
  <div id="list">Loading specification...</div>
  <script>
    fetch('/api/openapi.json').then(r => r.json()).then(spec => {
      const el = document.getElementById('list');
      const items = [];
      for (const [path, methods] of Object.entries(spec.paths)) {
        for (const [method, info] of Object.entries(methods)) {
          items.push('<div class="endpoint"><div style="display:flex;align-items:center;gap:12px;"><span class="method">' + method.toUpperCase() + '</span><span class="path">' + path + '</span></div><span class="summary">' + (info.summary || '') + '</span></div>');
        }
      }
      el.innerHTML = items.join('');
    });
  </script>
</body>
</html>`;
}
