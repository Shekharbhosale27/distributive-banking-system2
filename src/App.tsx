import { useCallback, useEffect, useState } from 'react';
import { apiFetch, clearAuthTokens, setCsrfToken, type AuthUser } from './lib/api';
import { AuthPortal } from './components/AuthPortal';
import { CustomerWorkspace } from './components/CustomerWorkspace';
import { EmployeeWorkspace } from './components/EmployeeWorkspace';
import { ManagerWorkspace } from './components/ManagerWorkspace';

export default function App() {
  const [bootstrapping, setBootstrapping] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [devSeedEnabled, setDevSeedEnabled] = useState(false);

  const checkSession = useCallback(async () => {
    try {
      const res = await apiFetch<{
        authenticated: boolean;
        user: AuthUser | null;
        csrfToken: string | null;
        devSeedEnabled: boolean;
      }>('/api/auth/me');
      if (res.authenticated && res.user) {
        setCsrfToken(res.csrfToken);
        setUser(res.user);
      } else {
        clearAuthTokens();
        setUser(null);
      }
      setDevSeedEnabled(Boolean(res.devSeedEnabled));
    } catch {
      clearAuthTokens();
      setUser(null);
    } finally {
      setBootstrapping(false);
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  async function handleLogout() {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ignore already-expired or missing session errors during logout
    } finally {
      clearAuthTokens();
      setUser(null);
    }
  }

  if (bootstrapping) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <p className="text-sm font-medium text-slate-600">Loading Meridian Trust Bank...</p>
      </div>
    );
  }

  if (!user || user.mustChangePassword) {
    return (
      <AuthPortal
        devSeedEnabled={devSeedEnabled}
        mustChangeUser={user?.mustChangePassword ? user : null}
        onAuthenticated={(u) => setUser(u)}
        onLogout={handleLogout}
      />
    );
  }

  if (user.role === 'user') {
    return <CustomerWorkspace user={user} onLogout={handleLogout} />;
  }

  if (user.role === 'employee') {
    return <EmployeeWorkspace user={user} onLogout={handleLogout} />;
  }

  return <ManagerWorkspace user={user} onLogout={handleLogout} />;
}
