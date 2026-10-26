/**
 * Spreadsheet apps run cells that start with = + - @ (or a tab or carriage return) as formulas.
 * Prefix them with an apostrophe so exported text stays text.
 */
export function csvSafe(value: unknown): unknown {
  return typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
