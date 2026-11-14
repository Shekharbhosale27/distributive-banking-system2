import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ArrowLeftRight,
  Bell,
  CheckCircle2,
  HelpCircle,
  LogOut,
  Search,
  ShieldAlert,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  ApiError,
  apiFetch,
  createIdempotencyKey,
  formatDateTime,
  formatInr,
  type AuthUser,
} from '../lib/api';
import { EmptyState, TableSkeleton, TxStatusText } from './StatusIndicator';

type EmployeeTab = 'customers' | 'transactions' | 'onboard' | 'tickets' | 'notifications';

interface CustomerRow {
  userId: string;
  username: string;
  fullName: string;
  email: string | null;
  mobile: string | null;
  userStatus: string;
  kycStatus: string;
  kycMaskedId: string | null;
  accountId: string;
  accountNumber: string;
  accountType: string;
  upiHandle: string | null;
  balancePaise: number;
  createdAt: string;
}

interface CustomerTx {
  id: string;
  reference_code: string;
  tx_type: string;
  status: string;
  amount_paise: number;
  source_account_id: string | null;
  destination_account_id: string | null;
  description: string;
  initiated_by_name: string | null;
  created_at: string;
}

interface BankTxRow {
  id: string;
  reference_code: string;
  tx_type: string;
  status: 'pending' | 'success' | 'failed' | 'reversed';
  amount_paise: number;
  provider_name: string;
  external_destination: string | null;
  description: string;
  source_account_number: string | null;
  source_owner_name: string | null;
  destination_account_number: string | null;
  destination_owner_name: string | null;
  initiated_by_name: string | null;
  initiated_by_role: string | null;
  created_at: string;
}

interface SupportTicket {
  id: string;
  customer_name: string;
  customer_mobile: string | null;
  category: string;
  subject: string;
  message: string;
  related_tx_ref: string | null;
  status: 'open' | 'in_review' | 'resolved';
  resolution_note: string | null;
  created_at: string;
}

interface EmployeeNotificationRow {
  id: string;
  channel: string;
  recipient_masked: string;
  message: string;
  provider: string;
  provider_message_id: string | null;
  status: string;
  error_message: string | null;
  created_at: string;
}

// Client-side Verhoeff generator strictly for local sandbox test data convenience
function generateValidSandboxAadhaar(): string {
  const d = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  ];
  const p = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
  ];
  const inv = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];
  const stem = `${Math.floor(2 + Math.random() * 7)}${String(Math.floor(1000000000 + Math.random() * 8999999999)).slice(0, 10)}`;
  let c = 0;
  const rev = stem.split('').reverse().map(Number);
  for (let i = 0; i < rev.length; i++) {
    c = d[c][p[(i + 1) % 8][rev[i]]];
  }
  return stem + String(inv[c]);
}

