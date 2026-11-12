import { describe, expect, it } from 'vitest';
import { linkRecords, recordsIn } from '../../../modules/assistant/api/links';

const sub = '01a18d02-f326-739e-ace2-293234a24e75';
const org = '01a18d02-f2cd-726a-a1e3-057a02574b20';

describe('assistant record links', () => {
  it('finds records and the core records they link to in tool results', () => {
    const result = JSON.stringify({
      data: [{ uuid: sub, name: 'Tidewater – trial', organization: { uuid: org, name: 'Tidewater Retail' } }],
    });
    expect(recordsIn(result, 'subscription')).toEqual([
      { entity: 'subscription', uuid: sub, name: 'Tidewater – trial' },
      { entity: 'organization', uuid: org, name: 'Tidewater Retail' },
    ]);
    expect(
      recordsIn(JSON.stringify({ results: [{ type: 'contact', uuid: sub, title: 'Ann Lee' }] }), undefined),
    ).toEqual([{ entity: 'contact', uuid: sub, name: 'Ann Lee' }]);
    expect(recordsIn('not json', 'deal')).toEqual([]);
  });

  it('links the first mention of each name, longest first, and leaves links and code alone', () => {
    const refs = [
      { entity: 'organization', uuid: org, name: 'Tidewater Retail' },
      { entity: 'subscription', uuid: sub, name: 'Tidewater Retail – trial' },
    ];
    expect(
      linkRecords('Tidewater Retail – trial belongs to Tidewater Retail. Tidewater Retail again.', refs),
    ).toBe(
      `[Tidewater Retail – trial](record:subscription/${sub}) belongs to [Tidewater Retail](record:organization/${org}). Tidewater Retail again.`,
    );
    const already = `[Tidewater Retail](record:organization/${org}) and \`Tidewater Retail\``;
    expect(linkRecords(already, refs)).toBe(already);
  });
});
