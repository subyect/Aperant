/**
 * Subtask Prompt Generator
 * ========================
 *
 * Generates minimal, focused prompts for each subtask and planner invocation.
 * See apps/desktop/src/main/ai/prompts/subtask-prompt-generator.ts for the TypeScript implementation.
 *
 * Instead of a 900-line mega-prompt, each subtask gets a tailored ~100-line
 * prompt with only the context it needs. This reduces token usage by ~80%
 * and keeps the agent focused on ONE task.
 */

import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { loadPrompt } from './prompt-loader';
import { normalizeQaFailureEvidenceContent, normalizeQaFixRequestFileSync } from '../../qa-feedback-utils';
import type {
  PlannerPromptConfig,
  SubtaskPromptConfig,
  SubtaskContext,
  SubtaskPromptInfo,
} from './types';

// =============================================================================
// Worktree Detection
// =============================================================================

/** Patterns to detect worktree isolation */
const WORKTREE_PATH_PATTERNS = [
  /[/\\]\.auto-claude[/\\]worktrees[/\\]tasks[/\\]/,
  /[/\\]\.auto-claude[/\\]github[/\\]pr[/\\]worktrees[/\\]/,
  /[/\\]\.worktrees[/\\]/,
];

/**
 * Detect if the project dir is inside an isolated git worktree.
 *
 * @returns Tuple [isWorktree, parentProjectPath]
 */
function detectWorktreeIsolation(projectDir: string): [boolean, string | null] {
  const resolved = resolve(projectDir);

  for (const pattern of WORKTREE_PATH_PATTERNS) {
    const match = pattern.exec(resolved);
    if (match) {
      const parentPath = resolved.slice(0, match.index);
      return [true, parentPath || '/'];
    }
  }

  return [false, null];
}

function readHumanFeedback(specDir: string): string | null {
  const feedbackPath = join(specDir, 'QA_FIX_REQUEST.md');
  if (!existsSync(feedbackPath)) return null;

  try {
    const fallbackFailureContent = readFailedQaReportContent(specDir);
    normalizeQaFixRequestFileSync(feedbackPath, { fallbackFailureContent });
    const content = readFileSync(feedbackPath, 'utf-8').trim();
    const normalized = normalizeQaFailureEvidenceContent(content, fallbackFailureContent);
    return normalized || null;
  } catch {
    return null;
  }
}

function readFailedQaReportContent(specDir: string): string | null {
  try {
    const content = readFileSync(join(specDir, 'qa_report.md'), 'utf-8');
    const match = content.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:Status|Final Status|Result)\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(FAILED|FAIL|REJECTED|ISSUES|ESCALATED|MAX ITERATIONS REACHED)\s*(?:\*\*)?/i);
    return match ? content : null;
  } catch {
    return null;
  }
}

const YECT_CONSOLE_ROUTE_SMOKE_COMMAND =
  'DEBUG=pw:webserver LAYER1_CONSOLE_E2E_PORT=$((3200 + $$ % 1000)) LAYER1_CONSOLE_DATA_MODE=fixture LAYER1_CONSOLE_AUTH_DISABLED=true pnpm --filter @yect/layer1-console exec playwright test tests/e2e/console-routes.spec.ts --project=desktop --reporter=list --workers=1 --timeout=30000';

function needsYectConsoleRouteSmokeGuidance(
  subtask: SubtaskPromptInfo,
  humanFeedback: string | null,
): boolean {
  const haystack = [
    subtask.description,
    subtask.notes,
    subtask.lastError,
    typeof subtask.verification?.run === 'string' ? subtask.verification.run : '',
    typeof subtask.verification?.command === 'string' ? subtask.verification.command : '',
    humanFeedback,
  ].filter(Boolean).join('\n');

  return /console-routes(?:\.spec\.ts)?|pnpm\s+test:e2e/i.test(haystack);
}

/**
 * Generate the worktree isolation warning section for prompts.
 * Mirrors generate_worktree_isolation_warning() from Python.
 */
