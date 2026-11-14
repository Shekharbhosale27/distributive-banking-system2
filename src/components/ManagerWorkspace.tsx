import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  BookOpen,
  Building2,
  CheckCircle2,
  FileCheck2,
  KeyRound,
  LogOut,
  RotateCcw,
  Shield,
  Users,
} from 'lucide-react';
import { ApiError, apiFetch, formatDateTime, formatInr, type AuthUser } from '../lib/api';
import { EmptyState, TableSkeleton, TxStatusText } from './StatusIndicator';

type ManagerTab = 'overview' | 'credentials' | 'employees' | 'ledger' | 'customers' | 'audit' | 'integrations';

interface OverviewData {
  aggregates: {
    customerBalancesPaise: number;
    systemVaultBalancePaise: number;
    systemClearingBalancePaise: number;
    ledgerBalanced: boolean;
    totalDebitsPaise: number;
    totalCreditsPaise: number;
    customerCount: number;
    activeEmployees: number;
    pendingInvites: number;
    customerAccounts: number;
    txCounts: {
      success: number;
      pending: number;
      failed: number;
      reversed: number;
    };
  };
  recentActivity: Array<{
    id: string;
    reference_code: string;
    tx_type: string;
    status: string;
    amount_paise: number;
    provider_name: string;
    description: string;
    created_at: string;
  }>;
  integrations: Array<{
    name: string;
    mode: string;
    configured: boolean;
    requirements: string;
  }>;
}

interface EmployeeRecord {
  id: string;
  username: string;
  fullName: string;
  email: string;
  mobile: string;
  status: string;
  department: string | null;
  createdAt: string;
}

interface InviteRecord {
  id: string;
  email: string;
  mobile: string;
  full_name: string;
  department: string;
  email_verified: number;
  mobile_verified: number;
  status: string;
  expires_at: string;
}

interface ManagerTxRow {
  id: string;
  reference_code: string;
  tx_type: string;
  status: string;
  amount_paise: number;
  provider_name: string;
  description: string;
  initiated_by_name: string | null;
  created_at: string;
}

interface CustomerSummary {
  userId: string;
  fullName: string;
  mobileMasked: string;
  accountNumberMasked: string;
  accountType: string;
  accountStatus: string;
  kycStatus: string;
  balancePaise: number;
  createdAt: string;
}

interface AuditLogRow {
  id: string;
  actor_username: string | null;
  actor_role: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  details_json: string | null;
  created_at: string;
}

interface CredentialRecord {
  id: string;
  username: string;
  fullName: string;
  role: 'user' | 'employee';
  email: string | null;
  mobileMasked: string;
  accountMasked: string | null;
  department: string | null;
  status: string;
  mustChangePassword: boolean;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  passwordProtection: string;
  updatedAt: string;
}

