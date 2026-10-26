/**
 * The path the app is served under: '' on a client instance (served at the domain root), or e.g.
 * '/app' when the app shares a domain with another site (APP_BASE_PATH at build time).
 */
export const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

/** Absolute URL of an app page, for links that leave the router (new tabs, copyable URLs). */
export function appUrl(path: string): string {
  return `${window.location.origin}${basePath}${path}`;
}
