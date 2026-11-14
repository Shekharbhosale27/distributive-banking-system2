import { AppConfig } from '../config.ts';
import { generateId, maskAadhaarLast4 } from '../security/crypto.ts';

export interface KycVerificationResult {
  verified: boolean;
  provider: string;
  mode: 'sandbox' | 'live';
  providerRef: string | null;
  maskedId: string;
  message: string;
}

// Verhoeff algorithm tables for 12-digit Aadhaar checksum validation
const VERHOEFF_D = [
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

const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function validateVerhoeffChecksum(digits: string): boolean {
  if (!/^\d{12}$/.test(digits)) return false;
  if (digits[0] === '0' || digits[0] === '1') return false;
  let c = 0;
  const reversed = digits.split('').reverse().map(Number);
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][reversed[i]]];
  }
  return c === 0;
}

/**
 * Generates a valid Verhoeff 12-digit test number from an 11-digit stem (starts with 2-9) for sandbox testing.
 */
export function computeVerhoeffCheckDigit(elevenDigits: string): string {
  const inv = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];
  let c = 0;
  const reversed = elevenDigits.split('').reverse().map(Number);
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[(i + 1) % 8][reversed[i]]];
  }
  return String(inv[c]);
}

export async function verifyAadhaarWithProvider(
  aadhaarInput: string,
  fullName: string,
  config: AppConfig,
): Promise<KycVerificationResult> {
  const digits = aadhaarInput.replace(/[\s-]/g, '');
  const maskedId = maskAadhaarLast4(digits);

  if (!validateVerhoeffChecksum(digits)) {
    return {
      verified: false,
      provider: config.kycProviderMode === 'live' ? 'uidai_kua_live' : 'uidai_kua_sandbox',
      mode: config.kycProviderMode,
      providerRef: null,
      maskedId,
      message: 'Aadhaar number failed 12-digit format or Verhoeff checksum validation.',
    };
  }

  if (config.kycProviderMode === 'live') {
    if (!config.kycProviderBaseUrl || !config.kycProviderApiKey) {
      return {
        verified: false,
        provider: 'uidai_kua_live',
        mode: 'live',
        providerRef: null,
        maskedId,
        message: 'Live KYC provider credentials are not configured. Regulatory KUA/ASA onboarding is required.',
      };
    }

    const res = await fetch(`${config.kycProviderBaseUrl.replace(/\/$/, '')}/v1/aadhaar/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.kycProviderApiKey}`,
      },
      body: JSON.stringify({ aadhaarNumber: digits, fullName }),
    });

    if (!res.ok) {
      return {
        verified: false,
        provider: 'uidai_kua_live',
        mode: 'live',
        providerRef: null,
        maskedId,
        message: `KYC provider returned status ${res.status}`,
      };
    }

    const body = (await res.json()) as { verified?: boolean; referenceId?: string; message?: string };
    return {
      verified: Boolean(body.verified),
      provider: 'uidai_kua_live',
      mode: 'live',
      providerRef: body.referenceId || null,
      maskedId,
      message: body.message || (body.verified ? 'KYC verified by provider.' : 'KYC rejected by provider.'),
    };
  }

  // Sandbox mode: deterministic rejection test pattern (numbers ending in 0000)
  if (digits.endsWith('0000')) {
    return {
      verified: false,
      provider: 'uidai_kua_sandbox',
      mode: 'sandbox',
      providerRef: null,
      maskedId,
      message: 'Sandbox KYC provider declined verification for test rejection pattern.',
    };
  }

  // Never retain raw digits after returning token reference
  return {
    verified: true,
    provider: 'uidai_kua_sandbox',
    mode: 'sandbox',
    providerRef: generateId('KYC-SBX'),
    maskedId,
    message: 'Verified via KYC sandbox adapter (raw Aadhaar discarded).',
  };
}
