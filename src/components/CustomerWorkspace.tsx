import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Bell,
  Copy,
  Download,
  Eye,
  EyeOff,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Mail,
  QrCode,
  Receipt,
  Send,
  ShieldCheck,
} from 'lucide-react';
import type { User as FirebaseUser } from 'firebase/auth';
import {
  ApiError,
  apiFetch,
  createIdempotencyKey,
  formatDateTime,
  formatInr,
  type AuthUser,
} from '../lib/api';
import {
  getGoogleAccessToken,
  googleSignIn,
  googleSignOut,
  initGoogleAuth,
} from '../lib/googleAuth';
import { GoogleSignInButton } from './GoogleSignInButton';
import { QrScannerPanel } from './QrScannerPanel';
import { EmptyState, TableSkeleton, TxStatusText } from './StatusIndicator';

type CustomerTab = 'overview' | 'send' | 'qr' | 'transactions' | 'notifications' | 'help';
type TransferMethod = 'internal' | 'mobile' | 'upi' | 'bank';

interface AccountSummary {
  id: string;
  accountNumber: string;
  accountNumberMasked: string;
  accountType: string;
  currency: string;
  upiHandle: string | null;
  status: string;
  balancePaise: number;
  dailyUsedPaise: number;
  dailyLimitPaise: number;
  perTxLimitPaise: number;
}

interface TransactionItem {
  id: string;
  referenceCode: string;
  txType: string;
  status: string;
  direction: 'credit' | 'debit';
  amountPaise: number;
  counterpartyName: string;
  counterpartyAccountMasked: string;
  providerName: string;
  description: string;
  failureReason: string | null;
  createdAt: string;
}

interface ReceiptDetail {
  transaction: {
    id: string;
    referenceCode: string;
    txType: string;
    status: string;
    amountPaise: number;
    sourceAccountMasked: string;
    sourceOwnerName: string;
    destinationAccountMasked: string;
    destinationOwnerName: string;
    providerName: string;
    providerTxRef: string | null;
    description: string;
    failureReason: string | null;
    createdAt: string;
    completedAt: string | null;
  };
  ledgerEntries: Array<{
    id: string;
    entryType: string;
    amountPaise: number;
    accountMasked: string;
    accountType: string;
  }>;
}

interface NotificationItem {
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

interface HelpTicket {
  id: string;
  category: string;
  subject: string;
  message: string;
  related_tx_ref: string | null;
  status: string;
  resolution_note: string | null;
  created_at: string;
}

export function CustomerWorkspace({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }) {
  const [tab, setTab] = useState<CustomerTab>('overview');
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [smsOptIn, setSmsOptIn] = useState(user.smsOptIn);
  const [emailOptIn, setEmailOptIn] = useState(user.emailOptIn);
  const [revealAcctNo, setRevealAcctNo] = useState(false);

  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [txStatusFilter, setTxStatusFilter] = useState<string>('all');
  const [txSearch, setTxSearch] = useState('');
  const [receipt, setReceipt] = useState<ReceiptDetail | null>(null);

  // Send Money state
  const [method, setMethod] = useState<TransferMethod>('internal');
  const [destAccountNumber, setDestAccountNumber] = useState('');
  const [upiHandle, setUpiHandle] = useState('');
  const [mobileInput, setMobileInput] = useState('');
  const [resolvedMobile, setResolvedMobile] = useState<{
    upiHandle: string;
    recipientName: string;
    provider: string;
  } | null>(null);
  const [beneficiaryName, setBeneficiaryName] = useState('');
  const [bankAccountNo, setBankAccountNo] = useState('');
  const [ifscCode, setIfscCode] = useState('');
  const [bankRail, setBankRail] = useState<'IMPS' | 'NEFT' | 'RTGS'>('NEFT');
  const [amountRupees, setAmountRupees] = useState('');
  const [transferDesc, setTransferDesc] = useState('');
  const [pendingIdempotencyKey, setPendingIdempotencyKey] = useState(() => createIdempotencyKey('tx'));
  const [confirmTransferOpen, setConfirmTransferOpen] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferSuccess, setTransferSuccess] = useState<{ ref: string; status: string; note?: string } | null>(null);

  // Receive QR state
  const [qrMode, setQrMode] = useState<'scan' | 'receive'>('scan');
  const [qrAmountRupees, setQrAmountRupees] = useState('');
  const [qrNote, setQrNote] = useState('');
  const [generatedQr, setGeneratedQr] = useState<{
    qrDataUrl: string;
    payloadString: string;
    expiresAt: string;
  } | null>(null);
  const [copiedPayload, setCopiedPayload] = useState(false);

