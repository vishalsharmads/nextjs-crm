import { describe, expect, it } from 'vitest';
import { documentTotals, lineTotals, subtractMoney } from './commerce';

describe('commerce math', () => {
  it('rounds per line and sums lines exactly', () => {
    expect(lineTotals({ quantity: 3, unitPrice: 0.1, taxRate: 20 })).toEqual({
      subtotal: 0.3,
      discount: 0,
      net: 0.3,
      tax: 0.06,
      total: 0.36,
    });
    const t = documentTotals([
      { quantity: 1, unitPrice: 99.99, discountPct: 10, taxRate: 20 },
      { quantity: 2.5, unitPrice: 40, taxRate: 5 },
      { quantity: 1, unitPrice: 15 },
    ]);
    expect(t).toEqual({
      subtotal: 214.99,
      discount: 10,
      tax: 23,
      total: 227.99,
      taxes: [
        { rate: 5, net: 100, tax: 5 },
        { rate: 20, net: 89.99, tax: 18 },
      ],
    });
  });

  it('handles credits and balances without float drift', () => {
    expect(lineTotals({ quantity: 1, unitPrice: -10.005, taxRate: 10 }).total).toBe(-11.01);
    expect(subtractMoney(0.3, 0.1)).toBe(0.2);
  });
});
