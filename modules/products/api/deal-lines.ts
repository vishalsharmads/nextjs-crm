import { z } from 'zod';
import { documentTotals, lineItemInput } from '@app/shared';
import {
  AppError,
  assertCan,
  audit,
  db,
  defineRoutes,
  getRow,
  loadLines,
  recordDefs,
  saveLines,
  updateRecord,
  type Db,
  type LineInput,
} from '@app/api/module-api';

export const DEAL_LINES = 'm_products_deal_lines';
const PRODUCTS = 'm_products_products';

async function resolveProducts(lines: z.output<typeof lineItemInput>[], conn: Db): Promise<LineInput[]> {
  const uuids = [...new Set(lines.map((l) => l.productUuid).filter((u): u is string => !!u))];
  const found = uuids.length ? await conn(PRODUCTS).whereIn('uuid', uuids).select('id', 'uuid') : [];
  const ids = new Map(found.map((p) => [p.uuid as string, p.id as number]));
  return lines.map((l, i) => {
    if (l.productUuid && !ids.has(l.productUuid))
      throw new AppError('VALIDATION_FAILED', 'Unknown product', [
        { path: `lines.${i}.productUuid`, message: 'Not found' },
      ]);
    return { ...l, productId: l.productUuid ? ids.get(l.productUuid)! : null };
  });
}

const dealParam = z.object({ uuid: z.uuid() });

/**
 * Line items on a deal. Reading needs the deal (in scope) and the catalog; changing them needs
 * permission to update the deal. Totals are computed here, never trusted from the client.
 */
export const dealLinesRoutes = defineRoutes('/m/products/deals', ['products'], 'products')
  .add({
    method: 'get',
    path: '/:uuid/lines',
    permission: 'products.products.view',
    params: dealParam,
    handler: async ({ user, params }) => {
      assertCan(user, `${recordDefs.deal.resource}.view`);
      const deal = await getRow(recordDefs.deal, user, params.uuid);
      const lines = (await loadLines(DEAL_LINES, 'deal_id', [deal.id], PRODUCTS)).get(deal.id) ?? [];
      return { lines, totals: documentTotals(lines), currency: deal.currency, dealValue: Number(deal.value) };
    },
  })
  .add({
    method: 'put',
    path: '/:uuid/lines',
    permission: 'products.products.view',
    params: dealParam,
    body: z.object({
      lines: z.array(lineItemInput).max(200),
      /** Also set the deal's value to the lines' total. */
      applyToValue: z.boolean().default(false),
    }),
    handler: async ({ ctx, user, params, body }) => {
      assertCan(user, `${recordDefs.deal.resource}.update`);
      const deal = await getRow(recordDefs.deal, user, params.uuid);
      const resolved = await resolveProducts(body.lines, db);
      // Set the value first, through the deal service (validated, audited, emitted): if it is
      // refused, nothing has changed yet.
      if (body.applyToValue)
        await updateRecord(recordDefs.deal, ctx, user, deal.uuid, { value: documentTotals(resolved).total });
      const totals = await db.transaction(async (trx) => {
        // Lock the deal so two saves cannot interleave their delete and insert.
        await getRow(recordDefs.deal, user, params.uuid, trx, { forUpdate: true });
        const t = await saveLines(trx, DEAL_LINES, 'deal_id', deal.id, resolved);
        await audit(trx, ctx, {
          action: 'products.deal_lines.updated',
          entity: 'deal',
          entityId: deal.id,
          entityUuid: deal.uuid,
          diff: { lines: body.lines.length, total: t.total },
        });
        return t;
      });
      const lines = (await loadLines(DEAL_LINES, 'deal_id', [deal.id], PRODUCTS)).get(deal.id) ?? [];
      const fresh = await db('deals').where({ id: deal.id }).first('value');
      return { lines, totals, currency: deal.currency, dealValue: Number(fresh.value) };
    },
  });
