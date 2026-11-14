import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Building2, Eye, EyeOff, KeyRound, ShieldCheck, UserCheck, Users } from 'lucide-react';
import { ApiError, apiFetch, setAccessToken, setCsrfToken, type AuthUser, type UserRole } from '../lib/api';

interface AuthPortalProps {
  devSeedEnabled: boolean;
  mustChangeUser: AuthUser | null;
  onAuthenticated: (user: AuthUser) => void;
  onLogout: () => Promise<void>;
}

type AuthView = 'login' | 'recover' | 'invite';

function getInitialRoleFromPath(): UserRole {
  if (typeof window === 'undefined') return 'user';
  const p = window.location.pathname.toLowerCase();
  if (p.includes('/employee')) return 'employee';
  if (p.includes('/manager')) return 'manager';
  return 'user';
}

const PORTAL_THEMES: Record<
  UserRole,
  {
    label: string;
    title: string;
    subtitle: string;
    backdrop: string;
    badgeBg: string;
    buttonBg: string;
    ring: string;
    linkColor: string;
    icon: typeof Users;
  }
> = {
  user: {
    label: 'User Login',
    title: 'Customer Sign In',
    subtitle: 'Personal accounts, UPI, QR & transfers',
    backdrop: 'bg-[radial-gradient(ellipse_at_top,#134E4A_0%,#0B2523_55%,#071618_100%)]',
    badgeBg: 'bg-emerald-500/15 border-emerald-400/25 text-emerald-300',
    buttonBg: 'bg-emerald-700 hover:bg-emerald-800',
    ring: 'focus:ring-emerald-600 focus:border-emerald-600',
    linkColor: 'text-emerald-700 hover:text-emerald-800',
    icon: Users,
  },
  employee: {
    label: 'Employee Login',
    title: 'Employee Teller Sign In',
    subtitle: 'Customer lookup, Aadhaar KYC & teller operations',
    backdrop: 'bg-[radial-gradient(ellipse_at_top,#1E3A8A_0%,#0F2547_55%,#09152B_100%)]',
    badgeBg: 'bg-blue-500/15 border-blue-400/25 text-blue-200',
    buttonBg: 'bg-blue-700 hover:bg-blue-800',
    ring: 'focus:ring-blue-600 focus:border-blue-600',
    linkColor: 'text-blue-700 hover:text-blue-800',
    icon: UserCheck,
  },
  manager: {
    label: 'Manager Login',
    title: 'Manager Governance Sign In',
    subtitle: 'Branch oversight, staff credentials & audit ledger',
    backdrop: 'bg-[radial-gradient(ellipse_at_top,#334155_0%,#111827_55%,#090D16_100%)]',
    badgeBg: 'bg-amber-500/15 border-amber-400/30 text-amber-300',
    buttonBg: 'bg-slate-900 hover:bg-slate-800',
    ring: 'focus:ring-slate-700 focus:border-slate-700',
    linkColor: 'text-slate-800 hover:text-slate-950',
    icon: Building2,
  },
};