export function ManagerWorkspace({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }) {
  const [tab, setTab] = useState<ManagerTab>('overview');
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [employees, setEmployees] = useState<EmployeeRecord[]>([]);
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [transactions, setTransactions] = useState<ManagerTxRow[]>([]);
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]);
  const [credentials, setCredentials] = useState<CredentialRecord[]>([]);

  // Credential provisioning & reset form state
  const [credRole, setCredRole] = useState<'user' | 'employee'>('user');
  const [credUsername, setCredUsername] = useState('');
  const [credName, setCredName] = useState('');
  const [credEmail, setCredEmail] = useState('');
  const [credMobile, setCredMobile] = useState('');
  const [credTempPass, setCredTempPass] = useState('');
  const [credDept, setCredDept] = useState('Retail Operations');
  const [credError, setCredError] = useState<string | null>(null);
  const [resetPasswords, setResetPasswords] = useState<Record<string, string>>({});
  const [credFilter, setCredFilter] = useState<'all' | 'user' | 'employee'>('all');

  // Employee Invite Form
  const [invName, setInvName] = useState('');
  const [invEmail, setInvEmail] = useState('');
  const [invMobile, setInvMobile] = useState('');
  const [invDept, setInvDept] = useState('Retail Operations');
  const [invError, setInvError] = useState<string | null>(null);
  const [invSandboxOutput, setInvSandboxOutput] = useState<{
    inviteToken: string;
    emailCode: string;
    mobileCode: string;
  } | null>(null);

  // Access / Reversal action state
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [reasonInputs, setReasonInputs] = useState<Record<string, string>>({});

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, emp, tx, cust, aud, cred] = await Promise.all([
        apiFetch<OverviewData>('/api/manager/overview'),
        apiFetch<{ employees: EmployeeRecord[]; invites: InviteRecord[] }>('/api/manager/employees'),
        apiFetch<{ transactions: ManagerTxRow[] }>('/api/manager/transactions'),
        apiFetch<{ customers: CustomerSummary[] }>('/api/manager/customers'),
        apiFetch<{ logs: AuditLogRow[] }>('/api/manager/audit-logs'),
        apiFetch<{ credentials: CredentialRecord[] }>('/api/manager/credentials'),
      ]);
      setOverview(ov);
      setEmployees(emp.employees);
      setInvites(emp.invites);
      setTransactions(tx.transactions);
      setCustomers(cust.customers);
      setAuditLogs(aud.logs);
      setCredentials(cred.credentials);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await onLogout();
      } else {
        setActionError(err instanceof ApiError ? err.message : 'Unable to load governance overview.');
      }
    } finally {
      setLoading(false);
    }
  }, [onLogout]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function handleInviteEmployee(e: FormEvent) {
    e.preventDefault();
    setInvError(null);
    setInvSandboxOutput(null);
    try {
      const res = await apiFetch<{
        invite: { email: string };
        sandboxVerification?: { inviteToken: string; emailCode: string; mobileCode: string };
      }>('/api/manager/employees/invite', {
        method: 'POST',
        body: JSON.stringify({
          fullName: invName,
          email: invEmail,
          mobile: invMobile,
          department: invDept,
        }),
      });
      setInvName('');
      setInvEmail('');
      setInvMobile('');
      if (res.sandboxVerification) {
        setInvSandboxOutput(res.sandboxVerification);
      }
      await loadAll();
    } catch (err) {
      setInvError(err instanceof ApiError ? err.message : 'Unable to send employee invitation.');
    }
  }

  async function handleToggleEmployeeStatus(emp: EmployeeRecord) {
    setActionError(null);
    setActionSuccess(null);
    const nextStatus = emp.status === 'active' ? 'deactivated' : 'active';
    const reason = reasonInputs[emp.id] || `Manager ${nextStatus === 'deactivated' ? 'deactivation' : 'reactivation'} review`;
    try {
      await apiFetch(`/api/manager/employees/${emp.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus, reason }),
      });
      setActionSuccess(`Employee ${emp.username} updated to ${nextStatus}.`);
      await loadAll();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Status update failed.');
    }
  }

  async function handleReconcile(txId: string, outcome: 'success' | 'failed') {
    setActionError(null);
    setActionSuccess(null);
    try {
      await apiFetch(`/api/manager/transactions/${txId}/reconcile`, {
        method: 'POST',
        body: JSON.stringify({ outcome, reason: `Manager reconciliation: ${outcome}` }),
      });
      setActionSuccess(`Pending transaction reconciled as ${outcome}.`);
      await loadAll();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Reconciliation failed.');
    }
  }

  async function handleReverse(txId: string) {
    setActionError(null);
    setActionSuccess(null);
    const reason = reasonInputs[txId] || 'Manager authorized transaction reversal';
    try {
      await apiFetch(`/api/manager/transactions/${txId}/reverse`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      setActionSuccess('Transaction reversed via balanced compensating ledger entry.');
      await loadAll();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Reversal failed.');
    }
  }

  async function handleCreateCredential(e: FormEvent) {
    e.preventDefault();
    setCredError(null);
    setActionSuccess(null);
    try {
      const res = await apiFetch<{ credential: { username: string; role: string } }>('/api/manager/credentials/create', {
        method: 'POST',
        body: JSON.stringify({
          role: credRole,
          username: credUsername,
          fullName: credName,
          email: credEmail,
          mobile: credMobile,
          temporaryPassword: credTempPass,
          department: credRole === 'employee' ? credDept : undefined,
        }),
      });
      setActionSuccess(
        `Saved ${res.credential.role} login '${res.credential.username}' with scrypt-hashed temporary password.`,
      );
      setCredUsername('');
      setCredName('');
      setCredEmail('');
      setCredMobile('');
      setCredTempPass('');
      await loadAll();
    } catch (err) {
      setCredError(err instanceof ApiError ? err.message : 'Unable to create login.');
    }
  }

  async function handleResetCredentialPassword(cred: CredentialRecord) {
    setActionError(null);
    setActionSuccess(null);
    const temporaryPassword = resetPasswords[cred.id] || '';
    const reason = reasonInputs[cred.id] || 'Manager issued temporary password reset';
    try {
      const res = await apiFetch<{ message: string }>(`/api/manager/credentials/${cred.id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ temporaryPassword, reason }),
      });
      setActionSuccess(res.message);
      setResetPasswords((prev) => ({ ...prev, [cred.id]: '' }));
      await loadAll();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Password reset failed.');
    }
  }

  async function handleUnlockCredential(cred: CredentialRecord) {
    setActionError(null);
    setActionSuccess(null);
    try {
      const res = await apiFetch<{ message: string }>(`/api/manager/credentials/${cred.id}/unlock`, {
        method: 'POST',
      });
      setActionSuccess(res.message);
      await loadAll();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Unlock failed.');
    }
  }

  const navItems: Array<{ id: ManagerTab; label: string; icon: typeof Building2 }> = [
    { id: 'overview', label: 'Bank Overview', icon: Building2 },
    { id: 'credentials', label: 'User & Employee Logins', icon: KeyRound },
    { id: 'employees', label: 'Employees & Invites', icon: Users },
    { id: 'ledger', label: 'Ledger & Reversals', icon: RotateCcw },
    { id: 'customers', label: 'Customer Summary', icon: FileCheck2 },
    { id: 'audit', label: 'Audit Trail', icon: Shield },
    { id: 'integrations', label: 'Integrations & API', icon: BookOpen },
  ];

  return (
    <div className="min-h-screen bg-[#F5F6F8] flex flex-col lg:flex-row">
      <aside className="w-full lg:w-64 bg-[#111827] text-slate-200 flex flex-col shrink-0">
        <div className="px-6 py-5 border-b border-slate-800">
          <p className="text-base font-bold text-white font-display whitespace-nowrap">Meridian Trust Bank</p>
          <p className="text-xs text-amber-400 font-medium mt-0.5">Executive Governance</p>
        </div>

        <nav className="flex lg:flex-col overflow-x-auto lg:overflow-visible p-3 gap-1 flex-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                  active ? 'bg-amber-500/15 text-amber-300' : 'text-slate-400 hover:bg-slate-800/70 hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800 hidden lg:block">
          <p className="text-xs font-semibold text-white truncate">{user.fullName}</p>
          <p className="text-xs text-slate-400 truncate">Branch Manager</p>
          <button
            type="button"
            onClick={() => void onLogout()}
            className="mt-3 w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-200 border border-slate-700 rounded-lg hover:bg-slate-800 whitespace-nowrap"
          >
            <LogOut className="w-3.5 h-3.5" />
            Log Out
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white border-b border-slate-200 px-6 lg:px-8 py-4 flex items-center justify-between gap-8">
          <div className="text-sm text-slate-500 truncate">
            <span>Governance</span>
            <span className="mx-2">/</span>
            <span className="font-semibold text-slate-900">{navItems.find((n) => n.id === tab)?.label}</span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <a
              href="/api/docs"
              target="_blank"
              rel="noreferrer"
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              OpenAPI Docs
            </a>
            <button
              type="button"
              onClick={() => void onLogout()}
              className="lg:hidden px-3 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg whitespace-nowrap shrink-0"
            >
              Log Out
            </button>
          </div>
        </header>

        <main className="flex-1 p-6 lg:p-8 max-w-6xl w-full mx-auto space-y-6">
          {actionError && (
            <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
              {actionError}
            </div>
          )}
          {actionSuccess && (
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
              {actionSuccess}
            </div>
          )}

          {loading || !overview ? (
            <TableSkeleton rows={5} />
          ) : (
            <>
              {tab === 'overview' && (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="bg-[#111827] text-white rounded-xl p-5">
                      <p className="text-xs text-slate-300">Aggregate Customer Deposits</p>
                      <p className="text-2xl font-bold font-mono tabular-nums text-white mt-1">
                        {formatInr(overview.aggregates.customerBalancesPaise)}
                      </p>
                      <p className="text-xs text-amber-300 mt-1">
                        {overview.aggregates.customerCount} customers · {overview.aggregates.customerAccounts} accounts
                      </p>
                    </div>
                    <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-5">
                      <p className="text-xs text-amber-900 font-medium">Pending External Clearing</p>
                      <p className="text-2xl font-bold font-mono tabular-nums text-amber-800 mt-1">
                        {formatInr(overview.aggregates.systemClearingBalancePaise)}
                      </p>
                      <p className="text-xs text-amber-700 mt-1">
                        {overview.aggregates.txCounts.pending} pending settlement
                      </p>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-5">
                      <p className="text-xs text-slate-500">Double-Entry Ledger Invariant</p>
                      <div className="flex items-center gap-2 mt-1">
                        <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0" />
                        <p className="text-lg font-bold text-slate-900">
                          {overview.aggregates.ledgerBalanced ? 'Zero-Sum Balanced' : 'Imbalance Detected'}
                        </p>
                      </div>
                      <p className="text-xs font-mono tabular-nums text-slate-500 mt-1">
                        Debits = Credits ({formatInr(overview.aggregates.totalDebitsPaise)})
                      </p>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-5">
                      <p className="text-xs text-slate-500">Staff &amp; Activity</p>
                      <p className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-1">
                        {overview.aggregates.activeEmployees} Active
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        {overview.aggregates.pendingInvites} pending invites · {overview.aggregates.txCounts.success} settled tx
                      </p>
                    </div>
                  </div>

                  <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                    <div className="flex items-center gap-2">
                      <Activity className="w-4 h-4 text-slate-700" />
                      <h2 className="text-base font-bold text-slate-900">Recent Bank-Wide Activity</h2>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-500">
                            <th className="py-2 pr-4 font-medium">Reference</th>
                            <th className="py-2 pr-4 font-medium">Rail / Type</th>
                            <th className="py-2 pr-4 font-medium">Description</th>
                            <th className="py-2 pr-4 font-medium">Status</th>
                            <th className="py-2 text-right font-medium">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {overview.recentActivity.map((tx) => (
                            <tr key={tx.id}>
                              <td className="py-2.5 pr-4 font-mono text-slate-700 whitespace-nowrap">{tx.reference_code}</td>
                              <td className="py-2.5 pr-4 font-mono text-slate-600 whitespace-nowrap">
                                {tx.tx_type} · {tx.provider_name}
                              </td>
                              <td className="py-2.5 pr-4 text-slate-900">{tx.description}</td>
                              <td className="py-2.5 pr-4">
                                <TxStatusText status={tx.status} />
                              </td>
                              <td className="py-2.5 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                                {formatInr(tx.amount_paise)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {tab === 'employees' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                  <form onSubmit={handleInviteEmployee} className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                    <div>
                      <h2 className="text-base font-bold text-slate-900">Invite Employee</h2>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Requires a Gmail address and mobile number. Employee must verify both before access is enabled.
                      </p>
                    </div>

                    {invError && (
                      <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                        {invError}
                      </div>
                    )}

                    {invSandboxOutput && (
                      <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 space-y-1">
                        <p className="font-semibold">Sandbox Invitation Codes (Dev Preview)</p>
                        <p className="font-mono break-all">Token: {invSandboxOutput.inviteToken}</p>
                        <p className="font-mono">
                          Gmail Code: {invSandboxOutput.emailCode} · Mobile Code: {invSandboxOutput.mobileCode}
                        </p>
                      </div>
                    )}

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Full Name</label>
                      <input
                        type="text"
                        required
                        value={invName}
                        onChange={(e) => setInvName(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Gmail Address</label>
                      <input
                        type="email"
                        required
                        value={invEmail}
                        onChange={(e) => setInvEmail(e.target.value)}
                        placeholder="employee.name@gmail.com"
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Mobile Number</label>
                      <input
                        type="tel"
                        required
                        value={invMobile}
                        onChange={(e) => setInvMobile(e.target.value)}
                        placeholder="+919800002222"
                        className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Department</label>
                      <input
                        type="text"
                        required
                        value={invDept}
                        onChange={(e) => setInvDept(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                      />
                    </div>
                    <button
                      type="submit"
                      className="w-full py-2.5 px-4 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                    >
                      Send Employee Invitation
                    </button>
                  </form>

                  <div className="lg:col-span-7 space-y-6">
                    <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                      <h3 className="text-base font-bold text-slate-900">Employee Directory</h3>
                      <div className="divide-y divide-slate-100">
                        {employees.map((emp) => (
                          <div key={emp.id} className="py-3.5 space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <p className="text-sm font-semibold text-slate-900">{emp.fullName}</p>
                                <p className="text-xs text-slate-500">
                                  <span className="font-mono">{emp.username}</span> · {emp.email} · {emp.mobile} ·{' '}
                                  {emp.department}
                                </p>
                              </div>
                              <span
                                className={`text-xs font-medium ${
                                  emp.status === 'active' ? 'text-emerald-700' : 'text-red-700'
                                }`}
                              >
                                {emp.status}
                              </span>
                            </div>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={reasonInputs[emp.id] || ''}
                                onChange={(e) => setReasonInputs((prev) => ({ ...prev, [emp.id]: e.target.value }))}
                                placeholder="Audit reason for status change..."
                                className="flex-1 px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                              />
                              <button
                                type="button"
                                onClick={() => void handleToggleEmployeeStatus(emp)}
                                className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap ${
                                  emp.status === 'active'
                                    ? 'text-red-700 border border-red-300 hover:bg-red-50'
                                    : 'text-emerald-700 border border-emerald-300 hover:bg-emerald-50'
                                }`}
                              >
                                {emp.status === 'active' ? 'Deactivate' : 'Reactivate'}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
                      <h3 className="text-base font-bold text-slate-900">Invitation Log</h3>
                      {invites.length === 0 ? (
                        <EmptyState title="No invitations issued" description="Invited employees will appear here." />
                      ) : (
                        <div className="divide-y divide-slate-100 text-xs">
                          {invites.map((inv) => (
                            <div key={inv.id} className="py-2.5 flex items-center justify-between gap-4">
                              <div>
                                <p className="font-semibold text-slate-900">
                                  {inv.full_name} ({inv.email})
                                </p>
                                <p className="text-slate-500">
                                  {inv.department} · Expires {formatDateTime(inv.expires_at)}
                                </p>
                              </div>
                              <span className="font-mono text-slate-700">{inv.status}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {tab === 'ledger' && (
                <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Ledger Oversight, Reconciliation &amp; Reversals</h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Pending external transfers can be reconciled; settled transactions can be reversed via compensating double-entry postings.
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-500">
                          <th className="py-2 pr-3 font-medium">Reference</th>
                          <th className="py-2 pr-3 font-medium">Details</th>
                          <th className="py-2 pr-3 font-medium">Status</th>
                          <th className="py-2 pr-3 text-right font-medium">Amount</th>
                          <th className="py-2 font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {transactions.map((tx) => (
                          <tr key={tx.id}>
                            <td className="py-3 pr-3 font-mono text-slate-700 whitespace-nowrap">{tx.reference_code}</td>
                            <td className="py-3 pr-3">
                              <p className="font-medium text-slate-900">{tx.description}</p>
                              <p className="text-slate-500">
                                {tx.tx_type} · {tx.provider_name} · {formatDateTime(tx.created_at)}
                              </p>
                            </td>
                            <td className="py-3 pr-3">
                              <TxStatusText status={tx.status} />
                            </td>
                            <td className="py-3 pr-3 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                              {formatInr(tx.amount_paise)}
                            </td>
                            <td className="py-3 whitespace-nowrap">
                              {tx.status === 'pending' && (
                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => void handleReconcile(tx.id, 'success')}
                                    className="px-2.5 py-1 text-xs font-medium text-emerald-700 border border-emerald-300 rounded hover:bg-emerald-50"
                                  >
                                    Confirm Settled
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleReconcile(tx.id, 'failed')}
                                    className="px-2.5 py-1 text-xs font-medium text-red-700 border border-red-300 rounded hover:bg-red-50"
                                  >
                                    Fail &amp; Refund
                                  </button>
                                </div>
                              )}
                              {tx.status === 'success' && tx.tx_type !== 'reversal' && tx.tx_type !== 'opening_deposit' && (
                                <button
                                  type="button"
                                  onClick={() => void handleReverse(tx.id)}
                                  className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded hover:bg-slate-100"
                                >
                                  Reverse
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {tab === 'customers' && (
                <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Customer Directory (Management Summary)</h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Displays only operational account summaries needed for governance. Authentication secrets and raw KYC data are excluded.
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-500">
                          <th className="py-2 pr-4 font-medium">Customer</th>
                          <th className="py-2 pr-4 font-medium">Masked Contact</th>
                          <th className="py-2 pr-4 font-medium">Account</th>
                          <th className="py-2 pr-4 font-medium">KYC</th>
                          <th className="py-2 text-right font-medium">Balance</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {customers.map((c) => (
                          <tr key={c.userId}>
                            <td className="py-3 pr-4 font-semibold text-slate-900">{c.fullName}</td>
                            <td className="py-3 pr-4 font-mono text-slate-600">{c.mobileMasked}</td>
                            <td className="py-3 pr-4 font-mono text-slate-600">
                              {c.accountNumberMasked} · {c.accountType} ({c.accountStatus})
                            </td>
                            <td className="py-3 pr-4 text-emerald-700 font-medium">{c.kycStatus}</td>
                            <td className="py-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                              {formatInr(c.balancePaise)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {tab === 'audit' && (
                <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                  <h2 className="text-lg font-bold text-slate-900">Immutable Security &amp; Operational Audit Trail</h2>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-500">
                          <th className="py-2 pr-3 font-medium">Timestamp</th>
                          <th className="py-2 pr-3 font-medium">Actor</th>
                          <th className="py-2 pr-3 font-medium">Action</th>
                          <th className="py-2 pr-3 font-medium">Target</th>
                          <th className="py-2 font-medium">Sanitized Details</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {auditLogs.map((log) => (
                          <tr key={log.id}>
                            <td className="py-2.5 pr-3 text-slate-500 whitespace-nowrap">{formatDateTime(log.created_at)}</td>
                            <td className="py-2.5 pr-3 font-mono text-slate-700 whitespace-nowrap">
                              {log.actor_username || 'system'} ({log.actor_role || 'sys'})
                            </td>
                            <td className="py-2.5 pr-3 font-mono font-semibold text-slate-900 whitespace-nowrap">{log.action}</td>
                            <td className="py-2.5 pr-3 font-mono text-slate-600 whitespace-nowrap">
                              {log.target_type}:{log.target_id?.slice(0, 18)}
                            </td>
                            <td className="py-2.5 font-mono text-slate-500 max-w-md truncate">{log.details_json}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {tab === 'credentials' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                  <form onSubmit={handleCreateCredential} className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                    <div>
                      <h2 className="text-base font-bold text-slate-900">Create User or Employee Login</h2>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Saves username and salted scrypt-hashed password. Users must change temporary passwords on first sign-in.
                      </p>
                    </div>

                    {credError && (
                      <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                        {credError}
                      </div>
                    )}

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Portal Role</label>
                      <select
                        value={credRole}
                        onChange={(e) => setCredRole(e.target.value as 'user' | 'employee')}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                      >
                        <option value="user">User (Customer Login)</option>
                        <option value="employee">Employee (Teller Login)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Full Name</label>
                      <input
                        type="text"
                        required
                        value={credName}
                        onChange={(e) => setCredName(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Username</label>
                      <input
                        type="text"
                        required
                        value={credUsername}
                        onChange={(e) => setCredUsername(e.target.value)}
                        placeholder={credRole === 'employee' ? 'e.g. teller.sanjay' : 'e.g. rhea.kapoor'}
                        className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        {credRole === 'employee' ? 'Gmail Address' : 'Email Address'}
                      </label>
                      <input
                        type="email"
                        required
                        value={credEmail}
                        onChange={(e) => setCredEmail(e.target.value)}
                        placeholder={credRole === 'employee' ? 'name@gmail.com' : 'name@example.com'}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Mobile Number</label>
                      <input
                        type="tel"
                        required
                        value={credMobile}
                        onChange={(e) => setCredMobile(e.target.value)}
                        placeholder="+919800001099"
                        className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                      />
                    </div>
                    {credRole === 'employee' && (
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">Department</label>
                        <input
                          type="text"
                          required
                          value={credDept}
                          onChange={(e) => setCredDept(e.target.value)}
                          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                        />
                      </div>
                    )}
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Temporary Password (min 8 chars)</label>
                      <input
                        type="password"
                        required
                        minLength={8}
                        value={credTempPass}
                        onChange={(e) => setCredTempPass(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                      />
                    </div>
                    <button
                      type="submit"
                      className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                    >
                      Save {credRole === 'employee' ? 'Employee' : 'User'} Login
                    </button>
                  </form>

                  <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-base font-bold text-slate-900">Saved User &amp; Employee Credentials</h3>
                        <p className="text-xs text-slate-500 mt-0.5">
                          All passwords are stored as one-way salted scrypt hashes. Managers can reset temporary passwords or unlock accounts with an audit trail.
                        </p>
                      </div>
                      <div className="flex gap-1 p-1 bg-slate-100 rounded-lg">
                        {(['all', 'user', 'employee'] as const).map((f) => (
                          <button
                            key={f}
                            type="button"
                            onClick={() => setCredFilter(f)}
                            className={`px-2.5 py-1 text-xs font-medium rounded capitalize ${
                              credFilter === f ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                            }`}
                          >
                            {f === 'all' ? 'All' : `${f}s`}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="divide-y divide-slate-100">
                      {credentials
                        .filter((c) => credFilter === 'all' || c.role === credFilter)
                        .map((cred) => {
                          const isLocked = Boolean(cred.lockedUntil && new Date(cred.lockedUntil).getTime() > Date.now());
                          return (
                            <div key={cred.id} className="py-4 space-y-2.5">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                  <p className="text-sm font-semibold text-slate-900">
                                    {cred.fullName}{' '}
                                    <span className="font-mono text-xs text-slate-600">({cred.username})</span>
                                  </p>
                                  <p className="text-xs text-slate-500 mt-0.5">
                                    Role: <span className="font-semibold uppercase text-slate-700">{cred.role}</span> ·{' '}
                                    {cred.accountMasked ? `Account ${cred.accountMasked}` : cred.department || 'Staff'} ·{' '}
                                    {cred.mobileMasked} · {cred.passwordProtection}
                                  </p>
                                </div>
                                <div className="text-right text-xs">
                                  <span
                                    className={`font-medium ${
                                      isLocked
                                        ? 'text-red-700'
                                        : cred.status === 'active'
                                          ? 'text-emerald-700'
                                          : 'text-slate-500'
                                    }`}
                                  >
                                    {isLocked ? 'Locked' : cred.status}
                                  </span>
                                  {cred.mustChangePassword && (
                                    <p className="text-amber-700">Temp password change pending</p>
                                  )}
                                </div>
                              </div>

                              <div className="flex flex-col sm:flex-row gap-2">
                                <input
                                  type="password"
                                  value={resetPasswords[cred.id] || ''}
                                  onChange={(e) =>
                                    setResetPasswords((prev) => ({ ...prev, [cred.id]: e.target.value }))
                                  }
                                  placeholder="New temp password (min 8 chars)"
                                  className="flex-1 px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                                />
                                <input
                                  type="text"
                                  value={reasonInputs[cred.id] || ''}
                                  onChange={(e) =>
                                    setReasonInputs((prev) => ({ ...prev, [cred.id]: e.target.value }))
                                  }
                                  placeholder="Audit reason..."
                                  className="flex-1 px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                                />
                                <button
                                  type="button"
                                  onClick={() => void handleResetCredentialPassword(cred)}
                                  className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap"
                                >
                                  Reset Password
                                </button>
                                {(isLocked || cred.failedLoginAttempts > 0) && (
                                  <button
                                    type="button"
                                    onClick={() => void handleUnlockCredential(cred)}
                                    className="px-3 py-1.5 text-xs font-medium text-amber-800 border border-amber-300 bg-amber-50 rounded-lg hover:bg-amber-100 whitespace-nowrap"
                                  >
                                    Unlock
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                </div>
              )}

              {tab === 'integrations' && (
                <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <h2 className="text-lg font-bold text-slate-900">Provider Adapters &amp; Production Readiness</h2>
                      <p className="text-xs text-slate-500 mt-0.5">
                        External banking, UPI, Aadhaar KYC, and SMS providers operate in sandbox mode until production credentials and regulatory approvals are configured.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <a
                        href="/api/openapi.json"
                        target="_blank"
                        rel="noreferrer"
                        className="px-3.5 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                      >
                        OpenAPI 3.1 JSON
                      </a>
                      <a
                        href="/api/docs"
                        target="_blank"
                        rel="noreferrer"
                        className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                      >
                        API Reference Viewer
                      </a>
                    </div>
                  </div>

                  <div className="divide-y divide-slate-100">
                    {overview.integrations.map((intg) => (
                      <div key={intg.name} className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">{intg.name}</p>
                          <p className="text-xs text-slate-500 mt-0.5">{intg.requirements}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <span className="text-xs font-mono font-semibold text-amber-700 uppercase">
                            {intg.mode} mode
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
