import type Database from 'better-sqlite3';
import { AppConfig } from '../config.ts';
import { generateId } from '../security/crypto.ts';

export interface MobileResolutionResult {
  resolved: boolean;
  provider: string;
  mode: 'sandbox' | 'live';
  mobile: string;
  upiHandle?: string;
  recipientName?: string;
  internalAccountId?: string;
  message: string;
}

export interface ExternalPaymentResult {
  status: 'pending' | 'success' | 'failed';
  provider: string;
  mode: 'sandbox' | 'live';
  providerTxRef: string;
  message: string;
}

const SANDBOX_EXTERNAL_DIRECTORY: Record<string, { upiHandle: string; recipientName: string }> = {
  '+919899990001': { upiHandle: 'ananya.rao@okaxis', recipientName: 'Ananya Rao (External Sandbox)' },
  '+919899990002': { upiHandle: 'vikram.merch@ybl', recipientName: 'Vikram Electronics (External Sandbox)' },
};

export async function resolveMobileViaProvider(
  mobile: string,
  db: Database.Database,
  config: AppConfig,
): Promise<MobileResolutionResult> {
  const normalized = mobile.trim();

  if (config.paymentProviderMode === 'live') {
    if (!config.paymentProviderBaseUrl || !config.paymentProviderApiKey) {
      return {
        resolved: false,
        provider: 'npci_upi_live',
        mode: 'live',
        mobile: normalized,
        message: 'Live UPI payment provider credentials are not configured.',
      };
    }

    const res = await fetch(`${config.paymentProviderBaseUrl.replace(/\/$/, '')}/v1/upi/resolve-mobile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.paymentProviderApiKey}`,
      },
      body: JSON.stringify({ mobile: normalized }),
    });

    if (!res.ok) {
      return {
        resolved: false,
        provider: 'npci_upi_live',
        mode: 'live',
        mobile: normalized,
        message: 'Mobile number could not be resolved by payment provider.',
      };
    }

    const data = (await res.json()) as { resolved: boolean; upiHandle?: string; recipientName?: string; message?: string };
    return {
      resolved: Boolean(data.resolved),
      provider: 'npci_upi_live',
      mode: 'live',
      mobile: normalized,
      upiHandle: data.upiHandle,
      recipientName: data.recipientName,
      message: data.message || (data.resolved ? 'Resolved by UPI provider.' : 'Mobile not registered for UPI.'),
    };
  }

  // Sandbox mode: Check internal Meridian accounts with an active UPI handle first, then sandbox external directory.
  // Never blindly assume every phone number is a UPI address.
  const internalMatch = db
    .prepare(
      `SELECT a.id as account_id, a.upi_handle, u.full_name
       FROM users u
       JOIN accounts a ON a.user_id = u.id
       WHERE u.mobile = ? AND u.status = 'active' AND a.status = 'active' AND a.upi_handle IS NOT NULL
       LIMIT 1`,
    )
    .get(normalized) as { account_id: string; upi_handle: string; full_name: string } | undefined;

  if (internalMatch) {
    return {
      resolved: true,
      provider: 'upi_directory_sandbox',
      mode: 'sandbox',
      mobile: normalized,
      upiHandle: internalMatch.upi_handle,
      recipientName: internalMatch.full_name,
      internalAccountId: internalMatch.account_id,
      message: 'Verified registered UPI handle via payment directory (sandbox).',
    };
  }

  const externalMatch = SANDBOX_EXTERNAL_DIRECTORY[normalized];
  if (externalMatch) {
    return {
      resolved: true,
      provider: 'upi_directory_sandbox',
      mode: 'sandbox',
      mobile: normalized,
      upiHandle: externalMatch.upiHandle,
      recipientName: externalMatch.recipientName,
      message: 'Verified external UPI handle via payment directory (sandbox).',
    };
  }

  return {
    resolved: false,
    provider: 'upi_directory_sandbox',
    mode: 'sandbox',
    mobile: normalized,
    message: 'Mobile number is not linked to a verified UPI handle in the payment provider directory.',
  };
}

