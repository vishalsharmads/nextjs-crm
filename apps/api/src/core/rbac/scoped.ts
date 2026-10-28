import { SCOPED_RESOURCES } from '@app/shared';

/** Permission resources of module record types; registered with the type (avoids an import cycle). */
const moduleResources = new Set<string>();

export function registerScopedResource(resource: string) {
  moduleResources.add(resource);
}

/** Every resource with record scope (own/team/all): core, commercial modules and module record types. */
export function scopedResources(): string[] {
  return [
    ...SCOPED_RESOURCES,
    ...[...moduleResources].filter((r) => !(SCOPED_RESOURCES as readonly string[]).includes(r)),
  ];
}