export function AuthPortal({ mustChangeUser, onAuthenticated, onLogout }: AuthPortalProps) {
  const [portalRole, setPortalRole] = useState<UserRole>(getInitialRoleFromPath);
  const [view, setView] = useState<AuthView>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  // Forced password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');

  // Recovery state
  const [recoverIdentifier, setRecoverIdentifier] = useState('');
  const [recoverToken, setRecoverToken] = useState('');
  const [recoverNewPassword, setRecoverNewPassword] = useState('');
  const [recoverStep, setRecoverStep] = useState<'request' | 'confirm'>('request');

  // Employee invite acceptance state
  const [inviteToken, setInviteToken] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [mobileCode, setMobileCode] = useState('');
  const [inviteUsername, setInviteUsername] = useState('');
  const [invitePassword, setInvitePassword] = useState('');

  useEffect(() => {
    const onPopState = () => setPortalRole(getInitialRoleFromPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function switchPortal(role: UserRole) {
    setPortalRole(role);
    setView('login');
    setError(null);
    setInfoMessage(null);
    if (typeof window !== 'undefined') {
      const targetPath = `/login/${role}`;
      if (window.location.pathname !== targetPath) {
        window.history.replaceState(null, '', targetPath);
      }
    }
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ user: AuthUser; csrfToken: string; accessToken?: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, expectedRole: portalRole }),
      });
      setCsrfToken(res.csrfToken);
      if (res.accessToken) setAccessToken(res.accessToken);
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in.');
    } finally {
      setLoading(false);
    }
  }

  async function handleForcedPasswordChange(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmNewPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    setLoading(true);
    try {
      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const me = await apiFetch<{ user: AuthUser; csrfToken: string }>('/api/auth/me');
      setCsrfToken(me.csrfToken);
      onAuthenticated(me.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update password.');
    } finally {
      setLoading(false);
    }
  }

  async function handleRecoveryRequest(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      const res = await apiFetch<{
        ok: boolean;
        message: string;
        sandboxPreview?: { recoveryToken: string; maskedMobile: string };
      }>('/api/auth/recover/request', {
        method: 'POST',
        body: JSON.stringify({ usernameOrEmail: recoverIdentifier }),
      });
      setInfoMessage(
        res.sandboxPreview
          ? `${res.message} Sandbox token for ${res.sandboxPreview.maskedMobile}: ${res.sandboxPreview.recoveryToken}`
          : res.message,
      );
      if (res.sandboxPreview?.recoveryToken) {
        setRecoverToken(res.sandboxPreview.recoveryToken);
      }
      setRecoverStep('confirm');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Recovery request failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleRecoveryConfirm(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ message: string }>('/api/auth/recover/confirm', {
        method: 'POST',
        body: JSON.stringify({ token: recoverToken, newPassword: recoverNewPassword }),
      });
      setInfoMessage(res.message);
      setRecoverStep('request');
      setView('login');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to reset password.');
    } finally {
      setLoading(false);
    }
  }

  async function handleAcceptInvite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ message: string; username: string }>('/api/auth/accept-invite', {
        method: 'POST',
        body: JSON.stringify({
          inviteToken,
          emailCode,
          mobileCode,
          username: inviteUsername,
          password: invitePassword,
        }),
      });
      setInfoMessage(res.message);
      setUsername(res.username);
      switchPortal('employee');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invite verification failed.');
    } finally {
      setLoading(false);
    }
  }

  if (mustChangeUser) {
    return (
      <div className="min-h-screen bg-[#0B2220] flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-white border border-emerald-900/10 rounded-2xl p-8 shadow-xl">
          <div className="flex items-center justify-between mb-6">
            <div>
              <p className="text-xs font-semibold text-amber-700">Security Policy Action Required</p>
              <h1 className="text-xl font-bold text-slate-900 mt-1">Change Initial Password</h1>
            </div>
            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
              <KeyRound className="w-5 h-5 text-amber-700" />
            </div>
          </div>
          <p className="text-sm text-slate-600 mb-6">
            Signed in as <span className="font-mono font-semibold text-slate-900">{mustChangeUser.username}</span>. Replace your initial password (minimum 8 characters) to continue.
          </p>

          {error && (
            <div role="alert" className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
              {error}
            </div>
          )}

          <form onSubmit={handleForcedPasswordChange} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5" htmlFor="cur-pass">
                Current Password
              </label>
              <input
                id="cur-pass"
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5" htmlFor="new-pass">
                New Password
              </label>
              <input
                id="new-pass"
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5" htmlFor="conf-pass">
                Confirm New Password
              </label>
              <input
                id="conf-pass"
                type="password"
                required
                minLength={8}
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>
            <div className="flex items-center gap-3 pt-2">
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-2.5 px-4 text-sm font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-60 transition-colors whitespace-nowrap"
              >
                {loading ? 'Updating Password...' : 'Update Password'}
              </button>
              <button
                type="button"
                onClick={onLogout}
                className="py-2.5 px-4 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap"
              >
                Log Out
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  const theme = PORTAL_THEMES[portalRole];
  const PortalIcon = theme.icon;

  return (
    <div className={`min-h-screen ${theme.backdrop} flex flex-col justify-center items-center p-6 transition-colors duration-200`}>
      <div className="w-full max-w-md space-y-5">
        <div className="text-center space-y-2">
          <div className={`inline-flex items-center justify-center w-12 h-12 rounded-xl border mx-auto ${theme.badgeBg}`}>
            <PortalIcon className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white font-display">Meridian Trust Bank</h1>
          <p className="text-xs text-slate-300">{theme.subtitle}</p>
        </div>

        {/* Dedicated Role Login Portal Switcher */}
        <div className="grid grid-cols-3 gap-1 p-1 bg-black/30 border border-white/10 rounded-xl">
          {(['user', 'employee', 'manager'] as const).map((role) => {
            const active = portalRole === role;
            return (
              <button
                key={role}
                type="button"
                onClick={() => switchPortal(role)}
                className={`py-2 px-2.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                  active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-300 hover:text-white'
                }`}
              >
                {PORTAL_THEMES[role].label}
              </button>
            );
          })}
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-7 shadow-2xl">
          {error && (
            <div role="alert" className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
              {error}
            </div>
          )}
          {infoMessage && (
            <div className="mb-4 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 break-words">
              {infoMessage}
            </div>
          )}

          {view === 'login' && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">{theme.title}</h2>
                  <p className="text-xs text-slate-500 mt-0.5">Role-verified authentication</p>
                </div>
                <ShieldCheck className="w-5 h-5 text-slate-400 shrink-0" />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5" htmlFor="login-username">
                  Username
                </label>
                <input
                  id="login-username"
                  type="text"
                  required
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter username"
                  className={`w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 ${theme.ring}`}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5" htmlFor="login-password">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter password"
                    className={`w-full px-3.5 py-2.5 pr-10 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 ${theme.ring}`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className={`w-full py-2.5 px-4 text-sm font-semibold text-white rounded-lg disabled:opacity-60 transition-colors ${theme.buttonBg}`}
              >
                {loading ? 'Signing In...' : `Sign In to ${theme.label.replace(' Login', '')} Portal`}
              </button>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setView('recover');
                    setError(null);
                  }}
                  className={`font-medium hover:underline ${theme.linkColor}`}
                >
                  Forgot password?
                </button>
                {portalRole === 'employee' && (
                  <button
                    type="button"
                    onClick={() => {
                      setView('invite');
                      setError(null);
                    }}
                    className="font-medium text-slate-600 hover:text-slate-900 hover:underline"
                  >
                    Accept employee invite
                  </button>
                )}
              </div>
            </form>
          )}

          {view === 'invite' && (
            <form onSubmit={handleAcceptInvite} className="space-y-3.5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">Employee Invitation</h2>
                  <p className="text-xs text-slate-500 mt-0.5">Verify Gmail and mobile codes to activate access.</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setView('login');
                    setError(null);
                  }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back
                </button>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Invitation Token</label>
                <input
                  type="text"
                  required
                  value={inviteToken}
                  onChange={(e) => setInviteToken(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Gmail Code</label>
                  <input
                    type="text"
                    required
                    value={emailCode}
                    onChange={(e) => setEmailCode(e.target.value)}
                    placeholder="6 digits"
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Mobile Code</label>
                  <input
                    type="text"
                    required
                    value={mobileCode}
                    onChange={(e) => setMobileCode(e.target.value)}
                    placeholder="6 digits"
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Choose Username</label>
                <input
                  type="text"
                  required
                  value={inviteUsername}
                  onChange={(e) => setInviteUsername(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Set Password (min 8 chars)</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={invitePassword}
                  onChange={(e) => setInvitePassword(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className={`w-full py-2.5 px-4 text-sm font-semibold text-white rounded-lg disabled:opacity-60 ${theme.buttonBg}`}
              >
                {loading ? 'Verifying...' : 'Verify & Activate Account'}
              </button>
            </form>
          )}

          {view === 'recover' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">Account Recovery</h2>
                  <p className="text-xs text-slate-500 mt-0.5">Reset your password with a single-use token.</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setView('login');
                    setError(null);
                  }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back
                </button>
              </div>

              {recoverStep === 'request' ? (
                <form onSubmit={handleRecoveryRequest} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">Username or Email</label>
                    <input
                      type="text"
                      required
                      value={recoverIdentifier}
                      onChange={(e) => setRecoverIdentifier(e.target.value)}
                      className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={loading}
                    className={`w-full py-2.5 px-4 text-sm font-semibold text-white rounded-lg disabled:opacity-60 ${theme.buttonBg}`}
                  >
                    {loading ? 'Submitting...' : 'Request Recovery Token'}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleRecoveryConfirm} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">Recovery Token</label>
                    <input
                      type="text"
                      required
                      value={recoverToken}
                      onChange={(e) => setRecoverToken(e.target.value)}
                      className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">New Password (min 8 chars)</label>
                    <input
                      type="password"
                      required
                      minLength={8}
                      value={recoverNewPassword}
                      onChange={(e) => setRecoverNewPassword(e.target.value)}
                      className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={loading}
                    className={`w-full py-2.5 px-4 text-sm font-semibold text-white rounded-lg disabled:opacity-60 ${theme.buttonBg}`}
                  >
                    {loading ? 'Resetting...' : 'Reset Password'}
                  </button>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