export function EmployeeWorkspace({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }) {
  const [tab, setTab] = useState<EmployeeTab>('customers');
  const [searchQuery, setSearchQuery] = useState('');
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [maxAdjustmentPaise, setMaxAdjustmentPaise] = useState(2_500_000);
  const [loading, setLoading] = useState(true);

  const [selectedCustomer, setSelectedCustomer] = useState<CustomerRow | null>(null);
  const [customerHistory, setCustomerHistory] = useState<CustomerTx[]>([]);

  // Teller credit/debit state
  const [adjAction, setAdjAction] = useState<'credit' | 'debit'>('credit');
  const [adjRupees, setAdjRupees] = useState('');
  const [adjReason, setAdjReason] = useState('');
  const [adjIdemKey, setAdjIdemKey] = useState(() => createIdempotencyKey('emp'));
  const [adjConfirmOpen, setAdjConfirmOpen] = useState(false);
  const [adjBusy, setAdjBusy] = useState(false);
  const [adjError, setAdjError] = useState<string | null>(null);
  const [adjResult, setAdjResult] = useState<{ referenceCode: string; balancePaise: number } | null>(null);

  // Onboarding state
  const [onbName, setOnbName] = useState('');
  const [onbUsername, setOnbUsername] = useState('');
  const [onbEmail, setOnbEmail] = useState('');
  const [onbMobile, setOnbMobile] = useState('');
  const [onbPassword, setOnbPassword] = useState('');
  const [onbAccountType, setOnbAccountType] = useState<'checking' | 'savings'>('savings');
  const [onbAadhaar, setOnbAadhaar] = useState('');
  const [onbDepositRupees, setOnbDepositRupees] = useState('');
  const [onbBusy, setOnbBusy] = useState(false);
  const [onbError, setOnbError] = useState<string | null>(null);
  const [onbSuccess, setOnbSuccess] = useState<{
    accountNumber: string;
    kycMaskedId: string;
    kycProviderRef: string;
  } | null>(null);

  // Help Desk tickets
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [resolutionNotes, setResolutionNotes] = useState<Record<string, string>>({});

  // Bank-wide transaction history
  const [bankTransactions, setBankTransactions] = useState<BankTxRow[]>([]);
  const [bankTxTotal, setBankTxTotal] = useState(0);
  const [txLoading, setTxLoading] = useState(false);
  const [txSearch, setTxSearch] = useState('');
  const [txStatusFilter, setTxStatusFilter] = useState<'all' | 'success' | 'pending' | 'failed' | 'reversed'>('all');
  const [notifications, setNotifications] = useState<EmployeeNotificationRow[]>([]);

  const loadCustomers = useCallback(async (q = '') => {
    setLoading(true);
    try {
      const res = await apiFetch<{ customers: CustomerRow[]; maxAdjustmentPaise: number }>(
        `/api/employee/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`,
      );
      setCustomers(res.customers);
      setMaxAdjustmentPaise(res.maxAdjustmentPaise);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await onLogout();
      }
    } finally {
      setLoading(false);
    }
  }, [onLogout]);

  const loadTickets = useCallback(async () => {
    try {
      const res = await apiFetch<{ tickets: SupportTicket[] }>('/api/employee/help-tickets');
      setTickets(res.tickets);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await onLogout();
      }
    }
  }, [onLogout]);

  const loadBankTransactions = useCallback(
    async (q = '', status = 'all') => {
      setTxLoading(true);
      try {
        const params = new URLSearchParams();
        if (q.trim()) params.set('q', q.trim());
        if (status && status !== 'all') params.set('status', status);
        const queryStr = params.toString();
        const res = await apiFetch<{ transactions: BankTxRow[]; totalCount: number }>(
          `/api/employee/transactions${queryStr ? `?${queryStr}` : ''}`,
        );
        setBankTransactions(res.transactions);
        setBankTxTotal(res.totalCount);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          await onLogout();
        }
      } finally {
        setTxLoading(false);
      }
    },
    [onLogout],
  );

  const loadNotifications = useCallback(async () => {
    try {
      const res = await apiFetch<{ notifications: EmployeeNotificationRow[] }>('/api/notifications');
      setNotifications(res.notifications);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await onLogout();
      }
    }
  }, [onLogout]);

  useEffect(() => {
    void loadCustomers();
    void loadTickets();
    void loadBankTransactions();
    void loadNotifications();
  }, [loadCustomers, loadTickets, loadBankTransactions, loadNotifications]);

  async function selectCustomer(userId: string) {
    setAdjError(null);
    setAdjResult(null);
    const res = await apiFetch<{ customer: CustomerRow; transactions: CustomerTx[] }>(
      `/api/employee/customers/${userId}`,
    );
    setSelectedCustomer(res.customer);
    setCustomerHistory(res.transactions);
  }

  function handlePreConfirmAdjustment(e: FormEvent) {
    e.preventDefault();
    setAdjError(null);
    setAdjResult(null);
    const paise = Math.round(Number(adjRupees) * 100);
    if (!paise || paise <= 0) {
      setAdjError('Enter a valid positive INR amount.');
      return;
    }
    if (paise > maxAdjustmentPaise) {
      setAdjError(`Exceeds employee single-operation limit of ${formatInr(maxAdjustmentPaise)}.`);
      return;
    }
    if (adjReason.trim().length < 6) {
      setAdjError('Provide a detailed audit reason (minimum 6 characters).');
      return;
    }
    setAdjConfirmOpen(true);
  }

  async function handleExecuteAdjustment() {
    if (!selectedCustomer) return;
    setAdjBusy(true);
    setAdjError(null);
    const amountPaise = Math.round(Number(adjRupees) * 100);
    try {
      const res = await apiFetch<{ transaction: { reference_code: string }; balancePaise: number }>(
        '/api/employee/adjustments',
        {
          method: 'POST',
          body: JSON.stringify({
            accountId: selectedCustomer.accountId,
            action: adjAction,
            amountPaise,
            reason: adjReason,
            confirmed: true,
            idempotencyKey: adjIdemKey,
          }),
        },
      );
      setAdjConfirmOpen(false);
      setAdjResult({ referenceCode: res.transaction.reference_code, balancePaise: res.balancePaise });
      setAdjIdemKey(createIdempotencyKey('emp'));
      setAdjRupees('');
      setAdjReason('');
      await selectCustomer(selectedCustomer.userId);
      await loadCustomers(searchQuery);
      await loadBankTransactions(txSearch, txStatusFilter);
    } catch (err) {
      setAdjConfirmOpen(false);
      setAdjError(err instanceof ApiError ? err.message : 'Adjustment failed.');
    } finally {
      setAdjBusy(false);
    }
  }

  async function handleOnboardCustomer(e: FormEvent) {
    e.preventDefault();
    setOnbError(null);
    setOnbSuccess(null);
    setOnbBusy(true);
    try {
      const openingDepositPaise = onbDepositRupees ? Math.round(Number(onbDepositRupees) * 100) : 0;
      const res = await apiFetch<{
        customer: { accountNumber: string; kycMaskedId: string; kycProviderRef: string };
      }>('/api/employee/customers', {
        method: 'POST',
        body: JSON.stringify({
          fullName: onbName,
          username: onbUsername,
          email: onbEmail,
          mobile: onbMobile,
          temporaryPassword: onbPassword,
          accountType: onbAccountType,
          aadhaarNumber: onbAadhaar,
          openingDepositPaise,
          idempotencyKey: createIdempotencyKey('onb'),
        }),
      });
      setOnbSuccess({
        accountNumber: res.customer.accountNumber,
        kycMaskedId: res.customer.kycMaskedId,
        kycProviderRef: res.customer.kycProviderRef,
      });
      setOnbName('');
      setOnbUsername('');
      setOnbEmail('');
      setOnbMobile('');
      setOnbPassword('');
      setOnbAadhaar('');
      setOnbDepositRupees('');
      await loadCustomers(searchQuery);
      await loadBankTransactions(txSearch, txStatusFilter);
    } catch (err) {
      setOnbError(err instanceof ApiError ? err.message : 'Customer onboarding failed.');
    } finally {
      setOnbBusy(false);
    }
  }

  async function handleUpdateTicket(id: string, status: 'in_review' | 'resolved') {
    await apiFetch(`/api/employee/help-tickets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, resolutionNote: resolutionNotes[id] || '' }),
    });
    await loadTickets();
  }

  return (
    <div className="min-h-screen bg-[#F4F6FA] flex flex-col lg:flex-row">
      <aside className="w-full lg:w-64 bg-[#0F2547] text-blue-100/90 flex flex-col shrink-0">
        <div className="px-6 py-5 border-b border-blue-900/60">
          <p className="text-base font-bold text-white font-display whitespace-nowrap">Meridian Trust Bank</p>
          <p className="text-xs text-blue-300 font-medium mt-0.5">Employee Teller Desk</p>
        </div>

        <nav className="flex lg:flex-col overflow-x-auto lg:overflow-visible p-3 gap-1 flex-1">
          {[
            { id: 'customers', label: 'Customer Search', icon: Users },
            { id: 'transactions', label: 'Bank Transactions', icon: ArrowLeftRight },
            { id: 'onboard', label: 'Onboard Customer', icon: UserPlus },
            { id: 'tickets', label: 'Help Desk Queue', icon: HelpCircle },
            { id: 'notifications', label: 'Alerts & Inbox', icon: Bell },
          ].map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setTab(item.id as EmployeeTab);
                  if (item.id === 'transactions') {
                    void loadBankTransactions(txSearch, txStatusFilter);
                  } else if (item.id === 'notifications') {
                    void loadNotifications();
                  }
                }}
                className={`flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-blue-500/25 text-white'
                    : 'text-blue-100/70 hover:bg-blue-900/50 hover:text-white'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-blue-300' : ''}`} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-blue-900/60 hidden lg:block">
          <p className="text-xs font-semibold text-white truncate">{user.fullName}</p>
          <p className="text-xs text-blue-300/80 truncate">{user.department || 'Branch Operations'}</p>
          <button
            type="button"
            onClick={() => void onLogout()}
            className="mt-3 w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-blue-100 border border-blue-800 rounded-lg hover:bg-blue-900/60 whitespace-nowrap"
          >
            <LogOut className="w-3.5 h-3.5" />
            Log Out
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white border-b border-slate-200 px-6 lg:px-8 py-4 flex items-center justify-between gap-8">
          <div className="text-sm text-slate-500 truncate">
            <span>Teller Operations</span>
            <span className="mx-2">/</span>
            <span className="font-semibold text-slate-900">
              {tab === 'customers'
                ? 'Customer Search & Adjustments'
                : tab === 'transactions'
                  ? 'All Bank Transactions'
                  : tab === 'onboard'
                    ? 'KYC Onboarding'
                    : tab === 'notifications'
                      ? 'Manager Notices & Alerts Inbox'
                      : 'Help Desk'}
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setTab('onboard')}
              className="px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 whitespace-nowrap shrink-0"
            >
              New Customer Account
            </button>
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
          {tab === 'customers' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void loadCustomers(searchQuery);
                  }}
                  className="flex gap-2"
                >
                  <div className="relative flex-1">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="search"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Name, account #, or mobile..."
                      className="w-full pl-9 pr-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <button
                    type="submit"
                    className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap"
                  >
                    Search
                  </button>
                </form>

                {loading ? (
                  <TableSkeleton rows={4} />
                ) : customers.length === 0 ? (
                  <EmptyState title="No customers matched" description="Try searching by full name, account number, or mobile." />
                ) : (
                  <div className="divide-y divide-slate-100">
                    {customers.map((c) => (
                      <button
                        key={c.userId}
                        type="button"
                        onClick={() => void selectCustomer(c.userId)}
                        className={`w-full text-left py-3 px-2 rounded-lg transition-colors flex items-center justify-between gap-3 ${
                          selectedCustomer?.userId === c.userId ? 'bg-blue-50' : 'hover:bg-slate-50'
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-900 truncate">{c.fullName}</p>
                          <p className="text-xs font-mono text-slate-500 truncate">
                            {c.accountNumber} · {c.mobile}
                          </p>
                        </div>
                        <p className="text-xs font-mono font-semibold tabular-nums text-slate-900 whitespace-nowrap">
                          {formatInr(c.balancePaise)}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="lg:col-span-7 space-y-6">
                {!selectedCustomer ? (
                  <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
                    <p className="text-sm font-semibold text-slate-900">Select a customer profile</p>
                    <p className="text-xs text-slate-500 mt-1">
                      Inspect balances, masked KYC references, transaction history, or execute an audited teller adjustment.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <h2 className="text-lg font-bold text-slate-900">{selectedCustomer.fullName}</h2>
                          <p className="text-xs font-mono text-slate-500 mt-0.5">
                            {selectedCustomer.accountNumber} · {selectedCustomer.accountType.toUpperCase()} · {selectedCustomer.mobile}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs text-slate-500">Current Balance</p>
                          <p className="text-2xl font-bold font-mono tabular-nums text-slate-900">
                            {formatInr(selectedCustomer.balancePaise)}
                          </p>
                        </div>
                      </div>
                      <div className="text-xs text-slate-600 pt-2 border-t border-slate-100 flex flex-wrap gap-4">
                        <span>KYC Status: {selectedCustomer.kycStatus}</span>
                        <span>·</span>
                        <span className="font-mono">KYC Ref: {selectedCustomer.kycMaskedId || 'Verified'}</span>
                        <span>·</span>
                        <span className="font-mono">UPI: {selectedCustomer.upiHandle || 'None'}</span>
                      </div>
                    </div>

                    <form onSubmit={handlePreConfirmAdjustment} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <h3 className="text-base font-bold text-slate-900">Audited Teller Credit / Debit</h3>
                          <p className="text-xs text-slate-500 mt-0.5">
                            Limit per operation: <span className="font-mono">{formatInr(maxAdjustmentPaise)}</span> · Requires audit reason &amp; confirmation.
                          </p>
                        </div>
                      </div>

                      {adjError && (
                        <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                          {adjError}
                        </div>
                      )}
                      {adjResult && (
                        <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center gap-3">
                          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                          <div className="text-xs text-emerald-900">
                            Adjustment committed. Ref: <span className="font-mono font-bold">{adjResult.referenceCode}</span> · Updated Balance:{' '}
                            <span className="font-mono font-bold">{formatInr(adjResult.balancePaise)}</span>
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">Operation</label>
                          <select
                            value={adjAction}
                            onChange={(e) => setAdjAction(e.target.value as 'credit' | 'debit')}
                            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                          >
                            <option value="credit">Credit Account</option>
                            <option value="debit">Debit Account</option>
                          </select>
                        </div>
                        <div className="sm:col-span-2">
                          <label className="block text-xs font-medium text-slate-700 mb-1">Amount (INR)</label>
                          <input
                            type="number"
                            min="1"
                            step="0.01"
                            required
                            value={adjRupees}
                            onChange={(e) => setAdjRupees(e.target.value)}
                            placeholder="1000.00"
                            className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">Mandatory Audit Reason</label>
                        <input
                          type="text"
                          required
                          minLength={6}
                          value={adjReason}
                          onChange={(e) => setAdjReason(e.target.value)}
                          placeholder="e.g. Branch cash deposit slip #4412"
                          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                        />
                      </div>

                      <button
                        type="submit"
                        className="px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800"
                      >
                        Review &amp; Confirm Adjustment
                      </button>
                    </form>

                    <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
                      <h3 className="text-base font-bold text-slate-900">Customer Transaction History</h3>
                      {customerHistory.length === 0 ? (
                        <EmptyState title="No history yet" description="Transactions for this account will appear here." />
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left border-collapse text-xs">
                            <thead>
                              <tr className="border-b border-slate-200 text-slate-500">
                                <th className="py-2 pr-3 font-medium">Reference</th>
                                <th className="py-2 pr-3 font-medium">Description</th>
                                <th className="py-2 pr-3 font-medium">Status</th>
                                <th className="py-2 text-right font-medium">Amount</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {customerHistory.map((tx) => {
                                const isCredit = tx.destination_account_id === selectedCustomer.accountId;
                                return (
                                  <tr key={tx.id}>
                                    <td className="py-2.5 pr-3 font-mono text-slate-700 whitespace-nowrap">{tx.reference_code}</td>
                                    <td className="py-2.5 pr-3">
                                      <p className="text-slate-900 font-medium">{tx.description}</p>
                                      <p className="text-slate-500">{formatDateTime(tx.created_at)}</p>
                                    </td>
                                    <td className="py-2.5 pr-3">
                                      <TxStatusText status={tx.status} />
                                    </td>
                                    <td
                                      className={`py-2.5 text-right font-mono tabular-nums font-semibold whitespace-nowrap ${
                                        isCredit ? 'text-emerald-700' : 'text-slate-900'
                                      }`}
                                    >
                                      {isCredit ? '+' : '-'}
                                      {formatInr(tx.amount_paise)}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {tab === 'onboard' && (
            <form onSubmit={handleOnboardCustomer} className="bg-white border border-slate-200 rounded-xl p-6 max-w-2xl space-y-5">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Onboard New Customer Account</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Aadhaar is verified in real time through our approved KYC provider adapter. Raw Aadhaar numbers are never stored in the database or audit logs.
                </p>
              </div>

              {onbError && (
                <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                  {onbError}
                </div>
              )}

              {onbSuccess && (
                <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 space-y-1">
                  <p className="font-semibold text-sm">Customer Account Created &amp; KYC Verified</p>
                  <p>
                    Account Number: <span className="font-mono font-bold">{onbSuccess.accountNumber}</span> · Masked KYC:{' '}
                    <span className="font-mono">{onbSuccess.kycMaskedId}</span> · Provider Ref:{' '}
                    <span className="font-mono">{onbSuccess.kycProviderRef}</span>
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Full Legal Name</label>
                  <input
                    type="text"
                    required
                    value={onbName}
                    onChange={(e) => setOnbName(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Username</label>
                  <input
                    type="text"
                    required
                    value={onbUsername}
                    onChange={(e) => setOnbUsername(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Email Address</label>
                  <input
                    type="email"
                    required
                    value={onbEmail}
                    onChange={(e) => setOnbEmail(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Mobile Number</label>
                  <input
                    type="tel"
                    required
                    value={onbMobile}
                    onChange={(e) => setOnbMobile(e.target.value)}
                    placeholder="+919800001050"
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Temporary Password</label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={onbPassword}
                    onChange={(e) => setOnbPassword(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Account Type</label>
                  <select
                    value={onbAccountType}
                    onChange={(e) => setOnbAccountType(e.target.value as 'checking' | 'savings')}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="savings">Savings Account</option>
                    <option value="checking">Checking Account</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-100">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-slate-700">12-Digit Aadhaar (KYC Only)</label>
                    <button
                      type="button"
                      onClick={() => setOnbAadhaar(generateValidSandboxAadhaar())}
                      className="text-xs text-blue-700 hover:underline"
                    >
                      Fill Test Valid ID
                    </button>
                  </div>
                  <input
                    type="text"
                    required
                    value={onbAadhaar}
                    onChange={(e) => setOnbAadhaar(e.target.value)}
                    placeholder="12 digits (Verhoeff verified)"
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Opening Deposit INR (Optional, max {formatInr(maxAdjustmentPaise)})
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={onbDepositRupees}
                    onChange={(e) => setOnbDepositRupees(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={onbBusy}
                className="px-5 py-2.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-60"
              >
                {onbBusy ? 'Verifying KYC & Creating Account...' : 'Verify Aadhaar & Open Account'}
              </button>
            </form>
          )}

          {tab === 'transactions' && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">All Bank Transactions</h2>
                  <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                    Showing {bankTransactions.length} of {bankTxTotal} bank-wide ledger transactions
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void loadBankTransactions(txSearch, txStatusFilter);
                    }}
                    className="flex gap-2"
                  >
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="search"
                        value={txSearch}
                        onChange={(e) => setTxSearch(e.target.value)}
                        placeholder="Ref, account, or name..."
                        className="pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg w-52"
                      />
                    </div>
                    <button
                      type="submit"
                      className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 whitespace-nowrap shrink-0"
                    >
                      Search
                    </button>
                  </form>

                  <div className="flex gap-1 p-1 bg-slate-100 rounded-lg">
                    {(['all', 'success', 'pending', 'failed', 'reversed'] as const).map((st) => (
                      <button
                        key={st}
                        type="button"
                        onClick={() => {
                          setTxStatusFilter(st);
                          void loadBankTransactions(txSearch, st);
                        }}
                        className={`px-2.5 py-1 text-xs font-medium rounded capitalize whitespace-nowrap shrink-0 ${
                          txStatusFilter === st ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                        }`}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {txLoading ? (
                <TableSkeleton rows={5} />
              ) : bankTransactions.length === 0 ? (
                <EmptyState
                  title="No transactions found"
                  description="Transactions posted across customer transfers, QR, bank rails, and teller adjustments will appear here."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500">
                        <th className="py-2 pr-3 font-medium">Reference &amp; Time</th>
                        <th className="py-2 pr-3 font-medium">From / To</th>
                        <th className="py-2 pr-3 font-medium">Details &amp; Rail</th>
                        <th className="py-2 pr-3 font-medium">Initiated By</th>
                        <th className="py-2 pr-3 font-medium">Status</th>
                        <th className="py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {bankTransactions.map((tx) => {
                        const fromLabel = tx.source_owner_name
                          ? `${tx.source_owner_name} (${tx.source_account_number})`
                          : tx.source_account_number || 'Bank Vault';
                        const toLabel = tx.destination_owner_name
                          ? `${tx.destination_owner_name} (${tx.destination_account_number})`
                          : tx.external_destination || tx.destination_account_number || 'Clearing';
                        return (
                          <tr key={tx.id}>
                            <td className="py-3 pr-3 whitespace-nowrap">
                              <p className="font-mono font-semibold text-slate-800">{tx.reference_code}</p>
                              <p className="text-slate-500">{formatDateTime(tx.created_at)}</p>
                            </td>
                            <td className="py-3 pr-3">
                              <p className="text-slate-700">From: {fromLabel}</p>
                              <p className="text-slate-700">To: {toLabel}</p>
                            </td>
                            <td className="py-3 pr-3">
                              <p className="font-medium text-slate-900">{tx.description}</p>
                              <p className="font-mono text-slate-500">
                                {tx.tx_type} · {tx.provider_name}
                              </p>
                            </td>
                            <td className="py-3 pr-3 whitespace-nowrap text-slate-600">
                              {tx.initiated_by_name || 'System'}
                              {tx.initiated_by_role ? ` (${tx.initiated_by_role})` : ''}
                            </td>
                            <td className="py-3 pr-3 whitespace-nowrap">
                              <TxStatusText status={tx.status} />
                            </td>
                            <td className="py-3 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                              {formatInr(tx.amount_paise)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {tab === 'tickets' && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <h2 className="text-lg font-bold text-slate-900">Customer Help Desk Queue</h2>
              {tickets.length === 0 ? (
                <EmptyState title="Queue is clear" description="No customer support tickets are currently open." />
              ) : (
                <div className="divide-y divide-slate-100">
                  {tickets.map((t) => (
                    <div key={t.id} className="py-4 space-y-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">{t.subject}</p>
                          <p className="text-xs text-slate-500">
                            {t.customer_name} · {t.customer_mobile} · {t.category} · {formatDateTime(t.created_at)}
                          </p>
                        </div>
                        <span className="text-xs font-mono text-slate-700">{t.status}</span>
                      </div>
                      <p className="text-xs text-slate-700">{t.message}</p>
                      {t.status !== 'resolved' ? (
                        <div className="flex flex-col sm:flex-row gap-2 pt-1">
                          <input
                            type="text"
                            value={resolutionNotes[t.id] || ''}
                            onChange={(e) => setResolutionNotes((prev) => ({ ...prev, [t.id]: e.target.value }))}
                            placeholder="Resolution note for customer..."
                            className="flex-1 px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                          />
                          <button
                            type="button"
                            onClick={() => void handleUpdateTicket(t.id, 'in_review')}
                            className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
                          >
                            Mark In Review
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleUpdateTicket(t.id, 'resolved')}
                            className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 whitespace-nowrap"
                          >
                            Resolve Ticket
                          </button>
                        </div>
                      ) : (
                        t.resolution_note && (
                          <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded p-2">
                            Resolved: {t.resolution_note}
                          </p>
                        )
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'notifications' && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">Manager Notices &amp; Alerts Inbox</h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Operational SMS, Email, and In-App announcements dispatched to your staff account.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadNotifications()}
                  className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Refresh
                </button>
              </div>
              {notifications.length === 0 ? (
                <EmptyState
                  title="No alerts yet"
                  description="Messages and emails sent by management will appear here."
                />
              ) : (
                <div className="divide-y divide-slate-100">
                  {notifications.map((n) => (
                    <div key={n.id} className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div>
                        <p className="text-sm text-slate-900">{n.message}</p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {n.channel.toUpperCase()} · {n.recipient_masked} · {n.provider}
                          {n.provider_message_id ? ` · ${n.provider_message_id}` : ''} · {formatDateTime(n.created_at)}
                        </p>
                        {n.error_message && <p className="text-xs text-red-700 mt-0.5">{n.error_message}</p>}
                      </div>
                      <span
                        className={`text-xs font-mono whitespace-nowrap ${
                          n.status === 'sent'
                            ? 'text-emerald-700 font-semibold'
                            : n.status === 'failed'
                              ? 'text-red-700'
                              : 'text-slate-600'
                        }`}
                      >
                        {n.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* Audited Teller Confirmation Modal */}
      {adjConfirmOpen && selectedCustomer && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl p-6 max-w-md w-full space-y-4">
            <div className="flex items-center gap-2 text-blue-700">
              <ShieldAlert className="w-5 h-5" />
              <h3 className="text-base font-bold text-slate-900">Confirm Audited Teller Adjustment</h3>
            </div>
            <div className="border-y border-slate-200 py-3 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-500">Customer</span>
                <span className="font-semibold text-slate-900">{selectedCustomer.fullName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Account</span>
                <span className="font-mono text-slate-900">{selectedCustomer.accountNumber}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Action</span>
                <span className="font-semibold uppercase text-slate-900">{adjAction}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Amount</span>
                <span className="font-mono font-bold text-sm text-slate-900 tabular-nums">
                  {formatInr(Math.round(Number(adjRupees) * 100))}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-slate-500 shrink-0">Audit Reason</span>
                <span className="text-slate-900 text-right">{adjReason}</span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={adjBusy}
                onClick={() => void handleExecuteAdjustment()}
                className="flex-1 py-2.5 px-4 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-60"
              >
                {adjBusy ? 'Committing Ledger Entry...' : 'Confirm & Commit'}
              </button>
              <button
                type="button"
                disabled={adjBusy}
                onClick={() => setAdjConfirmOpen(false)}
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
