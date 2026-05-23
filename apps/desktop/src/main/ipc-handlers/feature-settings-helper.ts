/**
 * Feature Settings Helper
 *
 * Reads per-provider feature settings (model + thinking level) for feature runners
 * like Insights, Ideation, and Roadmap.
 *
 * Resolution order:
 * 1. providerAgentConfig[activeProvider].featureModels[featureKey]
 * 2. Legacy global settings.featureModels[featureKey]
 * 3. DEFAULT_FEATURE_MODELS[featureKey]
 *
 * The "active provider" is determined from the first account in globalPriorityOrder
 * that matches a configured providerAccount.
 */

import { readSettingsFile } from '../settings-utils';
import {
  ALL_AVAILABLE_MODELS,
  DEFAULT_FEATURE_MODELS,
  DEFAULT_FEATURE_THINKING,
  resolveModelEquivalent,
} from '../../shared/constants/models';
import type { FeatureModelConfig, FeatureThinkingConfig } from '../../shared/types/settings';
import type { BuiltinProvider } from '../../shared/types/provider-account';
import type { ProviderAccount } from '../../shared/types/provider-account';

type FeatureKey = keyof FeatureModelConfig;

interface FeatureSettings {
  model: string;
  thinkingLevel: string;
}

/**
 * Determine the active provider from settings.
 * Looks at globalPriorityOrder + providerAccounts to find
 * the first provider in the user's priority order.
 */
function resolveActiveProvider(settings: Record<string, unknown>): BuiltinProvider | undefined {
  const priorityOrder = settings.globalPriorityOrder as string[] | undefined;
  const accounts = settings.providerAccounts as ProviderAccount[] | undefined;

  if (!priorityOrder?.length || !accounts?.length) return undefined;

  // Walk priority order, find the first account that matches
  for (const accountId of priorityOrder) {
    const account = accounts.find(a => a.id === accountId);
    if (account?.provider) {
      return account.provider as BuiltinProvider;
    }
  }

  // Fallback: use the first account's provider
  return accounts[0]?.provider as BuiltinProvider | undefined;
}

function resolveActiveAccount(settings: Record<string, unknown>): ProviderAccount | undefined {
  const priorityOrder = settings.globalPriorityOrder as string[] | undefined;
  const accounts = settings.providerAccounts as ProviderAccount[] | undefined;

  if (!accounts?.length) return undefined;
  if (priorityOrder?.length) {
    for (const accountId of priorityOrder) {
      const account = accounts.find(a => a.id === accountId);
      if (account) return account;
    }
  }
  return accounts[0];
}

function isSubscriptionOnlyOpenAIAccount(account: ProviderAccount | undefined): boolean {
  return account?.provider === 'openai'
    && (account.authType === 'oauth' || account.billingModel === 'subscription');
}

function isSupportedFeatureModelForAccount(model: string, provider: BuiltinProvider, account?: ProviderAccount): boolean {
  const entry = ALL_AVAILABLE_MODELS.find(m => m.value === model && m.provider === provider);
  if (!entry) return false;
  if (isSubscriptionOnlyOpenAIAccount(account) && entry.apiKeyOnly) return false;
  return true;
}

function resolveFeatureModelForProvider(
  model: string,
  featureKey: FeatureKey,
  provider?: BuiltinProvider,
  account?: ProviderAccount,
): string {
  if (!provider) return model;

  if (isSupportedFeatureModelForAccount(model, provider, account)) {
    return model;
  }

  const equivalent = resolveModelEquivalent(model, provider);
  if (equivalent && isSupportedFeatureModelForAccount(equivalent.modelId, provider, account)) {
    return equivalent.modelId;
  }

  const fallback = DEFAULT_FEATURE_MODELS[featureKey];
  if (isSupportedFeatureModelForAccount(fallback, provider, account)) {
    return fallback;
  }

  const fallbackEquivalent = resolveModelEquivalent(fallback, provider);
  if (fallbackEquivalent && isSupportedFeatureModelForAccount(fallbackEquivalent.modelId, provider, account)) {
    return fallbackEquivalent.modelId;
  }

  const providerDefault = ALL_AVAILABLE_MODELS.find(m =>
    m.provider === provider && !(isSubscriptionOnlyOpenAIAccount(account) && m.apiKeyOnly)
  );
  return providerDefault?.value ?? fallback;
}

/**
 * Get feature model and thinking level for a specific feature runner.
 *
 * Reads the active provider's per-provider config first, then falls back
 * to the legacy global featureModels/featureThinking, then to defaults.
 */
export function getActiveProviderFeatureSettings(featureKey: FeatureKey): FeatureSettings {
  const settings = readSettingsFile();
  if (!settings) {
    return {
      model: DEFAULT_FEATURE_MODELS[featureKey],
      thinkingLevel: DEFAULT_FEATURE_THINKING[featureKey],
    };
  }

  // Try per-provider config first
  const activeProvider = resolveActiveProvider(settings);
  const activeAccount = resolveActiveAccount(settings);
  if (activeProvider) {
    const providerConfig = (settings.providerAgentConfig as Record<string, Record<string, unknown>> | undefined)?.[activeProvider];
    if (providerConfig) {
      const perProviderModels = providerConfig.featureModels as FeatureModelConfig | undefined;
      const perProviderThinking = providerConfig.featureThinking as FeatureThinkingConfig | undefined;

      const model = perProviderModels?.[featureKey];
      const thinking = perProviderThinking?.[featureKey];

      if (model) {
        return {
          model: resolveFeatureModelForProvider(model, featureKey, activeProvider, activeAccount),
          thinkingLevel: thinking ?? DEFAULT_FEATURE_THINKING[featureKey],
        };
      }
    }
  }

  // Fallback to legacy global settings
  const globalModels = settings.featureModels as FeatureModelConfig | undefined;
  const globalThinking = settings.featureThinking as FeatureThinkingConfig | undefined;

  const model = globalModels?.[featureKey] ?? DEFAULT_FEATURE_MODELS[featureKey];
  const thinkingLevel = globalThinking?.[featureKey] ?? DEFAULT_FEATURE_THINKING[featureKey];

  if (activeProvider) {
    return {
      model: resolveFeatureModelForProvider(model, featureKey, activeProvider, activeAccount),
      thinkingLevel,
    };
  }

  return { model, thinkingLevel };
}
