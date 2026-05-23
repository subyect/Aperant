/**
 * Ideation Runner
 * ===============
 *
 * AI-powered idea generation using Vercel AI SDK.
 * See apps/desktop/src/main/ai/runners/ideation.ts for the TypeScript implementation.
 *
 * Uses `createSimpleClient()` with read-only tools and streaming to generate
 * ideas of different types: code improvements, UI/UX, documentation, security,
 * performance, and code quality.
 */

import { streamText, stepCountIs } from 'ai';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createSimpleClient } from '../client/factory';
import { shouldUseOpenAIInstructions } from '../providers/openai-instructions';
import { buildToolRegistry } from '../tools/build-registry';
import type { ToolContext } from '../tools/types';
import type { ModelShorthand, ThinkingLevel } from '../config/types';
import type { SecurityProfile } from '../security/bash-validator';
import {
  filterIdeationTypeFileAgainstExistingTasks,
  getIdeationIdeasFromTypeData,
  getIdeationTypeOutputFileName,
  writeIdeationContextFile,
} from '../../ipc-handlers/ideation/file-utils';
import { safeParseJson } from '../../utils/json-repair';

// =============================================================================
// Constants
// =============================================================================

/** Supported ideation types */
export const IDEATION_TYPES = [
  'code_improvements',
  'ui_ux_improvements',
  'documentation_gaps',
  'security_hardening',
  'performance_optimizations',
  'code_quality',
] as const;

export type IdeationType = (typeof IDEATION_TYPES)[number];

/** Human-readable labels for ideation types */
export const IDEATION_TYPE_LABELS: Record<IdeationType, string> = {
  code_improvements: 'Code Improvements',
  ui_ux_improvements: 'UI/UX Improvements',
  documentation_gaps: 'Documentation Gaps',
  security_hardening: 'Security Hardening',
  performance_optimizations: 'Performance Optimizations',
  code_quality: 'Code Quality & Refactoring',
};

/** Prompt file mapping per ideation type */
const IDEATION_TYPE_PROMPTS: Record<IdeationType, string> = {
  code_improvements: 'ideation_code_improvements.md',
  ui_ux_improvements: 'ideation_ui_ux.md',
  documentation_gaps: 'ideation_documentation.md',
  security_hardening: 'ideation_security.md',
  performance_optimizations: 'ideation_performance.md',
  code_quality: 'ideation_code_quality.md',
};

// =============================================================================
// Types
// =============================================================================