export function generateWorktreeIsolationWarning(
  projectDir: string,
  parentProjectPath: string,
): string {
  return (
    `## ISOLATED WORKTREE - CRITICAL\n\n` +
    `You are in an **ISOLATED GIT WORKTREE** - a complete copy of the project for safe development.\n\n` +
    `**YOUR LOCATION:** \`${projectDir}\`\n` +
    `**FORBIDDEN PATH:** \`${parentProjectPath}\`\n\n` +
    `### Rules:\n` +
    `1. **NEVER** use \`cd ${parentProjectPath}\` or any path starting with \`${parentProjectPath}\`\n` +
    `2. **NEVER** use absolute paths that reference the parent project\n` +
    `3. **ALL** project files exist HERE via relative paths\n\n` +
    `### Why This Matters:\n` +
    `- Git commits made in the parent project go to the WRONG branch\n` +
    `- File changes in the parent project escape isolation\n` +
    `- This defeats the entire purpose of safe, isolated development\n\n` +
    `### Correct Usage:\n` +
    `\`\`\`bash\n` +
    `# CORRECT - Use relative paths from your worktree\n` +
    `./prod/src/file.ts\n` +
    `./apps/desktop/src/component.tsx\n\n` +
    `# WRONG - These escape isolation!\n` +
    `cd ${parentProjectPath}\n` +
    `${parentProjectPath}/prod/src/file.ts\n` +
    `\`\`\`\n\n` +
    `If you see absolute paths in spec.md or context.json that reference \`${parentProjectPath}\`,\n` +
    `convert them to relative paths from YOUR current location.\n\n` +
    `---\n\n`
  );
}

// =============================================================================
// Environment Context
// =============================================================================

/**
 * Get the spec directory path relative to the project directory.
 */
function getRelativeSpecPath(specDir: string, projectDir: string): string {
  const resolvedSpec = resolve(specDir);
  const resolvedProject = resolve(projectDir);

  if (resolvedSpec.startsWith(resolvedProject)) {
    const relative = resolvedSpec.slice(resolvedProject.length + 1);
    return `./${relative}`;
  }

  // Fallback: just use the spec dir name
  const parts = resolvedSpec.split(/[/\\]/);
  return `./auto-claude/specs/${parts[parts.length - 1]}`;
}

/**
 * Generate the environment context header for prompts.
 * Mirrors generate_environment_context() from Python.
 */
function generateEnvironmentContext(projectDir: string, specDir: string): string {
  const relativeSpec = getRelativeSpecPath(specDir, projectDir);
  const [isWorktree, parentProjectPath] = detectWorktreeIsolation(projectDir);

  const sections: string[] = [];

  if (isWorktree && parentProjectPath) {
    sections.push(generateWorktreeIsolationWarning(projectDir, parentProjectPath));
  }

  sections.push(
    `## YOUR ENVIRONMENT\n\n` +
    `**Working Directory:** \`${projectDir}\`\n` +
    `**Spec Location:** \`${relativeSpec}/\`\n` +
    `${isWorktree ? '**Isolation Mode:** WORKTREE (changes are isolated from main project)\n' : ''}` +
    `\n` +
    `Your filesystem is restricted to your working directory. All file paths should be\n` +
    `relative to this location. Do NOT use absolute paths.\n\n` +
    `**CRITICAL:** Before ANY git command or file operation, run \`pwd\` to verify your current\n` +
    `directory. If you've used \`cd\` to change directories, you MUST use paths relative to your\n` +
    `NEW location, not the working directory.\n\n` +
    `**Important Files:**\n` +
    `- Spec: \`${relativeSpec}/spec.md\`\n` +
    `- Plan: \`${relativeSpec}/implementation_plan.json\`\n` +
    `- Progress: \`${relativeSpec}/build-progress.txt\`\n` +
    `- Context: \`${relativeSpec}/context.json\`\n\n` +
    `---\n\n`
  );

  return sections.join('');
}

// =============================================================================
// Planner Prompt Generator
// =============================================================================

/**
 * Generate the planner prompt (used once at start of planning phase).
 * Mirrors generate_planner_prompt() from Python.
 *
 * @param config - Planner prompt configuration
 * @returns Assembled planner prompt
 */
