import type { Task } from '../../shared/types';
import { checkSubtasksCompletion } from '../task-plan-guards';

type PlanLike = Record<string, unknown> | null | undefined;

function taskHasCompletedSubtasks(task: Pick<Task, 'subtasks'>): boolean {
  const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
  return subtasks.length > 0 && subtasks.every((subtask) => subtask.status === 'completed');
}

function planHasCompletedHumanReviewSubtasks(plan: PlanLike): boolean {
  if (!plan) return false;
  if (plan.status !== 'human_review' || plan.reviewReason !== 'completed') return false;
  return checkSubtasksCompletion(plan).allCompleted;
}

export function canAutoMergeCompletedHumanReviewTask(
  task: Pick<Task, 'status' | 'reviewReason' | 'subtasks'>,
  persistedPlans: PlanLike[] = [],
): boolean {
  if (task.status !== 'human_review' || task.reviewReason !== 'completed') return false;
  if (taskHasCompletedSubtasks(task)) return true;
  return persistedPlans.some(planHasCompletedHumanReviewSubtasks);
}
