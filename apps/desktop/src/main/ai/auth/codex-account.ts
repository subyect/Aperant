import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OPENAI_CODEX_DEFAULT_MODEL } from '../../../shared/constants/models';
import type { ProviderAccount } from '../../../shared/types/provider-account';

export const CODEX_OAUTH_ACCOUNT_ID = 'openai-codex-subscription';

interface StoredCodexTokens {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
}

export function getCodexAuthFilePath(userDataDir = process.env.APERANT_USER_DATA_DIR): string | null {
  if (!userDataDir) return null;
  return join(userDataDir, 'codex-auth.json');
}

export function hasCodexOAuthTokens(userDataDir = process.env.APERANT_USER_DATA_DIR): boolean {
  const tokenFilePath = getCodexAuthFilePath(userDataDir);
  if (!tokenFilePath || !existsSync(tokenFilePath)) return false;

  try {
    const tokens = JSON.parse(readFileSync(tokenFilePath, 'utf8')) as StoredCodexTokens;
    return typeof tokens.access_token === 'string'
      && tokens.access_token.length > 0
      && typeof tokens.refresh_token === 'string'
      && tokens.refresh_token.length > 0;
  } catch {
    return false;
  }
}

export function createCodexOAuthProviderAccount(now = Date.now()): ProviderAccount {
  return {
    id: CODEX_OAUTH_ACCOUNT_ID,
    provider: 'openai',
    name: 'OpenAI Codex Subscription',
    authType: 'oauth',
    billingModel: 'subscription',
    createdAt: now,
    updatedAt: now,
    customModels: [
      {
        id: OPENAI_CODEX_DEFAULT_MODEL,
        label: 'GPT-5.3 Codex',
      },
    ],
  };
}

export function findCodexOAuthAccount(accounts: ProviderAccount[]): ProviderAccount | undefined {
  return accounts.find((account) =>
    account.provider === 'openai'
    && (account.authType === 'oauth' || account.billingModel === 'subscription')
  );
}

export function ensureCodexOAuthAccount(
  accounts: ProviderAccount[] | undefined,
  userDataDir = process.env.APERANT_USER_DATA_DIR,
): { accounts: ProviderAccount[]; accountId?: string; added: boolean } {
  const currentAccounts = accounts ?? [];
  if (!hasCodexOAuthTokens(userDataDir)) {
    return { accounts: currentAccounts, added: false };
  }

  const existing = findCodexOAuthAccount(currentAccounts);
  if (existing) {
    return { accounts: currentAccounts, accountId: existing.id, added: false };
  }

  const account = createCodexOAuthProviderAccount();
  return {
    accounts: [account, ...currentAccounts],
    accountId: account.id,
    added: true,
  };
}