export async function submitUpiPaymentToProvider(
  params: {
    upiHandle: string;
    amountPaise: number;
    referenceCode: string;
    note: string;
  },
  config: AppConfig,
): Promise<ExternalPaymentResult> {
  if (config.paymentProviderMode === 'live') {
    if (!config.paymentProviderBaseUrl || !config.paymentProviderApiKey) {
      return {
        status: 'failed',
        provider: 'npci_upi_live',
        mode: 'live',
        providerTxRef: generateId('LIVE-UNCONFIGURED'),
        message: 'Live payment provider credentials are missing; transfer cannot execute.',
      };
    }

    const res = await fetch(`${config.paymentProviderBaseUrl.replace(/\/$/, '')}/v1/upi/pay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.paymentProviderApiKey}`,
      },
      body: JSON.stringify(params),
    });

    const data = (await res.json()) as { status?: 'pending' | 'success' | 'failed'; providerTxRef?: string; message?: string };
    return {
      status: data.status || (res.ok ? 'pending' : 'failed'),
      provider: 'npci_upi_live',
      mode: 'live',
      providerTxRef: data.providerTxRef || generateId('UPI-LIVE'),
      message: data.message || 'Submitted to live UPI gateway.',
    };
  }

  const vpa = params.upiHandle.toLowerCase();
  if (vpa.startsWith('fail@') || params.amountPaise === 99999) {
    return {
      status: 'failed',
      provider: 'upi_gateway_sandbox',
      mode: 'sandbox',
      providerTxRef: generateId('UPI-SBX-FAIL'),
      message: 'Sandbox UPI gateway declined transaction (simulated PSP failure).',
    };
  }

  if (vpa.startsWith('pending@')) {
    return {
      status: 'pending',
      provider: 'upi_gateway_sandbox',
      mode: 'sandbox',
      providerTxRef: generateId('UPI-SBX-PEND'),
      message: 'Sandbox UPI payment submitted and awaiting asynchronous PSP confirmation.',
    };
  }

  return {
    status: 'success',
    provider: 'upi_gateway_sandbox',
    mode: 'sandbox',
    providerTxRef: generateId('UPI-SBX'),
    message: 'Confirmed by UPI sandbox gateway.',
  };
}

export async function submitBankTransferToProvider(
  params: {
    beneficiaryName: string;
    accountNumber: string;
    ifscCode: string;
    rail: 'IMPS' | 'NEFT' | 'RTGS';
    amountPaise: number;
    referenceCode: string;
  },
  config: AppConfig,
): Promise<ExternalPaymentResult> {
  if (config.paymentProviderMode === 'live') {
    if (!config.paymentProviderBaseUrl || !config.paymentProviderApiKey) {
      return {
        status: 'failed',
        provider: 'bank_rails_live',
        mode: 'live',
        providerTxRef: generateId('BANK-UNCONFIGURED'),
        message: 'Live banking rail credentials and sponsor bank approvals are not configured.',
      };
    }

    const res = await fetch(`${config.paymentProviderBaseUrl.replace(/\/$/, '')}/v1/bank-transfers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.paymentProviderApiKey}`,
      },
      body: JSON.stringify(params),
    });

    const data = (await res.json()) as { status?: 'pending' | 'success' | 'failed'; providerTxRef?: string; message?: string };
    return {
      status: data.status || (res.ok ? 'pending' : 'failed'),
      provider: 'bank_rails_live',
      mode: 'live',
      providerTxRef: data.providerTxRef || generateId('BNK-LIVE'),
      message: data.message || 'Submitted to banking rails.',
    };
  }

  if (params.ifscCode.toUpperCase() === 'FAIL0000001') {
    return {
      status: 'failed',
      provider: 'bank_rails_sandbox',
      mode: 'sandbox',
      providerTxRef: generateId('BNK-SBX-FAIL'),
      message: 'Sandbox banking rail rejected transfer due to invalid beneficiary IFSC.',
    };
  }

  // Bank-account transfers return pending until provider webhook or reconciliation confirms settlement
  return {
    status: 'pending',
    provider: 'bank_rails_sandbox',
    mode: 'sandbox',
    providerTxRef: generateId('BNK-SBX'),
    message: `Submitted to ${params.rail} sandbox clearing rail. Funds are held pending provider settlement confirmation.`,
  };
}