  // Notifications, Google Workspace Gmail & Help state
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [googleUser, setGoogleUser] = useState<FirebaseUser | null>(null);
  const [googleToken, setGoogleToken] = useState<string | null>(() => getGoogleAccessToken());
  const [needsGoogleAuth, setNeedsGoogleAuth] = useState(() => !getGoogleAccessToken());
  const [googleAuthBusy, setGoogleAuthBusy] = useState(false);
  const [sendGmailWithTransfer, setSendGmailWithTransfer] = useState(true);
  const [gmailConfirmModal, setGmailConfirmModal] = useState<{
    transactionId?: string;
    referenceCode?: string;
    recipientEmail: string;
    subjectPreview: string;
  } | null>(null);
  const [gmailSendBusy, setGmailSendBusy] = useState(false);
  const [gmailFeedback, setGmailFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [tickets, setTickets] = useState<HelpTicket[]>([]);
  const [helpCategory, setHelpCategory] = useState('Transfer Inquiry');
  const [helpSubject, setHelpSubject] = useState('');
  const [helpMessage, setHelpMessage] = useState('');
  const [helpTxRef, setHelpTxRef] = useState('');
  const [helpStatusMsg, setHelpStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    const unsub = initGoogleAuth(
      (gUser, token) => {
        setGoogleUser(gUser);
        setGoogleToken(token);
        setNeedsGoogleAuth(false);
      },
      () => {
        setGoogleUser(null);
        setGoogleToken(null);
        setNeedsGoogleAuth(true);
      },
    );
    return () => unsub();
  }, []);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    try {
      const [acctRes, txRes, notifRes, ticketRes] = await Promise.all([
        apiFetch<{ customer: { smsOptIn: boolean; emailOptIn: boolean }; accounts: AccountSummary[] }>('/api/accounts/me'),
        apiFetch<{ transactions: TransactionItem[] }>('/api/transactions'),
        apiFetch<{ notifications: NotificationItem[] }>('/api/notifications'),
        apiFetch<{ tickets: HelpTicket[] }>('/api/help/tickets'),
      ]);
      setAccounts(acctRes.accounts);
      setSmsOptIn(acctRes.customer.smsOptIn);
      setEmailOptIn(acctRes.customer.emailOptIn);
      setTransactions(txRes.transactions);
      setNotifications(notifRes.notifications);
      setTickets(ticketRes.tickets);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await onLogout();
      }
    } finally {
      setLoading(false);
    }
  }, [onLogout]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  const primaryAccount = accounts[0];

  async function openReceipt(txId: string) {
    const detail = await apiFetch<ReceiptDetail>(`/api/transactions/${txId}`);
    setReceipt(detail);
  }

  async function handleResolveMobile() {
    setTransferError(null);
    setResolvedMobile(null);
    try {
      const res = await apiFetch<{ upiHandle: string; recipientName: string; provider: string }>(
        '/api/transfers/resolve-mobile',
        {
          method: 'POST',
          body: JSON.stringify({ mobile: mobileInput }),
        },
      );
      setResolvedMobile(res);
    } catch (err) {
      setTransferError(err instanceof ApiError ? err.message : 'Mobile number resolution failed.');
    }
  }

  function handlePreConfirmTransfer(e: FormEvent) {
    e.preventDefault();
    setTransferError(null);
    setTransferSuccess(null);
    const paise = Math.round(Number(amountRupees) * 100);
    if (!paise || paise <= 0) {
      setTransferError('Enter a valid positive amount in INR.');
      return;
    }
    if (method === 'mobile' && !resolvedMobile) {
      setTransferError('Please verify the mobile number through the payment provider first.');
      return;
    }
    setConfirmTransferOpen(true);
  }

  async function handleExecuteTransfer() {
    setTransferBusy(true);
    setTransferError(null);
    const amountPaise = Math.round(Number(amountRupees) * 100);
    try {
      let endpoint = '/api/transfers/internal';
      let body: Record<string, unknown> = {
        amountPaise,
        description: transferDesc,
        idempotencyKey: pendingIdempotencyKey,
      };

      if (method === 'internal') {
        endpoint = '/api/transfers/internal';
        body.destinationAccountNumber = destAccountNumber;
      } else if (method === 'mobile') {
        endpoint = '/api/transfers/upi';
        body.mobile = mobileInput;
      } else if (method === 'upi') {
        endpoint = '/api/transfers/upi';
        body.upiHandle = upiHandle;
      } else if (method === 'bank') {
        endpoint = '/api/transfers/bank';
        body = {
          ...body,
          beneficiaryName,
          accountNumber: bankAccountNo,
          ifscCode,
          rail: bankRail,
        };
      }

      const activeGmailToken = sendGmailWithTransfer ? getGoogleAccessToken() : null;
      if (activeGmailToken) {
        body.sendGmailReceipt = true;
      }

      const res = await apiFetch<{
        transaction: { reference_code: string; status: string };
        providerNote?: string;
      }>(endpoint, {
        method: 'POST',
        headers: activeGmailToken ? { 'X-Gmail-Access-Token': activeGmailToken } : undefined,
        body: JSON.stringify(body),
      });

      setTransferSuccess({
        ref: res.transaction.reference_code,
        status: res.transaction.status,
        note: res.providerNote,
      });
      setConfirmTransferOpen(false);
      setPendingIdempotencyKey(createIdempotencyKey('tx'));
      setAmountRupees('');
      setTransferDesc('');
      await loadWorkspace();
    } catch (err) {
      setConfirmTransferOpen(false);
      setTransferError(err instanceof ApiError ? err.message : 'Transfer could not be completed.');
    } finally {
      setTransferBusy(false);
    }
  }

  async function handleGenerateQr(e: FormEvent) {
    e.preventDefault();
    const amountPaise = qrAmountRupees ? Math.round(Number(qrAmountRupees) * 100) : null;
    const res = await apiFetch<{ qrDataUrl: string; payloadString: string; expiresAt: string }>('/api/qr/generate', {
      method: 'POST',
      body: JSON.stringify({ amountPaise, note: qrNote || null }),
    });
    setGeneratedQr(res);
    setCopiedPayload(false);
  }

  async function handleTogglePreferences(nextSms: boolean, nextEmail: boolean) {
    const res = await apiFetch<{ smsOptIn: boolean; emailOptIn: boolean }>('/api/accounts/me/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ smsOptIn: nextSms, emailOptIn: nextEmail }),
    });
    setSmsOptIn(res.smsOptIn);
    setEmailOptIn(res.emailOptIn);
  }

  async function handleConnectGoogle() {
    setGoogleAuthBusy(true);
    setGmailFeedback(null);
    try {
      const result = await googleSignIn();
      setGoogleUser(result.user);
      setGoogleToken(result.accessToken);
      setNeedsGoogleAuth(false);
      setGmailFeedback({
        kind: 'ok',
        text: `Connected Google account (${result.user.email || 'Gmail'}) for transaction receipt delivery.`,
      });
    } catch (err) {
      setGmailFeedback({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Unable to connect Google account.',
      });
    } finally {
      setGoogleAuthBusy(false);
    }
  }

  async function handleDisconnectGoogle() {
    await googleSignOut();
    setGoogleUser(null);
    setGoogleToken(null);
    setNeedsGoogleAuth(true);
    setGmailFeedback(null);
  }

  async function handleConfirmedGmailSend() {
    if (!gmailConfirmModal) return;
    const token = getGoogleAccessToken() || googleToken;
    if (!token) {
      setGmailConfirmModal(null);
      setNeedsGoogleAuth(true);
      setGmailFeedback({ kind: 'err', text: 'Sign in with Google first to send emails via Gmail.' });
      return;
    }
    setGmailSendBusy(true);
    setGmailFeedback(null);
    try {
      const res = await apiFetch<{ ok: boolean; notification: { providerMessageId?: string | null } }>(
        '/api/notifications/send-gmail',
        {
          method: 'POST',
          headers: { 'X-Gmail-Access-Token': token },
          body: JSON.stringify({
            transactionId: gmailConfirmModal.transactionId,
            recipientEmail: gmailConfirmModal.recipientEmail,
            confirmed: true,
          }),
        },
      );
      setGmailFeedback({
        kind: 'ok',
        text: `Email delivered to ${gmailConfirmModal.recipientEmail} via Gmail API${
          res.notification.providerMessageId ? ` (Message ID: ${res.notification.providerMessageId})` : ''
        }.`,
      });
      setGmailConfirmModal(null);
      await loadWorkspace();
    } catch (err) {
      setGmailConfirmModal(null);
      setGmailFeedback({
        kind: 'err',
        text: err instanceof ApiError ? err.message : 'Unable to send email through Gmail API.',
      });
    } finally {
      setGmailSendBusy(false);
    }
  }

  async function handleSubmitHelp(e: FormEvent) {
    e.preventDefault();
    setHelpStatusMsg(null);
    await apiFetch('/api/help/tickets', {
      method: 'POST',
      body: JSON.stringify({
        category: helpCategory,
        subject: helpSubject,
        message: helpMessage,
        relatedTxRef: helpTxRef || undefined,
      }),
    });
    setHelpSubject('');
    setHelpMessage('');
    setHelpTxRef('');
    setHelpStatusMsg('Your inquiry has been logged with Meridian Bank Support.');
    await loadWorkspace();
  }

  const filteredTx = transactions.filter((t) => {
    const matchesStatus = txStatusFilter === 'all' || t.status === txStatusFilter;
    const q = txSearch.trim().toLowerCase();
    const matchesQuery =
      !q ||
      t.referenceCode.toLowerCase().includes(q) ||
      t.counterpartyName.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q);
    return matchesStatus && matchesQuery;
  });

  const navItems: Array<{ id: CustomerTab; label: string; icon: typeof LayoutDashboard }> = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'send', label: 'Send Money', icon: Send },
    { id: 'qr', label: 'QR Pay & Receive', icon: QrCode },
    { id: 'transactions', label: 'Transactions', icon: Receipt },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'help', label: 'Bank Help', icon: HelpCircle },
  ];

  return (
    <div className="min-h-screen bg-[#F4F7F6] flex flex-col lg:flex-row">
      <aside className="w-full lg:w-64 bg-[#0A2E2A] text-emerald-100/90 flex flex-col shrink-0">
        <div className="px-6 py-5 border-b border-emerald-900/60">
          <p className="text-base font-bold text-white font-display whitespace-nowrap">Meridian Trust Bank</p>
          <p className="text-xs text-emerald-300 font-medium mt-0.5">Personal Banking</p>
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
                  active
                    ? 'bg-emerald-500/20 text-white'
                    : 'text-emerald-100/70 hover:bg-emerald-900/50 hover:text-white'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-emerald-300' : ''}`} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-emerald-900/60 hidden lg:block">
          <p className="text-xs font-semibold text-white truncate">{user.fullName}</p>
          <p className="text-xs text-emerald-300/80 font-mono truncate">{user.mobile || user.username}</p>
          <button
            type="button"
            onClick={() => void onLogout()}
            className="mt-3 w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-emerald-100 border border-emerald-800 rounded-lg hover:bg-emerald-900/60 whitespace-nowrap"
          >
            <LogOut className="w-3.5 h-3.5" />
            Log Out
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white border-b border-slate-200 px-6 lg:px-8 py-4 flex items-center justify-between gap-8">
          <div className="text-sm text-slate-500 truncate">
            <span>Personal Banking</span>
            <span className="mx-2">/</span>
            <span className="font-semibold text-slate-900">
              {navItems.find((n) => n.id === tab)?.label}
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setTab('send')}
              className="px-4 py-2 text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0"
            >
              Send Money
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
          {loading ? (
            <TableSkeleton rows={5} />
          ) : (
            <>
              {tab === 'overview' && primaryAccount && (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-5 items-stretch">
                    <div className="md:col-span-2 bg-gradient-to-br from-[#0D3B35] to-[#082622] text-white rounded-xl p-6 flex flex-col justify-between space-y-6">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-xs text-emerald-200/90 font-medium">
                            Available Balance · {primaryAccount.accountType.toUpperCase()} Account
                          </p>
                          <p className="text-3xl sm:text-4xl font-bold font-mono tabular-nums text-white mt-1.5">
                            {formatInr(primaryAccount.balancePaise)}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setRevealAcctNo((v) => !v)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-100 border border-emerald-700/80 bg-emerald-900/40 rounded-lg hover:bg-emerald-800/60 whitespace-nowrap shrink-0"
                        >
                          {revealAcctNo ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          {revealAcctNo ? 'Mask Account' : 'Show Account'}
                        </button>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-emerald-800/70 text-xs">
                        <div>
                          <p className="text-emerald-300/80">Account Holder</p>
                          <p className="font-semibold text-white mt-0.5">{user.fullName}</p>
                        </div>
                        <div>
                          <p className="text-emerald-300/80">Account Number</p>
                          <p className="font-mono font-medium text-white mt-0.5">
                            {revealAcctNo ? primaryAccount.accountNumber : primaryAccount.accountNumberMasked}
                          </p>
                        </div>
                        <div>
                          <p className="text-emerald-300/80">UPI Handle</p>
                          <p className="font-mono font-medium text-emerald-100 mt-0.5">{primaryAccount.upiHandle || 'Not set'}</p>
                        </div>
                        <div>
                          <p className="text-emerald-300/80">Registered Mobile</p>
                          <p className="font-mono font-medium text-emerald-100 mt-0.5">{user.mobile || '—'}</p>
                        </div>
                      </div>
                    </div>

                    <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between space-y-4">
                      <div className="space-y-3">
                        <p className="text-xs font-semibold text-slate-900">Daily Transfer Limit</p>
                        <div>
                          <div className="flex justify-between text-xs font-mono tabular-nums text-slate-600 mb-1.5">
                            <span>Used: {formatInr(primaryAccount.dailyUsedPaise)}</span>
                            <span>Max: {formatInr(primaryAccount.dailyLimitPaise)}</span>
                          </div>
                          <div className="h-2.5 bg-emerald-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-emerald-700"
                              style={{
                                width: `${Math.min(100, Math.round((primaryAccount.dailyUsedPaise / primaryAccount.dailyLimitPaise) * 100))}%`,
                              }}
                            />
                          </div>
                        </div>
                        <p className="text-xs text-slate-500">
                          Per-tx cap: <span className="font-mono text-slate-800">{formatInr(primaryAccount.perTxLimitPaise)}</span> · KYC: {user.kycStatus}
                        </p>
                      </div>
                      <div className="flex gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => setTab('qr')}
                          className="flex-1 py-2.5 px-3 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 whitespace-nowrap"
                        >
                          Scan / Receive QR
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="bg-white border border-slate-200 rounded-xl p-6">
                    <div className="flex items-center justify-between gap-4 mb-4">
                      <h2 className="text-base font-bold text-slate-900">Recent Transactions</h2>
                      <button
                        type="button"
                        onClick={() => setTab('transactions')}
                        className="text-xs font-medium text-emerald-700 hover:text-emerald-800 whitespace-nowrap"
                      >
                        View All History
                      </button>
                    </div>
                    {transactions.length === 0 ? (
                      <EmptyState
                        title="No transactions recorded yet"
                        description="Your transfers, QR payments, and teller credits will appear here with double-entry receipts."
                        actionLabel="Send Money"
                        onAction={() => setTab('send')}
                      />
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                          <thead>
                            <tr className="border-b border-slate-200 text-xs text-slate-500">
                              <th className="py-2.5 pr-4 font-medium">Reference</th>
                              <th className="py-2.5 pr-4 font-medium">Counterparty &amp; Note</th>
                              <th className="py-2.5 pr-4 font-medium">Status</th>
                              <th className="py-2.5 pr-4 font-medium">Date</th>
                              <th className="py-2.5 text-right font-medium">Amount</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 text-sm">
                            {transactions.slice(0, 6).map((t) => (
                              <tr
                                key={t.id}
                                onClick={() => void openReceipt(t.id)}
                                className="hover:bg-slate-50 cursor-pointer transition-colors"
                              >
                                <td className="py-3 pr-4 font-mono text-xs text-slate-700 whitespace-nowrap">{t.referenceCode}</td>
                                <td className="py-3 pr-4">
                                  <p className="font-medium text-slate-900">{t.counterpartyName}</p>
                                  <p className="text-xs text-slate-500">{t.description}</p>
                                </td>
                                <td className="py-3 pr-4">
                                  <TxStatusText status={t.status} />
                                </td>
                                <td className="py-3 pr-4 text-xs text-slate-500 whitespace-nowrap">{formatDateTime(t.createdAt)}</td>
                                <td
                                  className={`py-3 text-right font-mono tabular-nums font-semibold whitespace-nowrap ${
                                    t.direction === 'credit' ? 'text-emerald-700' : 'text-slate-900'
                                  }`}
                                >
                                  <span className="inline-flex items-center gap-1 justify-end">
                                    {t.direction === 'credit' ? <ArrowDownLeft className="w-3.5 h-3.5" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
                                    {t.direction === 'credit' ? '+' : '-'}
                                    {formatInr(t.amountPaise)}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {tab === 'send' && (
                <div className="bg-white border border-slate-200 rounded-xl p-6 max-w-2xl space-y-6">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Send Money</h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Every transfer uses an idempotency key and atomic double-entry ledger commit.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-1 p-1 bg-slate-100 rounded-lg">
                    {(
                      [
                        { id: 'internal', label: 'Internal Account' },
                        { id: 'mobile', label: 'Mobile Number' },
                        { id: 'upi', label: 'UPI ID' },
                        { id: 'bank', label: 'Bank Account' },
                      ] as const
                    ).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          setMethod(m.id);
                          setTransferError(null);
                          setTransferSuccess(null);
                          setResolvedMobile(null);
                        }}
                        className={`flex-1 py-2 px-3 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                          method === m.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>

                  {transferError && (
                    <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                      {transferError}
                    </div>
                  )}

                  {transferSuccess && (
                    <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 space-y-1">
                      <p className="text-sm font-semibold text-emerald-900">
                        Transfer Submitted · Status: {transferSuccess.status.toUpperCase()}
                      </p>
                      <p className="text-xs text-emerald-800">
                        Reference: <span className="font-mono font-semibold">{transferSuccess.ref}</span>
                      </p>
                      {transferSuccess.note && <p className="text-xs text-emerald-700">{transferSuccess.note}</p>}
                    </div>
                  )}

                  <form onSubmit={handlePreConfirmTransfer} className="space-y-4">
                    {method === 'internal' && (
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1.5">
                          Recipient Meridian Account Number
                        </label>
                        <input
                          type="text"
                          required
                          value={destAccountNumber}
                          onChange={(e) => setDestAccountNumber(e.target.value)}
                          placeholder="e.g. MTB00100002"
                          className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-700"
                        />
                      </div>
                    )}

                    {method === 'mobile' && (
                      <div className="space-y-3">
                        <label className="block text-xs font-medium text-slate-700">
                          Recipient Mobile Number (Resolved via Payment Provider)
                        </label>
                        <div className="flex gap-2">
                          <input
                            type="tel"
                            required
                            value={mobileInput}
                            onChange={(e) => {
                              setMobileInput(e.target.value);
                              setResolvedMobile(null);
                            }}
                            placeholder="e.g. +919800001002"
                            className="flex-1 px-3.5 py-2.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-700"
                          />
                          <button
                            type="button"
                            onClick={() => void handleResolveMobile()}
                            className="px-4 py-2.5 text-xs font-medium text-slate-800 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 whitespace-nowrap shrink-0"
                          >
                            Verify via Provider
                          </button>
                        </div>
                        {resolvedMobile && (
                          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
                            Verified Recipient: <span className="font-semibold">{resolvedMobile.recipientName}</span> · UPI Handle:{' '}
                            <span className="font-mono">{resolvedMobile.upiHandle}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {method === 'upi' && (
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1.5">Recipient UPI ID</label>
                        <input
                          type="text"
                          required
                          value={upiHandle}
                          onChange={(e) => setUpiHandle(e.target.value)}
                          placeholder="e.g. meera@meridian"
                          className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-700"
                        />
                      </div>
                    )}

                    {method === 'bank' && (
                      <div className="space-y-4">
                        <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600">
                          Bank transfers route through our configured clearing adapter in sandbox mode (pending settlement confirmation). This application never collects online-banking passwords, PINs, or OTPs.
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">Beneficiary Name</label>
                            <input
                              type="text"
                              required
                              value={beneficiaryName}
                              onChange={(e) => setBeneficiaryName(e.target.value)}
                              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">Clearing Rail</label>
                            <select
                              value={bankRail}
                              onChange={(e) => setBankRail(e.target.value as 'IMPS' | 'NEFT' | 'RTGS')}
                              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                            >
                              <option value="NEFT">NEFT</option>
                              <option value="IMPS">IMPS</option>
                              <option value="RTGS">RTGS</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">Account Number</label>
                            <input
                              type="text"
                              required
                              value={bankAccountNo}
                              onChange={(e) => setBankAccountNo(e.target.value)}
                              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">IFSC Code</label>
                            <input
                              type="text"
                              required
                              value={ifscCode}
                              onChange={(e) => setIfscCode(e.target.value)}
                              placeholder="HDFC0001234"
                              className="w-full px-3 py-2 text-sm font-mono uppercase border border-slate-300 rounded-lg"
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1.5">Amount (INR)</label>
                        <input
                          type="number"
                          min="1"
                          step="0.01"
                          required
                          value={amountRupees}
                          onChange={(e) => setAmountRupees(e.target.value)}
                          placeholder="500.00"
                          className="w-full px-3.5 py-2.5 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-700"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1.5">Payment Note</label>
                        <input
                          type="text"
                          value={transferDesc}
                          onChange={(e) => setTransferDesc(e.target.value)}
                          placeholder="Optional reference note"
                          className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-700"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      className="px-5 py-2.5 text-sm font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 transition-colors"
                    >
                      Review Transfer
                    </button>
                  </form>
                </div>
              )}

              {tab === 'qr' && (
                <div className="bg-white border border-slate-200 rounded-xl p-6 max-w-3xl space-y-6">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h2 className="text-lg font-bold text-slate-900">QR Payments</h2>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Cryptographically signed QR codes verified before authorization.
                      </p>
                    </div>
                    <div className="flex gap-1 p-1 bg-slate-100 rounded-lg">
                      <button
                        type="button"
                        onClick={() => setQrMode('scan')}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                          qrMode === 'scan' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                        }`}
                      >
                        Scan to Pay
                      </button>
                      <button
                        type="button"
                        onClick={() => setQrMode('receive')}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                          qrMode === 'receive' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                        }`}
                      >
                        Generate Receive QR
                      </button>
                    </div>
                  </div>

                  {qrMode === 'scan' ? (
                    <QrScannerPanel onPaymentComplete={() => void loadWorkspace()} />
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
                      <form onSubmit={handleGenerateQr} className="space-y-4">
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1.5">
                            Fixed Amount in INR (Optional)
                          </label>
                          <input
                            type="number"
                            min="1"
                            step="0.01"
                            value={qrAmountRupees}
                            onChange={(e) => setQrAmountRupees(e.target.value)}
                            placeholder="Leave blank for open amount"
                            className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-300 rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1.5">Note (Optional)</label>
                          <input
                            type="text"
                            value={qrNote}
                            onChange={(e) => setQrNote(e.target.value)}
                            placeholder="e.g. Consulting invoice #204"
                            className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg"
                          />
                        </div>
                        <button
                          type="submit"
                          className="px-5 py-2.5 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 transition-colors"
                        >
                          Generate Signed Receive QR
                        </button>
                      </form>

                      <div className="border border-slate-200 rounded-xl p-5 bg-slate-50 text-center space-y-3">
                        {generatedQr ? (
                          <>
                            <img
                              src={generatedQr.qrDataUrl}
                              alt="Meridian Trust Bank Receive QR Code"
                              className="w-48 h-48 mx-auto rounded-lg border border-slate-200 bg-white p-2"
                            />
                            <p className="text-xs text-slate-600">
                              Valid until {formatDateTime(generatedQr.expiresAt)}
                            </p>
                            <div className="flex items-center justify-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  void navigator.clipboard?.writeText(generatedQr.payloadString);
                                  setCopiedPayload(true);
                                }}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 whitespace-nowrap"
                              >
                                <Copy className="w-3.5 h-3.5" />
                                {copiedPayload ? 'Copied Token' : 'Copy Payload'}
                              </button>
                              <a
                                href={generatedQr.qrDataUrl}
                                download="meridian-receive-qr.png"
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap"
                              >
                                <Download className="w-3.5 h-3.5" />
                                Save PNG
                              </a>
                            </div>
                          </>
                        ) : (
                          <p className="text-xs text-slate-500 py-12">
                            Generate a signed QR code to share with another Meridian customer.
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {tab === 'transactions' && (
                <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <h2 className="text-lg font-bold text-slate-900">Transaction History &amp; Receipts</h2>
                    <div className="flex flex-wrap items-center gap-3">
                      <input
                        type="search"
                        value={txSearch}
                        onChange={(e) => setTxSearch(e.target.value)}
                        placeholder="Search ref or recipient..."
                        className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg w-48"
                      />
                      <div className="flex gap-1 p-1 bg-slate-100 rounded-lg">
                        {['all', 'success', 'pending', 'failed', 'reversed'].map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setTxStatusFilter(s)}
                            className={`px-2.5 py-1 text-xs font-medium rounded capitalize whitespace-nowrap ${
                              txStatusFilter === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                            }`}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {filteredTx.length === 0 ? (
                    <EmptyState
                      title="No matching transactions"
                      description="Adjust your status filter or search query, or initiate a new transfer."
                    />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-slate-200 text-xs text-slate-500">
                            <th className="py-2.5 pr-4 font-medium">Reference</th>
                            <th className="py-2.5 pr-4 font-medium">Type</th>
                            <th className="py-2.5 pr-4 font-medium">Counterparty &amp; Details</th>
                            <th className="py-2.5 pr-4 font-medium">Status</th>
                            <th className="py-2.5 pr-4 font-medium">Timestamp</th>
                            <th className="py-2.5 text-right font-medium">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-sm">
                          {filteredTx.map((t) => (
                            <tr
                              key={t.id}
                              onClick={() => void openReceipt(t.id)}
                              className="hover:bg-slate-50 cursor-pointer transition-colors"
                            >
                              <td className="py-3 pr-4 font-mono text-xs text-slate-700 whitespace-nowrap">{t.referenceCode}</td>
                              <td className="py-3 pr-4 text-xs text-slate-600 whitespace-nowrap">{t.txType.replace('_', ' ')}</td>
                              <td className="py-3 pr-4">
                                <p className="font-medium text-slate-900">{t.counterpartyName}</p>
                                <p className="text-xs text-slate-500">{t.description}</p>
                              </td>
                              <td className="py-3 pr-4">
                                <TxStatusText status={t.status} />
                              </td>
                              <td className="py-3 pr-4 text-xs text-slate-500 whitespace-nowrap">{formatDateTime(t.createdAt)}</td>
                              <td
                                className={`py-3 text-right font-mono tabular-nums font-semibold whitespace-nowrap ${
                                  t.direction === 'credit' ? 'text-emerald-700' : 'text-slate-900'
                                }`}
                              >
                                {t.direction === 'credit' ? '+' : '-'}
                                {formatInr(t.amountPaise)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {tab === 'notifications' && (
                <div className="space-y-6">
                  <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
                    <div>
                      <h2 className="text-lg font-bold text-slate-900">Mobile SMS &amp; Gmail Transaction Alerts</h2>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Transaction alerts dispatch automatically to your registered mobile ({user.mobile || 'not set'}) and email ({user.email || 'not set'}). Notification delivery failures never alter settled ledger balances.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-6 pt-1">
                      <label className="inline-flex items-center gap-2.5 text-sm text-slate-800 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={smsOptIn}
                          onChange={(e) => void handleTogglePreferences(e.target.checked, emailOptIn)}
                          className="w-4 h-4 accent-emerald-700"
                        />
                        <span>Receive Transaction SMS Alerts</span>
                      </label>
                      <label className="inline-flex items-center gap-2.5 text-sm text-slate-800 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={emailOptIn}
                          onChange={(e) => void handleTogglePreferences(smsOptIn, e.target.checked)}
                          className="w-4 h-4 accent-emerald-700"
                        />
                        <span>Receive Gmail / Email Transaction Alerts</span>
                      </label>
                    </div>

                    <div className="border-t border-slate-200 pt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">Direct Gmail Receipt Delivery</p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {needsGoogleAuth || !googleToken
                            ? 'Connect your Google account to send transaction receipts directly via Gmail with your confirmation.'
                            : `Connected as ${googleUser?.email || user.email || 'Google Account'}`}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                        {needsGoogleAuth || !googleToken ? (
                          <GoogleSignInButton
                            onClick={() => void handleConnectGoogle()}
                            disabled={googleAuthBusy}
                            label={googleAuthBusy ? 'Connecting...' : 'Sign in with Google'}
                          />
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                setGmailConfirmModal({
                                  recipientEmail: user.email || googleUser?.email || '',
                                  subjectPreview: 'Meridian Trust Bank — Transaction Alert Test',
                                })
                              }
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 whitespace-nowrap"
                            >
                              <Mail className="w-3.5 h-3.5" />
                              Send Test Gmail Alert
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDisconnectGoogle()}
                              className="px-3 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
                            >
                              Disconnect Google
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {gmailFeedback && (
                      <div
                        role={gmailFeedback.kind === 'err' ? 'alert' : 'status'}
                        className={`p-3 rounded-lg border text-xs ${
                          gmailFeedback.kind === 'ok'
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                            : 'bg-red-50 border-red-200 text-red-800'
                        }`}
                      >
                        {gmailFeedback.text}
                      </div>
                    )}
                  </div>

                  <div className="bg-white border border-slate-200 rounded-xl p-6">
                    <h3 className="text-base font-bold text-slate-900 mb-4">SMS &amp; Email Dispatch Log</h3>
                    {notifications.length === 0 ? (
                      <EmptyState title="No alerts yet" description="SMS and Gmail alerts will appear here when transactions occur." />
                    ) : (
                      <div className="divide-y divide-slate-100">
                        {notifications.map((n) => (
                          <div key={n.id} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
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
                </div>
              )}

              {tab === 'help' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                  <form onSubmit={handleSubmitHelp} className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                    <div>
                      <h2 className="text-lg font-bold text-slate-900">Contact Bank Support</h2>
                      <p className="text-xs text-slate-500 mt-0.5">Submit a support request or transaction dispute.</p>
                    </div>
                    {helpStatusMsg && (
                      <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
                        {helpStatusMsg}
                      </div>
                    )}
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Category</label>
                      <select
                        value={helpCategory}
                        onChange={(e) => setHelpCategory(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                      >
                        <option>Transfer Inquiry</option>
                        <option>Dispute / Reversal Request</option>
                        <option>Account &amp; KYC</option>
                        <option>Security Concern</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Related Transaction Ref (Optional)</label>
                      <input
                        type="text"
                        value={helpTxRef}
                        onChange={(e) => setHelpTxRef(e.target.value)}
                        placeholder="e.g. TXN-20261114-..."
                        className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Subject</label>
                      <input
                        type="text"
                        required
                        minLength={3}
                        value={helpSubject}
                        onChange={(e) => setHelpSubject(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Message</label>
                      <textarea
                        required
                        minLength={8}
                        rows={4}
                        value={helpMessage}
                        onChange={(e) => setHelpMessage(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                      />
                    </div>
                    <button
                      type="submit"
                      className="w-full py-2.5 px-4 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800"
                    >
                      Submit Support Ticket
                    </button>
                  </form>

                  <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                    <h3 className="text-base font-bold text-slate-900">Your Support Tickets</h3>
                    {tickets.length === 0 ? (
                      <EmptyState title="No support tickets" description="Any inquiries you submit will appear here with staff updates." />
                    ) : (
                      <div className="divide-y divide-slate-100">
                        {tickets.map((t) => (
                          <div key={t.id} className="py-3.5 space-y-1">
                            <div className="flex items-center justify-between gap-4">
                              <p className="text-sm font-semibold text-slate-900">{t.subject}</p>
                              <span className="text-xs font-mono text-slate-600">{t.status}</span>
                            </div>
                            <p className="text-xs text-slate-500">
                              {t.category} · {formatDateTime(t.created_at)}
                              {t.related_tx_ref ? ` · Ref: ${t.related_tx_ref}` : ''}
                            </p>
                            <p className="text-xs text-slate-700 pt-1">{t.message}</p>
                            {t.resolution_note && (
                              <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded p-2 mt-2">
                                Bank Response: {t.resolution_note}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {/* Transfer Confirmation Modal */}
      {confirmTransferOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl p-6 max-w-md w-full space-y-4">
            <div className="flex items-center gap-2 text-emerald-700">
              <ShieldCheck className="w-5 h-5" />
              <h3 className="text-base font-bold text-slate-900">Confirm Payment Authorization</h3>
            </div>
            <div className="border-y border-slate-200 py-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Method</span>
                <span className="font-medium text-slate-900 uppercase">{method}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Recipient</span>
                <span className="font-mono text-slate-900">
                  {method === 'internal' && destAccountNumber}
                  {method === 'mobile' && `${resolvedMobile?.recipientName} (${resolvedMobile?.upiHandle})`}
                  {method === 'upi' && upiHandle}
                  {method === 'bank' && `${beneficiaryName} (${ifscCode.toUpperCase()})`}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Amount</span>
                <span className="font-mono font-bold text-slate-900 tabular-nums">
                  {formatInr(Math.round(Number(amountRupees) * 100))}
                </span>
              </div>
            </div>
            {googleToken && user.email && (
              <label className="flex items-start gap-2.5 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sendGmailWithTransfer}
                  onChange={(e) => setSendGmailWithTransfer(e.target.checked)}
                  className="w-4 h-4 mt-0.5 accent-emerald-700"
                />
                <span>
                  Also send confirmation email to <span className="font-mono">{user.email}</span> via connected Gmail ({googleUser?.email || 'Google'})
                </span>
              </label>
            )}
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={transferBusy}
                onClick={() => void handleExecuteTransfer()}
                className="flex-1 py-2.5 px-4 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-60"
              >
                {transferBusy ? 'Processing...' : 'Authorize & Send'}
              </button>
              <button
                type="button"
                disabled={transferBusy}
                onClick={() => setConfirmTransferOpen(false)}
                className="py-2.5 px-4 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transaction Receipt Modal */}
      {receipt && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl p-6 max-w-lg w-full space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs text-slate-500">Official Transaction Receipt</p>
                <h3 className="text-lg font-bold font-mono text-slate-900">{receipt.transaction.referenceCode}</h3>
              </div>
              <TxStatusText status={receipt.transaction.status} />
            </div>

            <div className="border-y border-slate-200 py-3 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-500">Amount</span>
                <span className="font-mono font-bold text-sm text-slate-900 tabular-nums">
                  {formatInr(receipt.transaction.amountPaise)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">From</span>
                <span className="text-slate-900">
                  {receipt.transaction.sourceOwnerName} ({receipt.transaction.sourceAccountMasked})
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">To</span>
                <span className="text-slate-900">
                  {receipt.transaction.destinationOwnerName} ({receipt.transaction.destinationAccountMasked})
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Provider Rail</span>
                <span className="font-mono text-slate-900">{receipt.transaction.providerName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Created</span>
                <span className="text-slate-900">{formatDateTime(receipt.transaction.createdAt)}</span>
              </div>
              {receipt.transaction.failureReason && (
                <div className="p-2 rounded bg-red-50 border border-red-200 text-red-800">
                  {receipt.transaction.failureReason}
                </div>
              )}
            </div>

            <div>
              <p className="text-xs font-semibold text-slate-900 mb-2">Double-Entry Ledger Postings</p>
              {receipt.ledgerEntries.length === 0 ? (
                <p className="text-xs text-slate-500">No funds moved (declined prior to ledger posting).</p>
              ) : (
                <div className="space-y-1.5">
                  {receipt.ledgerEntries.map((le) => (
                    <div key={le.id} className="flex items-center justify-between text-xs font-mono bg-slate-50 px-3 py-2 rounded">
                      <span className="uppercase font-semibold text-slate-700">{le.entryType}</span>
                      <span className="text-slate-600">{le.accountMasked}</span>
                      <span className="tabular-nums text-slate-900">{formatInr(le.amountPaise)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              {googleToken ? (
                <button
                  type="button"
                  onClick={() => {
                    const targetEmail = user.email || googleUser?.email || '';
                    if (!targetEmail) return;
                    setGmailConfirmModal({
                      transactionId: receipt.transaction.id,
                      referenceCode: receipt.transaction.referenceCode,
                      recipientEmail: targetEmail,
                      subjectPreview: `Meridian Trust Bank Receipt: ${receipt.transaction.referenceCode}`,
                    });
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 whitespace-nowrap"
                >
                  <Mail className="w-3.5 h-3.5" />
                  Email Receipt via Gmail
                </button>
              ) : (
                <GoogleSignInButton
                  onClick={() => void handleConnectGoogle()}
                  disabled={googleAuthBusy}
                  label={googleAuthBusy ? 'Connecting...' : 'Sign in with Google to Email Receipt'}
                />
              )}
              <button
                type="button"
                onClick={() => setReceipt(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Close Receipt
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Explicit Confirmation Modal for Sending Email via Gmail API */}
      {gmailConfirmModal && (
        <div className="fixed inset-0 z-[60] bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl p-6 max-w-md w-full space-y-4">
            <div className="flex items-center gap-2 text-emerald-700">
              <Mail className="w-5 h-5" />
              <h3 className="text-base font-bold text-slate-900">Confirm Sending Email via Gmail</h3>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              This will send a message from your connected Google account (<span className="font-mono">{googleUser?.email || 'Gmail'}</span>) through the Gmail API.
            </p>
            <div className="border-y border-slate-200 py-3 space-y-2 text-xs">
              <div className="flex justify-between gap-4">
                <span className="text-slate-500">Recipient</span>
                <span className="font-mono text-slate-900">{gmailConfirmModal.recipientEmail}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-slate-500">Subject</span>
                <span className="text-slate-900 text-right">{gmailConfirmModal.subjectPreview}</span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={gmailSendBusy}
                onClick={() => void handleConfirmedGmailSend()}
                className="flex-1 py-2.5 px-4 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-60"
              >
                {gmailSendBusy ? 'Sending Email...' : 'Confirm & Send Email'}
              </button>
              <button
                type="button"
                disabled={gmailSendBusy}
                onClick={() => setGmailConfirmModal(null)}
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
