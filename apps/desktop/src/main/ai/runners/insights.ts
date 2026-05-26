/**
 * Insights Runner
 * ===============
 *
 * AI chat for codebase insights using Vercel AI SDK.
 * See apps/desktop/src/main/ai/runners/insights.ts for the TypeScript implementation.
 *
 * Provides an AI-powered chat interface for asking questions about a codebase.
 * Can also suggest tasks based on the conversation.
 *
 * Uses `createSimpleClient()` with read-only tools (Read, Glob, Grep) and streaming.
 */

import { streamText, stepCountIs } from 'ai';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { buildDefaultQueueConfig } from '../auth/resolver';
import { createSimpleClient } from '../client/factory';
import { resolveModelId } from '../config/phase-config';
import { shouldUseOpenAIInstructions } from '../providers/openai-instructions';
import { buildToolRegistry } from '../tools/build-registry';
import type { ToolContext } from '../tools/types';
import type { ModelShorthand, ThinkingLevel } from '../config/types';
import type { SecurityProfile } from '../security/bash-validator';
import type { ProviderAccount } from '../../../shared/types/provider-account';
import { safeParseJson } from '../../utils/json-repair';
import { parseLLMJson } from '../schema/structured-output';
import { TaskSuggestionSchema } from '../schema/insight-extractor';

// =============================================================================
// Types
// =============================================================================

/** A message in the insights conversation history */
export interface InsightsMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Configuration for running an insights query */
export interface InsightsConfig {
  /** Project directory path */
  projectDir: string;
  /** User message to process */
  message: string;
  /** Previous conversation history */
  history?: InsightsMessage[];
  /** Model shorthand or full model ID (defaults to 'sonnet') */
  modelShorthand?: ModelShorthand | string;
  /** Thinking level (defaults to 'medium') */
  thinkingLevel?: ThinkingLevel;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

/** Result of an insights query */
export interface InsightsResult {
  /** Full response text */
  text: string;
  /** Task suggestion if detected, or null */
  taskSuggestion: TaskSuggestion | null;
  /** Tool calls made during the session */
  toolCalls: ToolCallInfo[];
}

/** A task suggestion extracted from the response */
export interface TaskSuggestion {
  title: string;
  description: string;
  metadata: {
    category: string;
    complexity: string;
    impact: string;
  };
}

/** Info about a tool call made during the session */
export interface ToolCallInfo {
  name: string;
  input: string;
}

/** Callback for streaming events from the insights runner */
export type InsightsStreamCallback = (event: InsightsStreamEvent) => void;

/** Events emitted during insights streaming */
export type InsightsStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; name: string; input: string }
  | { type: 'tool-end'; name: string }
  | { type: 'error'; error: string };

const MAX_TRANSIENT_STREAM_RETRIES = 2;
const ERROR_DETAIL_KEYS = ['responseBody', 'body', 'error', 'detail', 'details', 'cause', 'statusText', 'message'];

function redactSecrets(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-api-key]');
}

function formatStringError(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed);
      const nested = formatInsightsError(parsed);
      if (nested && nested !== '[object Object]') return nested;
    } catch {
      // Use the raw string below.
    }
  }

  return redactSecrets(trimmed).slice(0, 1200);
}

function formatObjectError(error: Record<string, unknown>): string {
  for (const key of ERROR_DETAIL_KEYS) {
    const value = error[key];
    if (typeof value === 'string') {
      const formatted = formatStringError(value);
      if (formatted) return formatted;
    }
    if (value && typeof value === 'object') {
      const nested = formatInsightsError(value);
      if (nested && nested !== '[object Object]') return nested;
    }
  }

  try {
    const json = JSON.stringify(error);
    if (json && json !== '{}') return redactSecrets(json).slice(0, 1200);
  } catch {
    // Fall through to String below.
  }

  return '';
}

export function formatInsightsError(error: unknown): string {
  if (typeof error === 'string') return formatStringError(error);
  if (error === null || error === undefined) return String(error);

  if (typeof error === 'object') {
    const objectMessage = formatObjectError(error as Record<string, unknown>);
    if (error instanceof Error) {
      const baseMessage = formatStringError(error.message);
      if (objectMessage && objectMessage !== baseMessage) {
        return baseMessage && !objectMessage.includes(baseMessage)
          ? `${baseMessage}: ${objectMessage}`
          : objectMessage;
      }
      return baseMessage || error.name;
    }
    if (objectMessage) return objectMessage;
  }

  return String(error);
}

function isSubscriptionAccount(account: ProviderAccount): boolean {
  return account.billingModel === 'subscription' || account.authType === 'oauth';
}

