import type { ProcessType } from '../agent';

export function processTypeCanEmitQaResult(processType: ProcessType): boolean {
  return processType === 'qa-process' || processType === 'task-execution';
}
