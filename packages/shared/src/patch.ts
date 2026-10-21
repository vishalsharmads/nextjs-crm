import { z } from 'zod';

type Undefaulted<T> = T extends z.ZodDefault<infer Inner> ? Undefaulted<Inner> : T;
export type PatchShape<T extends z.ZodRawShape> = { [K in keyof T]: z.ZodOptional<Undefaulted<T[K]>> };

/**
 * PATCH body from a create schema: every field optional and **no defaults**.
 * Zod's `.partial()` keeps `.default()`, so a one-field PATCH would silently reset every
 * defaulted field (a cleared last name, a deal value of 0, a team with no members). Always use this.
 */
export function toPatch<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodObject<PatchShape<T>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    let t = field as z.ZodType;
    while (t instanceof z.ZodDefault) t = t.unwrap() as z.ZodType;
    shape[key] = t.optional();
  }
  return z.object(shape) as unknown as z.ZodObject<PatchShape<T>>;
}