export async function generatePlannerPrompt(config: PlannerPromptConfig): Promise<string> {
  const { specDir, projectDir, projectInstructions, planningRetryContext } = config;

  // Load base prompt from planner.md
  const basePlannerPrompt = loadPrompt('planner');

  const relativeSpec = getRelativeSpecPath(specDir, projectDir);
  const sections: string[] = [];

  // 1. Environment context (worktree isolation + location info)
  sections.push(generateEnvironmentContext(projectDir, specDir));

  // 2. Spec location header with critical write instructions
  sections.push(
    `## SPEC LOCATION\n\n` +
    `Your spec file is located at: \`${relativeSpec}/spec.md\`\n\n` +
    `Store all build artifacts in this spec directory:\n` +
    `- \`${relativeSpec}/implementation_plan.json\` - Subtask-based implementation plan\n` +
    `- \`${relativeSpec}/build-progress.txt\` - Progress notes\n` +
    `- \`${relativeSpec}/init.sh\` - Environment setup script\n\n` +
    `The project root is your current working directory. Implement code in the project root,\n` +
    `not in the spec directory.\n\n` +
    `---\n\n`
  );

  // 3. Project instructions injection
  if (projectInstructions) {
    sections.push(
      `## PROJECT INSTRUCTIONS\n\n` +
      `${projectInstructions}\n\n` +
      `---\n\n`
    );
  }

  // 4. Planning retry context (if replanning after validation failure)
  if (planningRetryContext) {
    sections.push(planningRetryContext + '\n\n---\n\n');
  }

  // 5. Base planner prompt
  sections.push(basePlannerPrompt);

  return sections.join('');
}

// =============================================================================
// Subtask Prompt Generator
// =============================================================================

/**
 * Generate a minimal, focused prompt for implementing a single subtask.
 * Mirrors generate_subtask_prompt() from Python.
 *
 * @param config - Subtask prompt configuration
 * @returns Focused subtask prompt (~100 lines instead of 900)
 */
