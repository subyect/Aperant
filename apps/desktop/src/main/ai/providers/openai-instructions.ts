export function shouldUseOpenAIInstructions(client: {
  queueAuth?: { source?: string };
  resolvedModelId?: string | null;
  model?: { modelId?: string } | string;
}): boolean {
  const modelId = client.resolvedModelId
    ?? (typeof client.model === 'string' ? client.model : client.model?.modelId)
    ?? '';
  return client.queueAuth?.source === 'codex-oauth' || modelId.includes('codex');
}
