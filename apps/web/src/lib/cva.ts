/** Tiny class-variance helper (avoids a dependency for ~20 lines). */
type Variants = Record<string, Record<string, string>>;
type Config<V extends Variants> = { variants: V; defaultVariants?: { [K in keyof V]?: keyof V[K] } };
export type VariantProps<F> = F extends (props?: infer P) => string ? NonNullable<P> : never;

export function cva<V extends Variants>(base: string, config: Config<V>) {
  return (props: { [K in keyof V]?: keyof V[K] | null } = {}) => {
    const classes = [base];
    for (const key of Object.keys(config.variants) as (keyof V)[]) {
      const value = (props[key] ?? config.defaultVariants?.[key]) as string | undefined;
      if (value !== undefined) classes.push(config.variants[key]![value] ?? '');
    }
    return classes.join(' ');
  };
}