export async function generateSubtaskPrompt(config: SubtaskPromptConfig): Promise<string> {
  const {
    specDir,
    projectDir,
    subtask,
    phase,
    attemptCount = 0,
    recoveryHints,
    projectInstructions,
  } = config;

  const sections: string[] = [];

  // 1. Environment context
  sections.push(generateEnvironmentContext(projectDir, specDir));

  // 2. Header
  sections.push(
    `# Subtask Implementation Task\n\n` +
    `**Subtask ID:** \`${subtask.id}\`\n` +
    `**Phase:** ${phase?.name ?? subtask.phaseName ?? 'Implementation'}\n` +
    `**Service:** ${subtask.service ?? 'all'}\n\n` +
    `## Description\n\n` +
    `${subtask.description}\n`
  );
  if (subtask.notes) {
    sections.push(
      `\n## Persisted Subtask Notes\n\n` +
      `${subtask.notes}\n`
    );
  }

  // 3. Retry context
  if (attemptCount > 0) {
    sections.push(
      `\n## RETRY ATTEMPT (${attemptCount + 1})\n\n` +
      `This subtask has been attempted ${attemptCount} time(s) before without success.\n` +
      `You MUST use a DIFFERENT approach than previous attempts.\n`
    );
    if (subtask.lastError) {
      sections.push(
        `**Last recorded issue:**\n` +
        `${subtask.lastError}\n`
      );
    }
    if (subtask.lastAttemptOutcome) {
      sections.push(`**Last agent outcome:** ${subtask.lastAttemptOutcome}\n`);
    }
    if (
      subtask.lastAttemptOutcome === 'completed' &&
      subtask.lastError?.includes('without marking the subtask completed')
    ) {
      sections.push(
        `\nThe previous agent said the work was complete, but the plan still shows this subtask as unfinished. ` +
        `First verify the current code and tests. If the subtask is actually complete, call ` +
        `\`mcp__auto-claude__update_subtask_status\` for ONLY subtask \`${subtask.id}\` with status ` +
        `\`"completed"\`, then record the verification evidence in build-progress.txt. ` +
        `If it is not complete, finish the missing implementation before updating the plan. ` +
        `If the prior assistant message called repo-local import failures, failed tests, or workspace package resolution a blocker or "outside scope", do not repeat that conclusion; fix those repo-local failures as the next implementation work. ` +
        `Do not end with only a narrative summary, handoff note, or blocker note unless you have first proved that the blocker cannot be fixed inside this worktree.\n`
      );
    }
    if (
      subtask.lastError?.includes('Bash verification command stalled')
      || subtask.lastError?.includes('Bash verification command timed out')
      || subtask.lastError?.includes('Bash verification command was rejected')
    ) {
      sections.push(
        `\nThe previous attempt lost time on a verification command that stalled or timed out. ` +
        `Do NOT rerun that same command unchanged. Use a narrower command, add verbose/line output, ` +
        `inspect logs, or verify the specific touched module with a faster targeted check. ` +
        `Only mark the subtask completed after a passing check or concrete evidence that the stalled command is not the right verifier.\n`
      );
    }
    if (
      subtask.lastError?.includes('Bash command failed during the attempt')
      || subtask.lastError?.includes('latest Bash verification failed')
    ) {
      sections.push(
        `\nThe previous attempt hit a real failing verification command. Do NOT start by rerunning the same command and stopping again. ` +
        `First inspect the failure output, map every repo-local file/module/test named in the error back to the current source tree, and make the required implementation, test, or docs changes. ` +
        `If the error is a local TypeScript/module resolution failure (for example TS2307, "Cannot find module", or "Does the file exist?"), treat it as in-scope repair unless you prove the referenced module is intentionally external. ` +
        `Do not declare required verifier failures "outside this subtask" merely because they involve shared packages, generated dist, broad test imports, or multiple repo-local modules. ` +
        `If the verifier is required for this subtask and it fails on repo-local code or workspace package resolution, restore the repo-local contract needed for the verifier to pass. ` +
        `After changing the code, run the narrowest targeted verifier that proves the fix, then update this exact subtask.\n`
      );
    }
    if (recoveryHints && recoveryHints.length > 0) {
      sections.push('**Previous attempt insights:**');
      for (const hint of recoveryHints) {
        sections.push(`- ${hint}`);
      }
      sections.push('');
    }
  }

  const humanFeedback = readHumanFeedback(specDir);
  if (needsYectConsoleRouteSmokeGuidance(subtask, humanFeedback)) {
    sections.push(
      `\n## APERANT-SAFE ROUTE SMOKE VERIFICATION\n\n` +
      `For Yect layer1-console console-routes checks, do NOT use \`pnpm test:e2e\` wrappers, \`--reporter=line\`, or the default port 3124. ` +
      `Those forms have caused silent watchdog loops and stale dev-server collisions.\n\n` +
      `Use this verifier instead:\n` +
      `\`\`\`bash\n${YECT_CONSOLE_ROUTE_SMOKE_COMMAND}\n\`\`\`\n` +
      `If this verifier fails or times out, inspect the emitted \`pw:webserver\` output and record the concrete blocker in build-progress.txt before changing strategy.\n`
    );
  }
  if (humanFeedback) {
    sections.push(
      `\n## HUMAN REVIEW FEEDBACK\n\n` +
      `The user rejected a previous result. Treat this feedback as mandatory context while completing the current subtask. ` +
      `Do not ignore it just because QA has not run yet.\n\n` +
      `${humanFeedback}\n`
    );
  }
  if (isAperantRecoverySubtask(subtask.id)) {
    sections.push(
      `\n## APERANT RECOVERY SUBTASK\n\n` +
      `This subtask exists because the workflow already failed once. The failure text is the implementation target, not a reason to stop. ` +
      `Read QA_FIX_REQUEST.md, qa_report.md, implementation_plan.json, and the current git diff before acting. ` +
      `Do not complete this subtask after only reading files or rerunning the same failing command. ` +
      `If verification exposes repo-local failures such as unresolved imports, failed assertions, TypeScript errors, stale generated files, or missing workspace packages, fix those failures in this worktree immediately. ` +
      `Package-resolution, typecheck, test-harness, and generated-dist failures inside this repository are in scope for this recovery subtask even when the original subtask was narrower. ` +
      `Do not ask whether to proceed and do not end with "if you want, I can fix this"; you are already authorized to fix reachable repo-local blockers. ` +
      `Complete it only after the reported blocker is fixed or a concrete externally-owned blocker is recorded in build-progress.txt; externally-owned means credentials, network, or a remote service, not local repository code.\n`
    );
  }

  // 4. Files section
  sections.push('## Files\n');

  if (subtask.filesToModify && subtask.filesToModify.length > 0) {
    sections.push('**Files to Modify:**');
    for (const f of subtask.filesToModify) {
      sections.push(`- \`${f}\``);
    }
    sections.push('');
  }

  if (subtask.filesToCreate && subtask.filesToCreate.length > 0) {
    sections.push('**Files to Create:**');
    for (const f of subtask.filesToCreate) {
      sections.push(`- \`${f}\``);
    }
    sections.push('');
  }

  if (subtask.patternsFrom && subtask.patternsFrom.length > 0) {
    sections.push('**Pattern Files (study these first):**');
    for (const f of subtask.patternsFrom) {
      sections.push(`- \`${f}\``);
    }
    sections.push('');
  }

  // 5. Verification
  sections.push('## Verification\n');
  const verification = subtask.verification;

  if (verification?.type === 'command') {
    const command = verification.command ?? verification.run ?? 'echo "No command specified"';
    sections.push(
      `Run this command to verify:\n` +
      `\`\`\`bash\n${command}\n\`\`\`\n` +
      `Expected: ${verification.expected ?? 'Success'}\n`
    );
  } else if (verification?.type === 'api') {
    const method = verification.method ?? 'GET';
    const url = verification.url ?? 'http://localhost';
    const body = verification.body;
    sections.push(
      `Test the API endpoint:\n` +
      `\`\`\`bash\n` +
      `curl -X ${method} ${url} -H "Content-Type: application/json"` +
      `${body ? ` -d '${JSON.stringify(body)}'` : ''}\n` +
      `\`\`\`\n` +
      `Expected status: ${verification.expected_status ?? 200}\n`
    );
  } else if (verification?.type === 'browser') {
    const url = verification.url ?? 'http://localhost:3000';
    const checks = verification.checks ?? [];
    sections.push(`Open in browser: ${url}\n\nVerify:`);
    for (const check of checks) {
      sections.push(`- [ ] ${check}`);
    }
    sections.push('');
  } else if (verification?.type === 'e2e') {
    const steps = verification.steps ?? [];
    sections.push('End-to-end verification steps:');
    steps.forEach((step, i) => sections.push(`${i + 1}. ${step}`));
    sections.push('');
  } else {
    const instructions = verification?.instructions ?? 'Manual verification required';
    sections.push(`**Manual Verification:**\n${instructions}\n`);
  }

  // 6. Instructions
  sections.push(
    `## Instructions\n\n` +
    `You are already authorized to complete this subtask. Do not ask the user for confirmation and do not stop with an offer to continue.\n\n` +
    `1. **Read the pattern files** to understand code style and conventions\n` +
    `2. **Read the files to modify** (if any) to understand current implementation\n` +
    `3. **Implement the subtask** following the patterns exactly\n` +
    `4. **Run verification** and fix any issues\n` +
    `5. **Update the plan** - after implementation and verification are complete, call \`mcp__auto-claude__update_subtask_status\` for ONLY this subtask with status \`"completed"\`. If that tool is unavailable, edit implementation_plan.json directly and set ONLY this subtask's status to "completed".\n\n` +
    `## Quality Checklist\n\n` +
    `Before marking complete, verify:\n` +
    `- [ ] Follows patterns from reference files\n` +
    `- [ ] Project files were changed as needed, or the existing implementation was verified with concrete evidence\n` +
    `- [ ] No console.log/print debugging statements\n` +
    `- [ ] Error handling in place\n` +
    `- [ ] Verification passes\n` +
    `- [ ] implementation_plan.json only marks this exact subtask complete\n\n` +
    `## Important\n\n` +
    `- Focus ONLY on this subtask - don't modify unrelated code\n` +
    `- Do not mark the subtask complete just because you read files or found a previous attempt\n` +
    `- If the work is already implemented, run targeted verification and record the evidence in build-progress.txt before marking complete\n` +
    `- Do not end your response until you have either updated this subtask status to "completed" or documented a concrete blocker in build-progress.txt\n` +
    `- Never ask whether to proceed to the next step; execute the current subtask to completion\n` +
    `- If verification fails, fix repository-local blockers before marking complete; do not call local imports, package exports, type errors, or test failures out of scope\n` +
    `- If you encounter a blocker, document it in build-progress.txt\n`
  );

  // 7. Project instructions injection
  if (projectInstructions) {
    sections.push(
      `\n## PROJECT INSTRUCTIONS\n\n` +
      `${projectInstructions}\n`
    );
  }

  // 8. Load file context (patterns + files_to_modify) and append
  try {
    const context = await loadSubtaskContext(specDir, projectDir, subtask);
    const contextStr = formatContextForPrompt(context);
    if (contextStr) {
      sections.push(`\n${contextStr}`);
    }
  } catch {
    // Non-fatal: context loading is best-effort
  }

  return sections.join('\n');
}

