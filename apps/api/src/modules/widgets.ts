import type { AuthUser } from '../http/context';

type WidgetFn = (params: Record<string, unknown>, user: AuthUser) => Promise<unknown>;
const widgets = new Map<string, WidgetFn>();

/** Modules register dashboard widget data providers as `<moduleKey>.<name>`. */
export function registerModuleWidget(type: string, fn: WidgetFn) {
  widgets.set(type, fn);
}

export async function moduleWidget(
  type: string,
  params: Record<string, unknown>,
  user: AuthUser,
): Promise<unknown> {
  const fn = widgets.get(type);
  return fn ? fn(params, user) : { unavailable: true, reason: 'module_not_available' };
}
