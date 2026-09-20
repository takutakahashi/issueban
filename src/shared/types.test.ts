import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, issueColumn, resolveRepository, type Issue } from './types';

describe('board rules', () => {
  it('routes a matching issueban label and falls back to the first repository', () => {
    const settings = { ...DEFAULT_SETTINGS, repositories: ['acme/default'], routingRules: [{ id: '1', label: 'api', repository: 'acme/api' }] };
    expect(resolveRepository('API', settings)).toBe('acme/api');
    expect(resolveRepository('web', settings)).toBe('acme/default');
  });

  it('maps GitHub labels to a column', () => {
    const issue = { labels: [{ name: 'STATUS: REVIEW', color: 'fff' }] } as Issue;
    expect(issueColumn(issue, DEFAULT_SETTINGS)).toBe('review');
  });
});
