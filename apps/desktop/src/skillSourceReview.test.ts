import { describe, expect, it } from 'vitest';
import { sourceReviewBelongsToSkill } from './skillSourceReview';

describe('skill source review ownership', () => {
  it('only exposes a review for the skill that started it', () => {
    expect(sourceReviewBelongsToSkill('skill-a', 'skill-a')).toBe(true);
    expect(sourceReviewBelongsToSkill('skill-a', 'skill-b')).toBe(false);
    expect(sourceReviewBelongsToSkill('skill-a', null)).toBe(false);
    expect(sourceReviewBelongsToSkill(null, 'skill-a')).toBe(false);
  });
});
