/** Keeps an async source review attached to the skill it was requested for. */
export function sourceReviewBelongsToSkill(
  reviewSkillId: string | null,
  selectedSkillId: string | null,
): boolean {
  return Boolean(reviewSkillId && selectedSkillId && reviewSkillId === selectedSkillId);
}
