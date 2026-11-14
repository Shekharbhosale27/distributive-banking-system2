import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  BookOpen,
  Building2,
  CheckCircle2,
  FileCheck2,
  KeyRound,
  LogOut,
  Mail,
  RotateCcw,
  Search,
  Send,
  Shield,
  Trash2,
  Users,
} from 'lucide-react';
import type { User as FirebaseUser } from 'firebase/auth';
import { ApiError, apiFetch, formatDateTime, formatInr, type AuthUser } from '../lib/api';
import { getGoogleAccessToken, googleSignIn, googleSignOut, initGoogleAuth } from '../lib/googleAuth';
import { GoogleSignInButton } from './GoogleSignInButton';
import { EmptyState, TableSkeleton, TxStatusText } from './StatusIndicator';

type ManagerTab = 'overview' | 'credentials' | 'employees' | 'messages' | 'ledger' | 'customers' | 'audit' | 'integrations';

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
    adapter?: string;
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

interface SentMessageRecord {
  id: string;
  user_id: string;
  username: string;
  full_name: string;
  role: 'user' | 'employee';
  channel: 'sms' | 'email' | 'in_app';
  recipient_masked: string;
  message: string;
  provider: string;
  provider_message_id: string | null;
  status: string;
  error_message: string | null;
  created_at: string;
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
  const [accountLimits, setAccountLimits] = useState({ maxUsers: 20, maxEmployees: 5 });

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
  const [credSearch, setCredSearch] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  // Access / Reversal & Integration Diagnostic state
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [reasonInputs, setReasonInputs] = useState<Record<string, string>>({});
  const [diagChannel, setDiagChannel] = useState<'sms' | 'email'>('email');
  const [diagRecipient, setDiagRecipient] = useState('');
  const [diagMessage, setDiagMessage] = useState('Meridian Trust Bank diagnostic alert: Real-time delivery verification.');
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagConfirmGmailOpen, setDiagConfirmGmailOpen] = useState(false);
  const [mgrGoogleUser, setMgrGoogleUser] = useState<FirebaseUser | null>(null);
  const [mgrGoogleToken, setMgrGoogleToken] = useState<string | null>(() => getGoogleAccessToken());

  // Direct Manager Messaging (SMS + Email/Gmail + In-App)
  const [sentMessages, setSentMessages] = useState<SentMessageRecord[]>([]);
  const [msgAudience, setMsgAudience] = useState<'selected' | 'all_users' | 'all_employees' | 'all'>('selected');
  const [msgSelectedIds, setMsgSelectedIds] = useState<string[]>([]);
  const [msgRecipientSearch, setMsgRecipientSearch] = useState('');
  const [msgChannels, setMsgChannels] = useState<{ sms: boolean; email: boolean; inApp: boolean }>({
    sms: true,
    email: true,
    inApp: true,
  });
  const [msgSubject, setMsgSubject] = useState('');
  const [msgBody, setMsgBody] = useState('');
  const [msgBusy, setMsgBusy] = useState(false);
  const [msgConfirmGmailOpen, setMsgConfirmGmailOpen] = useState(false);

  useEffect(() => {
    const unsub = initGoogleAuth(
      (gUser, token) => {
        setMgrGoogleUser(gUser);
        setMgrGoogleToken(token);
      },
      () => {
        setMgrGoogleUser(null);
        setMgrGoogleToken(null);
      },
    );
    return () => unsub();
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, emp, tx, cust, aud, cred, msgs] = await Promise.all([
        apiFetch<OverviewData>('/api/manager/overview'),
        apiFetch<{ employees: EmployeeRecord[]; invites: InviteRecord[] }>('/api/manager/employees'),
        apiFetch<{ transactions: ManagerTxRow[] }>('/api/manager/transactions'),
        apiFetch<{ customers: CustomerSummary[] }>('/api/manager/customers'),
        apiFetch<{ logs: AuditLogRow[] }>('/api/manager/audit-logs'),
        apiFetch<{
          credentials: CredentialRecord[];
          limits?: { maxUsers: number; maxEmployees: number };
        }>('/api/manager/credentials'),
        apiFetch<{ messages: SentMessageRecord[] }>('/api/manager/messages'),
      ]);
      setOverview(ov);
      setEmployees(emp.employees);
      setInvites(emp.invites);
      setTransactions(tx.transactions);
      setCustomers(cust.customers);
      setAuditLogs(aud.logs);
      setCredentials(cred.credentials);
      setSentMessages(msgs.messages);
      if (cred.limits) {
        setAccountLimits({ maxUsers: cred.limits.maxUsers, maxEmployees: cred.limits.maxEmployees });
      }
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

  async function handleManagerGoogleSignIn() {
    setActionError(null);
    try {
      const res = await googleSignIn();
      setMgrGoogleUser(res.user);
      setMgrGoogleToken(res.accessToken);
      setActionSuccess(`Connected Google account (${res.user.email || 'Gmail'}) for Gmail API testing.`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Google Sign-In failed.');
    }
  }

  async function runTestNotification(useConnectedGmail: boolean) {
    setActionError(null);
    setActionSuccess(null);
    setDiagBusy(true);
    try {
      const token = useConnectedGmail ? getGoogleAccessToken() || mgrGoogleToken : null;
      const res = await apiFetch<{
        ok: boolean;
        result: { status: string; provider: string; providerMessageId?: string | null };
      }>('/api/manager/integrations/test-notification', {
        method: 'POST',
        headers: token ? { 'X-Gmail-Access-Token': token } : undefined,
        body: JSON.stringify({
          channel: diagChannel,
          recipient: diagRecipient,
          message: diagMessage,
          confirmed: Boolean(token),
        }),
      });
      setActionSuccess(
        `Notification ${res.result.status} via ${res.result.provider}${
          res.result.providerMessageId ? ` (Ref: ${res.result.providerMessageId})` : ''
        }.`,
      );
      setDiagConfirmGmailOpen(false);
    } catch (err) {
      setDiagConfirmGmailOpen(false);
      setActionError(err instanceof ApiError ? err.message : 'Notification dispatch test failed.');
    } finally {
      setDiagBusy(false);
    }
  }

  function handlePreSubmitTestNotification(e: FormEvent) {
    e.preventDefault();
    if (diagChannel === 'email' && mgrGoogleToken) {
      setDiagConfirmGmailOpen(true);
      return;
    }
    void runTestNotification(false);
  }

  async function handleDeleteAccount(id: string, username: string) {
    setActionError(null);
    setActionSuccess(null);
    setDeletingId(id);
    const reason = reasonInputs[id]?.trim() || `Manager removed account ${username}`;
    try {
      const res = await apiFetch<{ message: string; deleted: { settledBalancePaise: number } }>(
        `/api/manager/credentials/${id}`,
        {
          method: 'DELETE',
          body: JSON.stringify({ reason }),
        },
      );
      const settledSuffix =
        res.deleted.settledBalancePaise > 0
          ? ` Settled ${formatInr(res.deleted.settledBalancePaise)} back to vault.`
          : '';
      setActionSuccess(`${res.message}${settledSuffix}`);
      setConfirmDeleteId(null);
      await loadAll();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Unable to delete account.');
    } finally {
      setDeletingId(null);
    }
  }

  function jumpToMessageRecipient(userId: string) {
    setActionError(null);
    setActionSuccess(null);
    setMsgAudience('selected');
    setMsgSelectedIds([userId]);
    setTab('messages');
  }

  function toggleRecipientId(userId: string) {
    setMsgSelectedIds((prev) => (prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]));
  }

  async function executeSendManagerMessage(useConnectedGmail: boolean) {
    setActionError(null);
    setActionSuccess(null);
    setMsgBusy(true);
    try {
      const channels: Array<'sms' | 'email' | 'in_app'> = [];
      if (msgChannels.sms) channels.push('sms');
      if (msgChannels.email) channels.push('email');
      if (msgChannels.inApp) channels.push('in_app');

      const token = useConnectedGmail ? getGoogleAccessToken() || mgrGoogleToken : null;
      const res = await apiFetch<{
        ok: boolean;
        summary: {
          totalRecipients: number;
          smsSent: number;
          emailSent: number;
          inAppSent: number;
          failedCount: number;
        };
      }>('/api/manager/messages/send', {
        method: 'POST',
        headers: token ? { 'X-Gmail-Access-Token': token } : undefined,
        body: JSON.stringify({
          audience: msgAudience,
          recipientUserIds: msgAudience === 'selected' ? msgSelectedIds : [],
          channels,
          subject: msgSubject,
          message: msgBody,
          confirmed: Boolean(token),
        }),
      });

      const parts = [
        res.summary.smsSent > 0 ? `${res.summary.smsSent} SMS` : null,
        res.summary.emailSent > 0 ? `${res.summary.emailSent} Email` : null,
        res.summary.inAppSent > 0 ? `${res.summary.inAppSent} In-App` : null,
      ].filter(Boolean);
      setActionSuccess(
        `Dispatched to ${res.summary.totalRecipients} recipient(s): ${parts.join(', ')}${
          res.summary.failedCount > 0 ? ` (${res.summary.failedCount} failed)` : ''
        }.`,
      );
      setMsgBody('');
      setMsgSubject('');
      setMsgConfirmGmailOpen(false);
      await loadAll();
    } catch (err) {
      setMsgConfirmGmailOpen(false);
      setActionError(err instanceof ApiError ? err.message : 'Unable to send message or email.');
    } finally {
      setMsgBusy(false);
    }
  }

  function handlePreSubmitManagerMessage(e: FormEvent) {
    e.preventDefault();
    setActionError(null);
    setActionSuccess(null);

    if (!msgChannels.sms && !msgChannels.email && !msgChannels.inApp) {
      setActionError('Select at least one channel (SMS, Email / Gmail, or In-App Alert).');
      return;
    }
    if (msgAudience === 'selected' && msgSelectedIds.length === 0) {
      setActionError('Select at least one active user or employee recipient.');
      return;
    }
    if (msgBody.trim().length < 3) {
      setActionError('Enter a message of at least 3 characters.');
      return;
    }
    if (msgChannels.email && mgrGoogleToken) {
      setMsgConfirmGmailOpen(true);
      return;
    }
    void executeSendManagerMessage(false);
  }

  const navItems: Array<{ id: ManagerTab; label: string; icon: typeof Building2 }> = [
    { id: 'overview', label: 'Bank Overview', icon: Building2 },
    { id: 'credentials', label: 'User & Employee Logins', icon: KeyRound },
    { id: 'employees', label: 'Employees & Invites', icon: Users },
    { id: 'messages', label: 'Messages & Email', icon: Mail },
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
                      <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                        {employees.length} / {accountLimits.maxEmployees} employee slots used · Requires Gmail and mobile verification.
                      </p>
                    </div>

                    {employees.length >= accountLimits.maxEmployees && (
                      <div role="alert" className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
                        Maximum limit of {accountLimits.maxEmployees} employees reached. Delete an existing employee first.
                      </div>
                    )}

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
                      disabled={employees.length >= accountLimits.maxEmployees}
                      className="w-full py-2.5 px-4 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
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
                            <div className="flex flex-wrap gap-2">
                              <input
                                type="text"
                                value={reasonInputs[emp.id] || ''}
                                onChange={(e) => setReasonInputs((prev) => ({ ...prev, [emp.id]: e.target.value }))}
                                placeholder="Audit reason for status or delete action..."
                                className="flex-1 min-w-44 px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                              />
                              <button
                                type="button"
                                onClick={() => jumpToMessageRecipient(emp.id)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
                              >
                                <Mail className="w-3.5 h-3.5" />
                                Message
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleToggleEmployeeStatus(emp)}
                                className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap shrink-0 ${
                                  emp.status === 'active'
                                    ? 'text-amber-800 border border-amber-300 hover:bg-amber-50'
                                    : 'text-emerald-700 border border-emerald-300 hover:bg-emerald-50'
                                }`}
                              >
                                {emp.status === 'active' ? 'Deactivate' : 'Reactivate'}
                              </button>
                              {confirmDeleteId === emp.id ? (
                                <>
                                  <button
                                    type="button"
                                    disabled={deletingId === emp.id}
                                    onClick={() => void handleDeleteAccount(emp.id, emp.username)}
                                    className="px-3 py-1.5 text-xs font-semibold text-white bg-red-700 rounded-lg hover:bg-red-800 disabled:opacity-60 whitespace-nowrap shrink-0"
                                  >
                                    {deletingId === emp.id ? 'Deleting...' : 'Confirm Delete'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteId(null)}
                                    className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(emp.id)}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 border border-red-300 rounded-lg hover:bg-red-50 whitespace-nowrap shrink-0"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                  Delete
                                </button>
                              )}
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

              {tab === 'messages' && (() => {
                const activeAccounts = credentials.filter((c) => c.status === 'active');
                const activeUsers = activeAccounts.filter((c) => c.role === 'user');
                const activeEmployees = activeAccounts.filter((c) => c.role === 'employee');
                const filteredRecipients = activeAccounts.filter((c) => {
                  const q = msgRecipientSearch.trim().toLowerCase();
                  if (!q) return true;
                  return (
                    c.fullName.toLowerCase().includes(q) ||
                    c.username.toLowerCase().includes(q) ||
                    (c.email?.toLowerCase().includes(q) ?? false) ||
                    c.role.toLowerCase().includes(q)
                  );
                });

                const targetRecipientCount =
                  msgAudience === 'all'
                    ? activeAccounts.length
                    : msgAudience === 'all_users'
                      ? activeUsers.length
                      : msgAudience === 'all_employees'
                        ? activeEmployees.length
                        : msgSelectedIds.length;

                return (
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                    <form
                      onSubmit={handlePreSubmitManagerMessage}
                      className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-4"
                    >
                      <div>
                        <h2 className="text-base font-bold text-slate-900">Send Message &amp; Email</h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Dispatch SMS, Gmail/Email notices, and in-app alerts directly to users or employees.
                        </p>
                      </div>

                      <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-medium text-slate-700">1P Gmail Sender</span>
                          {mgrGoogleToken ? (
                            <div className="flex items-center gap-2 text-xs">
                              <span className="font-mono text-emerald-700 truncate max-w-40">
                                {mgrGoogleUser?.email || 'Connected'}
                              </span>
                              <button
                                type="button"
                                onClick={() => void googleSignOut().then(() => setMgrGoogleToken(null))}
                                className="px-2 py-1 border border-slate-300 rounded text-slate-700 bg-white hover:bg-slate-100"
                              >
                                Disconnect
                              </button>
                            </div>
                          ) : (
                            <GoogleSignInButton
                              onClick={() => void handleManagerGoogleSignIn()}
                              label="Connect Gmail"
                            />
                          )}
                        </div>
                        <p className="text-xs text-slate-500">
                          {mgrGoogleToken
                            ? 'Emails will send directly from your connected Gmail account after confirmation.'
                            : 'Optional: connect Gmail to send directly via Gmail API, or use the server SMS/Email gateway.'}
                        </p>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1.5">Audience</label>
                        <select
                          value={msgAudience}
                          onChange={(e) =>
                            setMsgAudience(e.target.value as 'selected' | 'all_users' | 'all_employees' | 'all')
                          }
                          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                        >
                          <option value="selected">
                            Selected User(s) / Employee(s) ({msgSelectedIds.length} selected)
                          </option>
                          <option value="all_users">All Active Users ({activeUsers.length})</option>
                          <option value="all_employees">All Active Employees ({activeEmployees.length})</option>
                          <option value="all">All Active Users &amp; Employees ({activeAccounts.length})</option>
                        </select>
                      </div>

                      {msgAudience === 'selected' && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-slate-700 tabular-nums">
                              Recipients ({msgSelectedIds.length} chosen)
                            </span>
                            {msgSelectedIds.length > 0 && (
                              <button
                                type="button"
                                onClick={() => setMsgSelectedIds([])}
                                className="text-xs text-slate-600 hover:text-slate-900 underline"
                              >
                                Clear selection
                              </button>
                            )}
                          </div>
                          <div className="relative">
                            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                            <input
                              type="search"
                              value={msgRecipientSearch}
                              onChange={(e) => setMsgRecipientSearch(e.target.value)}
                              placeholder="Filter by name, username, role..."
                              className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                            />
                          </div>
                          <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                            {filteredRecipients.length === 0 ? (
                              <p className="p-3 text-xs text-slate-500">No active recipients match filter.</p>
                            ) : (
                              filteredRecipients.map((r) => {
                                const checked = msgSelectedIds.includes(r.id);
                                return (
                                  <label
                                    key={r.id}
                                    className="flex items-start gap-2.5 p-2.5 text-xs hover:bg-slate-50 cursor-pointer"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => toggleRecipientId(r.id)}
                                      className="mt-0.5 rounded border-slate-300"
                                    />
                                    <div className="min-w-0 flex-1">
                                      <p className="font-semibold text-slate-900 truncate">
                                        {r.fullName}{' '}
                                        <span className="font-mono font-normal text-slate-500">({r.username})</span>
                                      </p>
                                      <p className="text-slate-500 truncate">
                                        <span className="uppercase font-semibold text-slate-700">{r.role}</span> ·{' '}
                                        {r.email || 'no email'} · {r.mobileMasked}
                                      </p>
                                    </div>
                                  </label>
                                );
                              })
                            )}
                          </div>
                        </div>
                      )}

                      <div>
                        <span className="block text-xs font-medium text-slate-700 mb-1.5">Delivery Channels</span>
                        <div className="grid grid-cols-3 gap-2 text-xs">
                          <label className="flex items-center gap-2 p-2 border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50">
                            <input
                              type="checkbox"
                              checked={msgChannels.sms}
                              onChange={(e) => setMsgChannels((prev) => ({ ...prev, sms: e.target.checked }))}
                            />
                            <span>SMS</span>
                          </label>
                          <label className="flex items-center gap-2 p-2 border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50">
                            <input
                              type="checkbox"
                              checked={msgChannels.email}
                              onChange={(e) => setMsgChannels((prev) => ({ ...prev, email: e.target.checked }))}
                            />
                            <span>Email</span>
                          </label>
                          <label className="flex items-center gap-2 p-2 border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50">
                            <input
                              type="checkbox"
                              checked={msgChannels.inApp}
                              onChange={(e) => setMsgChannels((prev) => ({ ...prev, inApp: e.target.checked }))}
                            />
                            <span>In-App</span>
                          </label>
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Subject (used in Email &amp; Notice header)
                        </label>
                        <input
                          type="text"
                          maxLength={140}
                          value={msgSubject}
                          onChange={(e) => setMsgSubject(e.target.value)}
                          placeholder="e.g. Branch Operations Update or Account Notice"
                          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                        />
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label className="text-xs font-medium text-slate-700">Message</label>
                          <span className="text-xs text-slate-400 tabular-nums">{msgBody.length}/1000</span>
                        </div>
                        <textarea
                          required
                          minLength={3}
                          maxLength={1000}
                          rows={4}
                          value={msgBody}
                          onChange={(e) => setMsgBody(e.target.value)}
                          placeholder="Write your official message to the selected user(s) or employee(s)..."
                          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                        />
                      </div>

                      <button
                        type="submit"
                        disabled={msgBusy || targetRecipientCount === 0}
                        className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
                      >
                        <Send className="w-3.5 h-3.5" />
                        {msgBusy
                          ? 'Dispatching...'
                          : `Send to ${targetRecipientCount} Recipient${targetRecipientCount === 1 ? '' : 's'}`}
                      </button>
                    </form>

                    <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                      <div>
                        <h3 className="text-base font-bold text-slate-900">Dispatched Messages &amp; Email Log</h3>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Delivery status across SMS, Email/Gmail API, and In-App Bank Alerts (contacts remain masked).
                        </p>
                      </div>

                      {sentMessages.length === 0 ? (
                        <EmptyState
                          title="No manager notices sent yet"
                          description="Messages and emails dispatched to users or employees will appear here with provider status."
                        />
                      ) : (
                        <div className="divide-y divide-slate-100">
                          {sentMessages.map((m) => (
                            <div key={m.id} className="py-3.5 space-y-1">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-xs font-semibold text-slate-900">
                                  {m.full_name}{' '}
                                  <span className="font-mono font-normal text-slate-500">({m.username})</span> ·{' '}
                                  <span className="uppercase text-slate-700">{m.role}</span>
                                </p>
                                <span
                                  className={`text-xs font-mono ${
                                    m.status === 'sent'
                                      ? 'text-emerald-700 font-semibold'
                                      : m.status === 'failed'
                                        ? 'text-red-700 font-semibold'
                                        : 'text-amber-700'
                                  }`}
                                >
                                  {m.channel.toUpperCase()} · {m.status}
                                </span>
                              </div>
                              <p className="text-xs text-slate-700">{m.message}</p>
                              <p className="text-xs text-slate-500">
                                {m.recipient_masked} · {m.provider}
                                {m.provider_message_id ? ` · ${m.provider_message_id}` : ''} ·{' '}
                                {formatDateTime(m.created_at)}
                              </p>
                              {m.error_message && <p className="text-xs text-red-700">{m.error_message}</p>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

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

              {tab === 'credentials' && (() => {
                const userCount = credentials.filter((c) => c.role === 'user').length;
                const empCount = credentials.filter((c) => c.role === 'employee').length;
                const selectedAtLimit =
                  credRole === 'user'
                    ? userCount >= accountLimits.maxUsers
                    : empCount >= accountLimits.maxEmployees;

                return (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                  <form onSubmit={handleCreateCredential} className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                    <div>
                      <h2 className="text-base font-bold text-slate-900">Create User or Employee Login</h2>
                      <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                        Max {accountLimits.maxUsers} user IDs ({userCount}/{accountLimits.maxUsers}) · Max{' '}
                        {accountLimits.maxEmployees} employees ({empCount}/{accountLimits.maxEmployees})
                      </p>
                    </div>

                    {selectedAtLimit && (
                      <div role="alert" className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
                        {credRole === 'employee'
                          ? `Maximum limit of ${accountLimits.maxEmployees} employees reached. Delete an existing employee first.`
                          : `Maximum limit of ${accountLimits.maxUsers} user IDs reached. Delete an existing user first.`}
                      </div>
                    )}

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
                        <option value="user">
                          User (Customer Login · {userCount}/{accountLimits.maxUsers})
                        </option>
                        <option value="employee">
                          Employee (Teller Login · {empCount}/{accountLimits.maxEmployees})
                        </option>
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
                      disabled={selectedAtLimit}
                      className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Save {credRole === 'employee' ? 'Employee' : 'User'} Login
                    </button>
                  </form>

                  <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-base font-bold text-slate-900">Saved User &amp; Employee Credentials</h3>
                        <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                          {userCount} / {accountLimits.maxUsers} users · {empCount} / {accountLimits.maxEmployees} employees · Salted scrypt hashes
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="relative">
                          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                          <input
                            type="search"
                            value={credSearch}
                            onChange={(e) => setCredSearch(e.target.value)}
                            placeholder="Search name or username..."
                            className="pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg w-48"
                          />
                        </div>
                        <div className="flex gap-1 p-1 bg-slate-100 rounded-lg">
                          {(['all', 'user', 'employee'] as const).map((f) => {
                            const label =
                              f === 'all'
                                ? `All (${credentials.length})`
                                : f === 'user'
                                  ? `Users (${userCount}/${accountLimits.maxUsers})`
                                  : `Employees (${empCount}/${accountLimits.maxEmployees})`;
                            return (
                              <button
                                key={f}
                                type="button"
                                onClick={() => setCredFilter(f)}
                                className={`px-2.5 py-1 text-xs font-medium rounded whitespace-nowrap shrink-0 tabular-nums ${
                                  credFilter === f ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                                }`}
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    {credentials.length === 0 ? (
                      <EmptyState
                        title="No user or employee logins yet"
                        description="Create up to 20 user IDs and 5 employee IDs using the form on the left."
                      />
                    ) : (
                      <div className="divide-y divide-slate-100">
                      {credentials
                        .filter((c) => credFilter === 'all' || c.role === credFilter)
                        .filter((c) => {
                          const q = credSearch.trim().toLowerCase();
                          if (!q) return true;
                          return (
                            c.username.toLowerCase().includes(q) ||
                            c.fullName.toLowerCase().includes(q) ||
                            (c.email?.toLowerCase().includes(q) ?? false) ||
                            (c.accountMasked?.toLowerCase().includes(q) ?? false)
                          );
                        })
                        .map((cred) => {
                          const isLocked = Boolean(cred.lockedUntil && new Date(cred.lockedUntil).getTime() > Date.now());
                          const isConfirmingDelete = confirmDeleteId === cred.id;
                          return (
                            <div key={cred.id} className="py-4 space-y-2.5">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                  <p className="text-sm font-semibold text-slate-900">
                                    {cred.fullName}{' '}
                                    <span className="font-mono text-xs text-slate-600">({cred.username})</span>
                                  </p>
                                  <p className="text-xs text-slate-500 mt-0.5">
                                    <span className="font-semibold uppercase text-slate-700">{cred.role}</span> ·{' '}
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

                              <div className="flex flex-wrap gap-2">
                                <input
                                  type="password"
                                  value={resetPasswords[cred.id] || ''}
                                  onChange={(e) =>
                                    setResetPasswords((prev) => ({ ...prev, [cred.id]: e.target.value }))
                                  }
                                  placeholder="New temp password (min 8 chars)"
                                  className="flex-1 min-w-44 px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                                />
                                <input
                                  type="text"
                                  value={reasonInputs[cred.id] || ''}
                                  onChange={(e) =>
                                    setReasonInputs((prev) => ({ ...prev, [cred.id]: e.target.value }))
                                  }
                                  placeholder="Audit reason..."
                                  className="flex-1 min-w-36 px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                                />
                                <button
                                  type="button"
                                  onClick={() => jumpToMessageRecipient(cred.id)}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
                                >
                                  <Mail className="w-3.5 h-3.5" />
                                  Message
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleResetCredentialPassword(cred)}
                                  className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap shrink-0"
                                >
                                  Reset Password
                                </button>
                                {(isLocked || cred.failedLoginAttempts > 0) && (
                                  <button
                                    type="button"
                                    onClick={() => void handleUnlockCredential(cred)}
                                    className="px-3 py-1.5 text-xs font-medium text-amber-800 border border-amber-300 bg-amber-50 rounded-lg hover:bg-amber-100 whitespace-nowrap shrink-0"
                                  >
                                    Unlock
                                  </button>
                                )}
                                {isConfirmingDelete ? (
                                  <>
                                    <button
                                      type="button"
                                      disabled={deletingId === cred.id}
                                      onClick={() => void handleDeleteAccount(cred.id, cred.username)}
                                      className="px-3 py-1.5 text-xs font-semibold text-white bg-red-700 rounded-lg hover:bg-red-800 disabled:opacity-60 whitespace-nowrap shrink-0"
                                    >
                                      {deletingId === cred.id ? 'Deleting...' : 'Confirm Delete'}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmDeleteId(null)}
                                      className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
                                    >
                                      Cancel
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteId(cred.id)}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 border border-red-300 rounded-lg hover:bg-red-50 whitespace-nowrap shrink-0"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                    Delete
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
                );
              })()}

              {tab === 'integrations' && (
                <div className="space-y-6">
                  <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <h2 className="text-lg font-bold text-slate-900">Provider Adapters &amp; Production Readiness</h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                          External banking, UPI, Aadhaar KYC, SMS, and Gmail/Email providers support live API keys via environment variables or Google Sign-In OAuth.
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
                          <div className="text-right shrink-0 space-y-0.5">
                            <span
                              className={`text-xs font-mono font-semibold uppercase ${
                                intg.mode === 'live'
                                  ? intg.configured
                                    ? 'text-emerald-700'
                                    : 'text-red-700'
                                  : 'text-amber-700'
                              }`}
                            >
                              {intg.mode} mode {intg.adapter && intg.adapter !== 'none' ? `· ${intg.adapter}` : ''}
                            </span>
                            <p className="text-xs text-slate-500">
                              {intg.configured ? 'Credentials ready' : 'Awaiting env credentials'}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <h3 className="text-base font-bold text-slate-900">Test Live SMS &amp; Gmail Notification API</h3>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Verify real Twilio/MSG91/Fast2SMS SMS or Gmail API / Gmail SMTP / Resend delivery without affecting ledger balances.
                        </p>
                      </div>
                      {mgrGoogleToken ? (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-mono text-emerald-700">
                            Gmail connected ({mgrGoogleUser?.email || 'Google'})
                          </span>
                          <button
                            type="button"
                            onClick={() => void googleSignOut().then(() => setMgrGoogleToken(null))}
                            className="px-2.5 py-1 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50"
                          >
                            Disconnect
                          </button>
                        </div>
                      ) : (
                        <GoogleSignInButton
                          onClick={() => void handleManagerGoogleSignIn()}
                          label="Connect Gmail for Testing"
                        />
                      )}
                    </div>

                    <form onSubmit={handlePreSubmitTestNotification} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                      <div className="md:col-span-2">
                        <label className="block text-xs font-medium text-slate-700 mb-1">Channel</label>
                        <select
                          value={diagChannel}
                          onChange={(e) => setDiagChannel(e.target.value as 'sms' | 'email')}
                          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                        >
                          <option value="email">Gmail / Email</option>
                          <option value="sms">Mobile SMS</option>
                        </select>
                      </div>
                      <div className="md:col-span-4">
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          {diagChannel === 'email' ? 'Recipient Gmail / Email' : 'Recipient Mobile (+91...)'}
                        </label>
                        <input
                          type={diagChannel === 'email' ? 'email' : 'tel'}
                          required
                          value={diagRecipient}
                          onChange={(e) => setDiagRecipient(e.target.value)}
                          placeholder={diagChannel === 'email' ? 'recipient@gmail.com' : '+919800001001'}
                          className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                        />
                      </div>
                      <div className="md:col-span-4">
                        <label className="block text-xs font-medium text-slate-700 mb-1">Test Message</label>
                        <input
                          type="text"
                          required
                          value={diagMessage}
                          onChange={(e) => setDiagMessage(e.target.value)}
                          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <button
                          type="submit"
                          disabled={diagBusy}
                          className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 px-3 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap"
                        >
                          <Send className="w-3.5 h-3.5" />
                          {diagBusy ? 'Sending...' : 'Send Test'}
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {diagConfirmGmailOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl p-6 max-w-md w-full space-y-4">
            <div className="flex items-center gap-2 text-emerald-700">
              <Mail className="w-5 h-5" />
              <h3 className="text-base font-bold text-slate-900">Confirm Sending Test Email via Gmail</h3>
            </div>
            <p className="text-xs text-slate-600">
              Send diagnostic email to <span className="font-mono text-slate-900">{diagRecipient}</span> using your connected Gmail account ({mgrGoogleUser?.email || 'Google'})?
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={diagBusy}
                onClick={() => void runTestNotification(true)}
                className="flex-1 py-2.5 px-4 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-60"
              >
                {diagBusy ? 'Sending...' : 'Confirm & Send Email'}
              </button>
              <button
                type="button"
                disabled={diagBusy}
                onClick={() => setDiagConfirmGmailOpen(false)}
                className="py-2.5 px-4 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {msgConfirmGmailOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl p-6 max-w-md w-full space-y-4">
            <div className="flex items-center gap-2 text-emerald-700">
              <Mail className="w-5 h-5" />
              <h3 className="text-base font-bold text-slate-900">Confirm Sending Emails via Gmail</h3>
            </div>
            <div className="border-y border-slate-200 py-3 space-y-2 text-xs">
              <div className="flex justify-between gap-4">
                <span className="text-slate-500">Sender Gmail</span>
                <span className="font-mono text-slate-900">{mgrGoogleUser?.email || 'Connected Google Account'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-slate-500">Audience</span>
                <span className="font-semibold text-slate-900">
                  {msgAudience === 'all'
                    ? 'All Active Users & Employees'
                    : msgAudience === 'all_users'
                      ? 'All Active Users'
                      : msgAudience === 'all_employees'
                        ? 'All Active Employees'
                        : `${msgSelectedIds.length} Selected Recipient(s)`}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-slate-500">Subject</span>
                <span className="text-slate-900 text-right">
                  {msgSubject.trim() || 'Notice from Meridian Trust Bank Management'}
                </span>
              </div>
            </div>
            <p className="text-xs text-slate-600">
              Confirming will dispatch email(s) through your connected Google Workspace Gmail account
              {msgChannels.sms ? ' along with SMS alerts' : ''}.
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={msgBusy}
                onClick={() => void executeSendManagerMessage(true)}
                className="flex-1 py-2.5 px-4 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-60"
              >
                {msgBusy ? 'Sending...' : 'Confirm & Dispatch'}
              </button>
              <button
                type="button"
                disabled={msgBusy}
                onClick={() => setMsgConfirmGmailOpen(false)}
                className="py-2.5 px-4 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