function isAperantRecoverySubtask(subtaskId: string): boolean {
  return subtaskId === 'aperant-qa-report-failure'
    || subtaskId === 'aperant-base-sync-conflict'
    || subtaskId === 'aperant-human-feedback-rework';
}

// =============================================================================
// Subtask Context Loader
// =============================================================================

/**
 * Load minimal file context needed for a subtask.
 * Mirrors load_subtask_context() from Python.
 *
 * @param specDir - Spec directory
 * @param projectDir - Project root
 * @param subtask - Subtask definition
 * @param maxFileLines - Maximum lines to include per file (default: 200)
 * @returns Loaded context dict
 */
export async function loadSubtaskContext(
  specDir: string,
  projectDir: string,
  subtask: SubtaskPromptInfo,
  maxFileLines = 200,
): Promise<SubtaskContext> {
  const context: SubtaskContext = {
    patterns: {},
    filesToModify: {},
    specExcerpt: null,
  };

  // Load pattern files
  for (const patternPath of (subtask.patternsFrom ?? [])) {
    const fullPath = join(projectDir, patternPath);
    const validPath = validateAndResolvePath(fullPath, projectDir);
    if (!validPath) continue;

    try {
      const content = await readFileTruncated(validPath, maxFileLines);
      context.patterns[patternPath] = content;
    } catch {
      context.patterns[patternPath] = '(Could not read file)';
    }
  }

  // Load files to modify
  for (const filePath of (subtask.filesToModify ?? [])) {
    const fullPath = join(projectDir, filePath);

    // Try fuzzy correction if file doesn't exist
    const resolvedPath = existsSync(fullPath)
      ? fullPath
      : await fuzzyFindFile(projectDir, filePath);

    if (!resolvedPath) continue;

    const validPath = validateAndResolvePath(resolvedPath, projectDir);
    if (!validPath) continue;

    try {
      const content = await readFileTruncated(validPath, maxFileLines);
      context.filesToModify[filePath] = content;
    } catch {
      context.filesToModify[filePath] = '(Could not read file)';
    }
  }

  return context;
}

