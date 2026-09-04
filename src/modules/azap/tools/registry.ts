export type AzapToolRisk = 'low' | 'high';

export type AzapToolDefinition = {
  name: string;
  description: string;
  risk: AzapToolRisk;
  requiresAuth: boolean;
  requiresKyc: boolean;
  requiresPin: boolean;
  requiresConfirmation: boolean;
  requiresIdempotency: boolean;
};

export const AZAP_TOOLS: readonly AzapToolDefinition[] = [
  {
    name: 'get_balance',
    description: 'Get wallet balances from Dayfi',
    risk: 'low',
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: false,
    requiresConfirmation: false,
    requiresIdempotency: false,
  },
  {
    name: 'get_rates',
    description: 'Get authoritative FX rates',
    risk: 'low',
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: false,
    requiresConfirmation: false,
    requiresIdempotency: false,
  },
  {
    name: 'list_saved_recipients',
    description: 'List saved recipients and aliases',
    risk: 'low',
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: false,
    requiresConfirmation: false,
    requiresIdempotency: false,
  },
  {
    name: 'get_pricing',
    description: 'Get Azap service charges',
    risk: 'low',
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: false,
    requiresConfirmation: false,
    requiresIdempotency: false,
  },
  {
    name: 'create_bank_transfer',
    description: 'Create a bank transfer via Dayfi',
    risk: 'high',
    requiresAuth: true,
    requiresKyc: true,
    requiresPin: true,
    requiresConfirmation: true,
    requiresIdempotency: true,
  },
  {
    name: 'create_airtime_purchase',
    description: 'Purchase airtime via provider',
    risk: 'high',
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: true,
    requiresConfirmation: true,
    requiresIdempotency: true,
  },
  {
    name: 'create_bill_payment',
    description: 'Pay a bill via provider',
    risk: 'high',
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: true,
    requiresConfirmation: true,
    requiresIdempotency: true,
  },
] as const;

export function getTool(name: string): AzapToolDefinition | null {
  return AZAP_TOOLS.find((t) => t.name === name) ?? null;
}

export function assertToolAllowed(
  tool: AzapToolDefinition,
  ctx: { pinVerified?: boolean; kycVerified?: boolean }
): { ok: boolean; reason?: string } {
  if (tool.requiresKyc && !ctx.kycVerified) {
    return { ok: false, reason: 'KYC required' };
  }
  if (tool.requiresPin && !ctx.pinVerified) {
    return { ok: false, reason: 'PIN required' };
  }
  return { ok: true };
}
