export function normalizeShellCommand(command: string): string {
  return command.replace(/\\\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripLeadingEnvAssignments(segment: string): string {
  return segment.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/,
    '',
  ).trim();
}

export function splitCommandSegments(command: string): string[] {
  return normalizeShellCommand(command)
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map(stripLeadingEnvAssignments)
    .filter(Boolean);
}

export function hasPassingTestEvidence(output: string): boolean {
  return /\b\d+\s+passed\b/i.test(output)
    || /Test Files\s+\d+\s+passed/i.test(output)
    || /Tests\s+\d+\s+passed/i.test(output);
}

export function looksLikeVerifierCommand(command: string): boolean {
  return splitCommandSegments(command).some((segment) => {
    if (/^(?:npx\s+)?(?:vitest|playwright|tsc|eslint|jest|pytest)\b/i.test(segment)) {
      return true;
    }
    if (/^cargo\s+test\b/i.test(segment) || /^go\s+test\b/i.test(segment)) {
      return true;
    }
    if (!/^(?:pnpm|npm|yarn|bun)\b/i.test(segment)) {
      return false;
    }

    return /\b(?:test[\w:-]*|build|typecheck|lint|check)\b/i.test(segment)
      || /\b(?:vitest|playwright|tsc|eslint|jest)\b/i.test(segment);
  });
}