/**
 * Format loaded context into prompt sections.
 * Mirrors format_context_for_prompt() from Python.
 */
function formatContextForPrompt(context: SubtaskContext): string {
  const sections: string[] = [];

  if (Object.keys(context.patterns).length > 0) {
    sections.push('## Reference Files (Patterns to Follow)\n');
    for (const [path, content] of Object.entries(context.patterns)) {
      sections.push(`### \`${path}\`\n\`\`\`\n${content}\n\`\`\`\n`);
    }
  }

  if (Object.keys(context.filesToModify).length > 0) {
    sections.push('## Current File Contents (To Modify)\n');
    for (const [path, content] of Object.entries(context.filesToModify)) {
      sections.push(`### \`${path}\`\n\`\`\`\n${content}\n\`\`\`\n`);
    }
  }

  return sections.join('\n');
}

// =============================================================================
// File Utilities
// =============================================================================

/**
 * Read a file, truncating if it exceeds maxLines.
 */
async function readFileTruncated(filePath: string, maxLines: number): Promise<string> {
  const raw = await readFile(filePath, 'utf-8');
  const lines = raw.split('\n');

  if (lines.length <= maxLines) {
    return raw;
  }

  return (
    lines.slice(0, maxLines).join('\n') +
    `\n\n... (truncated, ${lines.length - maxLines} more lines)`
  );
}