function buildInsightsSubscriptionQueueConfig(modelShorthand: string) {
  const queueConfig = buildDefaultQueueConfig(resolveModelId(modelShorthand));
  if (!queueConfig) return undefined;

  const subscriptionQueue = queueConfig.queue.filter(isSubscriptionAccount);
  return {
    ...queueConfig,
    queue: subscriptionQueue,
  };
}

function isRetryableInsightsError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return normalized.includes('overloaded')
    || normalized.includes('temporarily unavailable')
    || normalized.includes('please try again later');
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// Project Context Loading
// =============================================================================

/**
 * Load project context for the AI.
 * Mirrors Python's `load_project_context()`.
 */
function loadProjectContext(projectDir: string): string {
  const contextParts: string[] = [];

  // Load project index if available
  const indexPath = join(projectDir, '.auto-claude', 'project_index.json');
  if (existsSync(indexPath)) {
    const index = safeParseJson<Record<string, unknown>>(readFileSync(indexPath, 'utf-8'));
    if (index) {
      const summary = {
        project_root: index.project_root ?? '',
        project_type: index.project_type ?? 'unknown',
        services: Object.keys((index.services as Record<string, unknown>) ?? {}),
        infrastructure: index.infrastructure ?? {},
      };
      contextParts.push(
        `## Project Structure\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``,
      );
    }
  }

  // Load roadmap if available
  const roadmapPath = join(projectDir, '.auto-claude', 'roadmap', 'roadmap.json');
  if (existsSync(roadmapPath)) {
    const roadmap = safeParseJson<Record<string, unknown>>(readFileSync(roadmapPath, 'utf-8'));
    if (roadmap) {
      const features = ((roadmap.features as Record<string, unknown>[]) ?? []).slice(0, 10);
      const featureSummary = features.map((f: Record<string, unknown>) => ({
        title: f.title ?? '',
        status: f.status ?? '',
      }));
      contextParts.push(
        `## Roadmap Features\n\`\`\`json\n${JSON.stringify(featureSummary, null, 2)}\n\`\`\``,
      );
    }
  }

  // Load existing tasks
  const tasksPath = join(projectDir, '.auto-claude', 'specs');
  if (existsSync(tasksPath)) {
    try {
      const taskDirs = readdirSync(tasksPath, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .slice(0, 10);
      if (taskDirs.length > 0) {
        contextParts.push(`## Existing Tasks/Specs\n- ${taskDirs.join('\n- ')}`);
      }
    } catch {
      // Ignore read errors
    }
  }

  return contextParts.length > 0
    ? contextParts.join('\n\n')
    : 'No project context available yet.';
}

/**
 * Build the system prompt for the insights agent.
 * Mirrors Python's `build_system_prompt()`.
 */
function buildSystemPrompt(projectDir: string): string {
  const context = loadProjectContext(projectDir);

  return `You are an AI assistant helping developers understand and work with their codebase.
You have access to the following project context:

${context}

Your capabilities:
1. Answer questions about the codebase structure, patterns, and architecture
2. Suggest improvements, features, or bug fixes based on the code
3. Help plan implementation of new features
4. Provide code examples and explanations

For codebase-specific questions, use the available read-only tools (Read, Glob,
and Grep) directly before answering. Do not ask for permission to inspect files
or defer the analysis; the user has already asked you to inspect the codebase.

When the user asks you to create a task, wants to turn the conversation into a task, or when you believe creating a task would be helpful, output a task suggestion in this exact format on a SINGLE LINE:
__TASK_SUGGESTION__:{"title": "Task title here", "description": "Detailed description of what the task involves", "metadata": {"category": "feature", "complexity": "medium", "impact": "medium"}}

Valid categories: feature, bug_fix, refactoring, documentation, security, performance, ui_ux, infrastructure, testing
Valid complexity: trivial, small, medium, large, complex
Valid impact: low, medium, high, critical

Be conversational and helpful. Focus on providing actionable insights and clear explanations.
Keep responses concise but informative.`;
}

// =============================================================================
// Task Suggestion Extraction
// =============================================================================

const TASK_SUGGESTION_PREFIX = '__TASK_SUGGESTION__:';

/**
 * Extract a task suggestion from the response text if present.
 */
function extractTaskSuggestion(text: string): TaskSuggestion | null {
  const idx = text.indexOf(TASK_SUGGESTION_PREFIX);
  if (idx === -1) return null;

  // Find the JSON on the same line
  const afterPrefix = text.substring(idx + TASK_SUGGESTION_PREFIX.length);
  const lineEnd = afterPrefix.indexOf('\n');
  const jsonStr = lineEnd === -1 ? afterPrefix.trim() : afterPrefix.substring(0, lineEnd).trim();

  const validated = parseLLMJson(jsonStr, TaskSuggestionSchema);
  if (validated && validated.title && validated.description) {
    return validated as TaskSuggestion;
  }

  return null;
}

// =============================================================================
// Insights Runner
// =============================================================================

/**
 * Run an insights chat query with streaming.
 *
 * @param config - Insights query configuration
 * @param onStream - Optional callback for streaming events
 * @returns Insights result with text, task suggestion, and tool call info
 */
export async function runInsightsQuery(
  config: InsightsConfig,
  onStream?: InsightsStreamCallback,
): Promise<InsightsResult> {
  const {
    projectDir,
    message,
    history = [],
    modelShorthand = 'sonnet',
    thinkingLevel = 'medium',
    abortSignal,
  } = config;

  const systemPrompt = buildSystemPrompt(projectDir);

  // Build conversation context from history
  let fullPrompt = message;
  if (history.length > 0) {
    const conversationContext = history
      .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n\n');
    fullPrompt = `Previous conversation:\n${conversationContext}\n\nCurrent question: ${message}`;
  }

  // Create tool context for read-only tools
  const toolContext: ToolContext = {
    cwd: projectDir,
    projectDir,
    specDir: join(projectDir, '.auto-claude', 'specs'),
    securityProfile: null as unknown as SecurityProfile,
    abortSignal,
  };

  // Bind tools via registry (insights agent gets Read, Glob, Grep)
  const registry = buildToolRegistry();
  const tools = registry.getToolsForAgent('insights', toolContext);

  // Create simple client with tools
  const client = await createSimpleClient({
    systemPrompt,
    modelShorthand,
    thinkingLevel,
    maxSteps: 30, // Allow sufficient turns for codebase exploration
    tools,
    queueConfig: buildInsightsSubscriptionQueueConfig(modelShorthand),
  });

  const toolCalls: ToolCallInfo[] = [];
  let responseText = '';
  let terminalStreamError: string | null = null;

  // Detect Codex models — they require instructions via providerOptions, not system
  const isCodexInsights = shouldUseOpenAIInstructions(client);

  for (let attempt = 0; attempt <= MAX_TRANSIENT_STREAM_RETRIES; attempt += 1) {
    if (attempt > 0) {
      await sleep(process.env.NODE_ENV === 'test' ? 0 : 750 * attempt);
    }

    const result = streamText({
      model: client.model,
      system: isCodexInsights ? undefined : client.systemPrompt,
      prompt: fullPrompt,
      tools: client.tools,
      stopWhen: stepCountIs(client.maxSteps),
      abortSignal,
      ...(isCodexInsights ? {
        providerOptions: {
          openai: {
            instructions: client.systemPrompt,
            store: false,
          },
        },
      } : {}),
    });

    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta': {
            responseText += part.text;
            onStream?.({ type: 'text-delta', text: part.text });
            break;
          }
          case 'tool-call': {
            const args = 'input' in part ? (part.input as Record<string, unknown>) : {};
            const input = extractToolInput(args);
            toolCalls.push({ name: part.toolName, input });
            onStream?.({ type: 'tool-start', name: part.toolName, input });
            break;
          }
          case 'tool-result': {
            onStream?.({ type: 'tool-end', name: part.toolName });
            break;
          }
          case 'error': {
            const errorMsg = formatInsightsError(part.error);
            terminalStreamError = errorMsg;
            throw new Error(errorMsg);
          }
        }
      }

      break;
    } catch (error) {
      const errorMsg = formatInsightsError(error);
      const canRetry = attempt < MAX_TRANSIENT_STREAM_RETRIES
        && responseText.length === 0
        && toolCalls.length === 0
        && isRetryableInsightsError(errorMsg);

      if (canRetry) {
        terminalStreamError = null;
        continue;
      }

      if (errorMsg !== terminalStreamError || !isRetryableInsightsError(errorMsg)) {
        onStream?.({ type: 'error', error: errorMsg });
      } else {
        onStream?.({ type: 'error', error: terminalStreamError });
      }
      throw error instanceof Error ? error : new Error(errorMsg);
    }
  }

  const taskSuggestion = extractTaskSuggestion(responseText);

  return {
    text: responseText,
    taskSuggestion,
    toolCalls,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extract a brief description from tool call args for UI display.
 */
function extractToolInput(args: Record<string, unknown>): string {
  if (args.pattern) return `pattern: ${args.pattern}`;
  if (args.file_path) {
    const fp = String(args.file_path);
    return fp.length > 50 ? `...${fp.slice(-47)}` : fp;
  }
  if (args.path) return String(args.path);
  return '';
}
