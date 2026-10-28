import { describe, expect, it } from 'vitest';
import { isEmptyHtml, needsSourceView, unwrapMergeFields, wrapMergeFields } from './html';

describe('needsSourceView', () => {
  it('keeps simple formatting and placeholders in the visual editor', () => {
    expect(
      needsSourceView('<p>Hi <strong>{{contact.firstName}}</strong></p><ul><li>a</li></ul>', 'basic'),
    ).toBe(false);
    expect(
      needsSourceView('<p><a href="https://x.test" target="_blank" rel="noopener">x</a></p>', 'basic'),
    ).toBe(false);
  });

  it('opens block helpers, placeholders in attributes, classes and unknown tags as HTML', () => {
    expect(needsSourceView('{{#if deal}}<p>x</p>{{/if}}', 'basic')).toBe(true);
    expect(needsSourceView('<p>{{else}}</p>', 'basic')).toBe(true);
    expect(needsSourceView('<a href="{{link}}">Go</a>', 'basic')).toBe(true);
    expect(needsSourceView('<a class="button" href="https://x.test">Go</a>', 'basic')).toBe(true);
    expect(needsSourceView('<div>x</div>', 'basic')).toBe(true);
  });

  it('allows tables and page breaks only in documents', () => {
    const table = '<table><tbody><tr><td colspan="2">x</td></tr></tbody></table><hr data-page-break="">';
    expect(needsSourceView(table, 'document')).toBe(false);
    expect(needsSourceView(table, 'basic')).toBe(true);
  });
});

describe('merge fields', () => {
  it('wraps placeholders in text but not in attributes, and unwraps them back', () => {
    const html = '<p>Dear {{ contact.firstName }}, see <a href="https://x.test/{{id}}">this</a></p>';
    const wrapped = wrapMergeFields(html);
    expect(wrapped).toContain('<span data-merge-field="contact.firstName">{{contact.firstName}}</span>');
    expect(wrapped).toContain('href="https://x.test/{{id}}"');
    expect(unwrapMergeFields(wrapped)).toBe(
      '<p>Dear {{contact.firstName}}, see <a href="https://x.test/{{id}}">this</a></p>',
    );
  });

  it('unwraps chips the editor renders with extra attributes', () => {
    expect(
      unwrapMergeFields('<p><span data-merge-field="deal.title" class="rte-merge">{{deal.title}}</span></p>'),
    ).toBe('<p>{{deal.title}}</p>');
  });
});

describe('isEmptyHtml', () => {
  it('treats empty paragraphs as empty', () => {
    expect(isEmptyHtml('<p></p>')).toBe(true);
    expect(isEmptyHtml('<p><br></p>')).toBe(true);
    expect(isEmptyHtml('<p>x</p>')).toBe(false);
  });
});
