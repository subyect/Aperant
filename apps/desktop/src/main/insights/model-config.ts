import type { InsightsModelConfig } from '../../shared/types';
import type { ThinkingLevel } from '../../shared/types/settings';
import {
  getActiveProviderFeatureSettings,
  resolveActiveProviderFeatureModel,
} from '../ipc-handlers/feature-settings-helper';

export function resolveInsightsModelConfig(modelConfig?: InsightsModelConfig): InsightsModelConfig {
  const featureSettings = getActiveProviderFeatureSettings('insights');
  const requestedModel = modelConfig?.model ?? featureSettings.model;

  return {
    profileId: modelConfig?.profileId ?? 'balanced',
    model: resolveActiveProviderFeatureModel('insights', requestedModel),
    thinkingLevel: (modelConfig?.thinkingLevel ?? featureSettings.thinkingLevel) as ThinkingLevel,
  };
}
