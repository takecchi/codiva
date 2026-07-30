import { describe, expect, it } from 'vitest';
import { normalizePlanName, sameAccountSummary, toAccountSummary } from './account';

describe('toAccountSummary', () => {
  it('parses a real accountInfo() payload (Team account)', () => {
    // Captured verbatim from a real probe (see docs/TECH_NOTES.md), email redacted.
    expect(
      toAccountSummary({
        email: 'someone@example.com',
        organization: 'Example Inc',
        subscriptionType: 'Claude Team',
        apiProvider: 'firstParty',
      }),
    ).toEqual({ plan: 'Claude Team', organization: 'Example Inc', apiProvider: 'firstParty' });
  });

  it('title-cases the lowercase spelling the usage endpoint uses', () => {
    expect(toAccountSummary({ subscriptionType: 'team' })?.plan).toBe('Team');
  });

  it.each([
    ['nothing displayable', { email: 'someone@example.com' }],
    ['blank fields', { subscriptionType: '   ', organization: '' }],
    ['non-object', 'nope'],
    ['null', null],
    ['undefined', undefined],
  ])('returns undefined for %s', (_label, json) => {
    expect(toAccountSummary(json)).toBeUndefined();
  });

  it('keeps the provider alone when there is no plan (API-key login)', () => {
    expect(toAccountSummary({ apiProvider: 'bedrock' })).toEqual({
      plan: undefined,
      organization: undefined,
      apiProvider: 'bedrock',
    });
  });

  it('ignores non-string fields instead of rendering them', () => {
    expect(toAccountSummary({ subscriptionType: 7, organization: { name: 'x' } })).toBeUndefined();
  });
});

describe('normalizePlanName', () => {
  it.each([
    ['team', 'Team'],
    ['max_5x', 'Max 5x'],
    ['Claude Team', 'Claude Team'],
    ['  pro  ', 'Pro'],
    ['Claude  Max', 'Claude Max'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizePlanName(raw)).toBe(expected);
  });
});

describe('sameAccountSummary', () => {
  const summary = { plan: 'Claude Team', organization: 'Example Inc', apiProvider: 'firstParty' };
  it.each([
    ['identical values', summary, { ...summary }, true],
    ['both undefined', undefined, undefined, true],
    ['one undefined', summary, undefined, false],
    ['different plan', summary, { ...summary, plan: 'Claude Max' }, false],
    ['different org', summary, { ...summary, organization: 'Other' }, false],
    ['different provider', summary, { ...summary, apiProvider: 'bedrock' }, false],
  ])('%s → %s', (_label, a, b, expected) => {
    expect(sameAccountSummary(a, b)).toBe(expected);
  });
});
