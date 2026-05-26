import type { Task } from '../../shared/types';
import { checkSubtasksCompletion } from '../task-plan-guards';

type PlanLike = Record<string, unknown> | null | undefined;

function taskHasCompletedSubtasks(task: Pick<Task, 'subtasks'>): boolean {
  const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
  return subtasks.length > 0 && subtasks.every((subtask) => subtask.status === 'completed');
}

function planHasCompletedHumanReviewSubtasks(plan: PlanLike): boolean {
  if (!plan) return false;
  if (plan.human_feedback_pending !== undefined) return false;
  if (plan.status !== 'human_review' || plan.reviewReason !== 'completed') return false;
  return checkSubtasksCompletion(plan).allCompleted;
}

function planHasIncompleteSubtasks(plan: PlanLike): boolean {
  if (!plan) return false;
  const counts = checkSubtasksCompletion(plan);
  return counts.totalCount > 0 && !counts.allCompleted;
}

export function canAutoMergeCompletedHumanReviewTask(
  task: Pick<Task, 'status' | 'reviewReason' | 'subtasks'>,
  persistedPlans: PlanLike[] = [],
): boolean {
  if (task.status !== 'human_review' || task.reviewReason !== 'completed') return false;
  if (persistedPlans.some(planHasIncompleteSubtasks)) return false;
  if (persistedPlans.length > 0) return persistedPlans.some(planHasCompletedHumanReviewSubtasks);
  if (taskHasCompletedSubtasks(task)) return true;
  return false;
}

export function canAutoMergeCompletedHumanReviewPlans(persistedPlans: PlanLike[]): boolean {
  if (persistedPlans.length === 0) return false;
  if (persistedPlans.some(planHasIncompleteSubtasks)) return false;
  return persistedPlans.some(planHasCompletedHumanReviewSubtasks);
}