/** Configuration for running ideation */
export interface IdeationConfig {
  /** Project directory path */
  projectDir: string;
  /** Output directory for results */
  outputDir: string;
  /** Prompts directory containing ideation prompt files */
  promptsDir: string;
  /** Type of ideation to run */
  ideationType: IdeationType;
  /** Model shorthand (defaults to 'sonnet') */
  modelShorthand?: ModelShorthand;
  /** Thinking level (defaults to 'medium') */
  thinkingLevel?: ThinkingLevel;
  /** Maximum ideas per type (defaults to 5) */
  maxIdeasPerType?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

/** Result of an ideation run */
export interface IdeationResult {
  /** Whether the run succeeded */
  success: boolean;
  /** Full response text from the agent */
  text: string;
  /** Error message if failed */
  error?: string;
  /** Output file containing generated ideas */
  outputFile?: string;
}

/** Callback for streaming events from the ideation runner */
export type IdeationStreamCallback = (event: IdeationStreamEvent) => void;

/** Events emitted during ideation streaming */
export type IdeationStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-use'; name: string }
  | { type: 'error'; error: string };

// =============================================================================
// Ideation Runner
// =============================================================================

/**
 * Run an ideation agent for a specific ideation type.
 *
 * Loads the appropriate prompt, creates a simple client with read-only tools,
 * and streams the response. Mirrors Python's `IdeationGenerator.run_agent()`.
 *
 * @param config - Ideation configuration
 * @param onStream - Optional callback for streaming events
 * @returns Ideation result
 */
export async function runIdeation(
  config: IdeationConfig,
  onStream?: IdeationStreamCallback,
): Promise<IdeationResult> {
  const {
    projectDir,
    outputDir,
    promptsDir,
    ideationType,
    modelShorthand = 'sonnet',
    thinkingLevel = 'medium',
    maxIdeasPerType = 5,
    abortSignal,
  } = config;

  // Load prompt file
  const promptFile = IDEATION_TYPE_PROMPTS[ideationType];
  const promptPath = join(promptsDir, promptFile);

  if (!existsSync(promptPath)) {
    return {
      success: false,
      text: '',
      error: `Prompt not found: ${promptPath}`,
    };
  }

  let prompt: string;
  try {
    prompt = readFileSync(promptPath, 'utf-8');
  } catch (error) {
    return {
      success: false,
      text: '',
      error: `Failed to read prompt: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

	  // Add context to prompt (matches Python format)
	  prompt += `\n\n---\n\n**Output Directory**: ${outputDir}\n`;
	  prompt += `**Project Directory**: ${projectDir}\n`;
	  prompt += `**Max Ideas**: ${maxIdeasPerType}\n`;
	  const outputFile = join(outputDir, getIdeationTypeOutputFileName(ideationType));
	  const ideationContextFile = writeIdeationContextFile(projectDir, outputDir);
	  const startedAtMs = Date.now();
	  prompt += `**Ideation Context File**: ${ideationContextFile || 'not available'}\n`;
	  prompt += `**Required Output File**: ${outputFile}\n`;
	  prompt += `\nDo not suggest ideas that already exist in the ideation context or current task/spec backlog. Write valid JSON to the required output file with a top-level "${ideationType}" array.\n`;

  // Create tool context for read-only tools
  const toolContext: ToolContext = {
    cwd: projectDir,
    projectDir,
    specDir: join(projectDir, '.auto-claude', 'specs'),
    securityProfile: null as unknown as SecurityProfile,
    abortSignal,
  };

  // Bind read-only tools + Write for output
  const registry = buildToolRegistry();
  const tools = registry.getToolsForAgent('ideation', toolContext);

  // Create simple client
  const client = await createSimpleClient({
    systemPrompt: '',
    modelShorthand,
    thinkingLevel,
    maxSteps: 30,
    tools,
  });

  let responseText = '';

  // Detect Codex models — they require instructions via providerOptions, not system
  const modelId = typeof client.model === 'string' ? client.model : client.model.modelId;
  const isCodex = shouldUseOpenAIInstructions(client);
  const userPrompt = `Analyze the project at ${projectDir} and generate up to ${maxIdeasPerType} ${ideationType.replace(/_/g, ' ')} ideas. Use the available tools to explore the codebase, then write your findings as a JSON file to the output directory.`;

  try {
    const result = streamText({
      model: client.model,
      system: isCodex ? undefined : prompt,
      prompt: userPrompt,
      tools: client.tools,
      stopWhen: stepCountIs(client.maxSteps),
      abortSignal,
      ...(isCodex ? {
        providerOptions: {
          openai: {
            instructions: prompt,
            store: false,
          },
        },
      } : {}),
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta': {
          responseText += part.text;
          onStream?.({ type: 'text-delta', text: part.text });
          break;
        }
        case 'tool-call': {
          onStream?.({ type: 'tool-use', name: part.toolName });
          break;
        }
        case 'error': {
          const errorMsg =
            part.error instanceof Error ? part.error.message : String(part.error);
          onStream?.({ type: 'error', error: errorMsg });
          break;
        }
      }
    }

	    const validation = validateIdeationTypeOutput(outputFile, ideationType, startedAtMs);
	    if (!validation.valid) {
	      return {
	        success: false,
	        text: responseText,
	        error: validation.error,
	        outputFile,
	      };
	    }
	    filterIdeationTypeFileAgainstExistingTasks(projectDir, outputFile, ideationType);
	    return {
	      success: true,
	      text: responseText,
	      outputFile,
	    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    onStream?.({ type: 'error', error: errorMsg });
    return {
      success: false,
      text: responseText,
      error: errorMsg,
    };
  }
}

function validateIdeationTypeOutput(outputFile: string, ideationType: IdeationType, minMtimeMs: number): { valid: true } | { valid: false; error: string } {
  if (!existsSync(outputFile)) {
    return { valid: false, error: `Missing ideas output file: ${outputFile}` };
  }
  try {
    const stat = statSync(outputFile);
    if (stat.mtimeMs + 2000 < minMtimeMs) {
      return { valid: false, error: `Ideas output was not refreshed: ${outputFile}` };
    }
    const data = safeParseJson<Record<string, unknown>>(readFileSync(outputFile, 'utf-8'));
    if (!data) {
      return { valid: false, error: `Invalid JSON in ideas output file: ${outputFile}` };
    }
    const ideas = getIdeationIdeasFromTypeData(data, ideationType);
    if (ideas.length === 0) {
      return { valid: false, error: `No ideas generated for ${ideationType} in ${outputFile}` };
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, error: `Failed to validate ideas output file ${outputFile}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