/**
 * Validate that a path stays within the project root (path traversal guard).
 * Returns the resolved path if safe, null otherwise.
 */
function validateAndResolvePath(filePath: string, projectRoot: string): string | null {
  const resolved = resolve(filePath);
  const root = resolve(projectRoot);
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

/**
 * Fuzzy file finder with similarity cutoff of 0.6.
 * If a referenced file doesn't exist, try to find the closest match.
 *
 * @param projectDir - Project root to search within
 * @param targetPath - Relative path that doesn't exist
 * @returns Best matching file path, or null if no close match
 */
async function fuzzyFindFile(
  projectDir: string,
  targetPath: string,
): Promise<string | null> {
  try {
    // Get the target filename for comparison
    const targetParts = targetPath.replace(/\\/g, '/').split('/');
    const targetFilename = targetParts[targetParts.length - 1];

    // Build a list of candidate files (limited search for performance)
    const candidates = collectFiles(projectDir, 5000);

    let bestMatch: string | null = null;
    let bestScore = 0.6; // Minimum similarity threshold

    for (const candidate of candidates) {
      const score = stringSimilarity(targetFilename, candidate.name);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidate.path;
      }
    }

    return bestMatch;
  } catch {
    return null;
  }
}

/**
 * Collect files from a directory (breadth-first, limited count).
 */
function collectFiles(
  dir: string,
  maxCount: number,
): Array<{ name: string; path: string }> {
  const results: Array<{ name: string; path: string }> = [];
  const skipDirs = new Set([
    'node_modules', '.git', '__pycache__', '.venv', 'venv',
    'dist', 'build', 'out', '.cache',
  ]);

  function walk(currentDir: string, depth: number): void {
    if (results.length >= maxCount || depth > 8) return;

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as typeof import('node:fs');
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        if (results.length >= maxCount) break;

        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name) && !entry.name.startsWith('.')) {
            walk(join(currentDir, entry.name), depth + 1);
          }
        } else if (entry.isFile()) {
          results.push({
            name: entry.name,
            path: join(currentDir, entry.name),
          });
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  walk(dir, 0);
  return results;
}

/**
 * Compute string similarity between two strings (simple ratio).
 * Returns a value between 0 and 1.
 */
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();

  if (aLower === bLower) return 0.99;

  // Check if one contains the other
  if (bLower.includes(aLower)) return 0.8;
  if (aLower.includes(bLower)) return 0.7;

  // Levenshtein distance-based similarity
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  const distance = levenshteinDistance(aLower, bLower);
  return 1 - distance / maxLen;
}

/**
 * Compute Levenshtein edit distance between two strings.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Use a flat array for the DP table
  const dp = new Array<number>((m + 1) * (n + 1)).fill(0);

  for (let i = 0; i <= m; i++) dp[i * (n + 1)] = i;
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i * (n + 1) + j] = dp[(i - 1) * (n + 1) + (j - 1)];
      } else {
        dp[i * (n + 1) + j] = 1 + Math.min(
          dp[(i - 1) * (n + 1) + j],
          dp[i * (n + 1) + (j - 1)],
          dp[(i - 1) * (n + 1) + (j - 1)],
        );
      }
    }
  }

  return dp[m * (n + 1) + n];
}
