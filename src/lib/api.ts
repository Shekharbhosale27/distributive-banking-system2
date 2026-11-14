export type UserRole = 'user' | 'employee' | 'manager';

export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  mobile: string | null;
  fullName: string;
  role: UserRole;
  mustChangePassword: boolean;
  smsOptIn: boolean;
  emailOptIn: boolean;
  kycStatus: string;
  kycMaskedId: string | null;
  department: string | null;
}

export class ApiError extends Error {
  code: string;
  status: number;
  data: Record<string, unknown>;
  constructor(status: number, code: string, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

const CSRF_KEY = 'mtb_csrf_token';
const TOKEN_KEY = 'mtb_access_token';

let currentCsrfToken: string | null =
  typeof window !== 'undefined' ? window.sessionStorage.getItem(CSRF_KEY) : null;
let currentAccessToken: string | null =
  typeof window !== 'undefined' ? window.sessionStorage.getItem(TOKEN_KEY) : null;

export function setCsrfToken(token: string | null) {
  currentCsrfToken = token;
  if (typeof window !== 'undefined') {
    if (token) window.sessionStorage.setItem(CSRF_KEY, token);
    else window.sessionStorage.removeItem(CSRF_KEY);
  }
}

export function setAccessToken(token: string | null) {
  currentAccessToken = token;
  if (typeof window !== 'undefined') {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  }
}

export function clearAuthTokens() {
  setCsrfToken(null);
  setAccessToken(null);
}

export async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  if (currentAccessToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${currentAccessToken}`);
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && currentCsrfToken) {
    headers.set('X-CSRF-Token', currentCsrfToken);
  }

  const res = await fetch(url, {
    ...options,
    credentials: 'include',
    headers,
  });

  const text = await res.text();
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { message: text };
    }
  }

  if (!res.ok) {
    throw new ApiError(
      res.status,
      (json.error as string) || 'REQUEST_FAILED',
      (json.message as string) || `Request failed with status ${res.status}`,
      json,
    );
  }

  return json as T;
}

export function formatInr(paise: number): string {
  const rupees = paise / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rupees);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function createIdempotencyKey(prefix = 'op'): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
