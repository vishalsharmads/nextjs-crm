import { useState } from 'react';
import { useLocation } from 'react-router';
import { ENTITY_ROUTE, recordTypePath } from '@app/shared';
import { useBoot } from '@/app/session';
import { basePath } from '@/lib/app-url';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/dialog';
import { ModulePanel } from '@/modules/loader';
import { moduleIcon } from './nav';

const UUID = /^[0-9a-f-]{36}$/;

/** The record on screen, if any: `/deals/<uuid>`, `/o/<object>/<uuid>`, `/m/<module>/<route>/<uuid>`. */
function useRecordOnScreen(): { entity: string; uuid: string } {
  const { pathname } = useLocation();
  const boot = useBoot();
  const path = (
    basePath && pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname
  ).replace(/^\//, '');
  const parts = path.split('/');
  const uuid = parts.at(-1) ?? '';
  if (!UUID.test(uuid)) return { entity: '', uuid: '' };
  const base = parts.slice(0, -1).join('/');
  const core = Object.entries(ENTITY_ROUTE).find(([, route]) => route === base)?.[0];
  if (core) return { entity: core, uuid };
  const type = boot.recordTypes.find((t) => recordTypePath(t) === base);
  return type ? { entity: type.entity, uuid } : { entity: '', uuid: '' };
}

/** Top-bar buttons for module side panels (for example the assistant), each in a sheet. */
export function ShellPanels() {
  const boot = useBoot();
  const panels = boot.modules.shellPanels ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const context = useRecordOnScreen();
  if (!panels.length) return null;
  const active = panels.find((p) => `${p.moduleKey}.${p.key}` === open);
  return (
    <>
      {panels.map((p) => {
        const Icon = moduleIcon(p.icon);
        return (
          <Button
            key={`${p.moduleKey}.${p.key}`}
            variant="ghost"
            size="icon"
            aria-label={p.title}
            title={p.title}
            onClick={() => setOpen(`${p.moduleKey}.${p.key}`)}
          >
            <Icon />
          </Button>
        );
      })}
      {active ? (
        <Sheet open onOpenChange={(o) => !o && setOpen(null)} title={active.title} width="max-w-lg">
          <div className="flex min-h-0 flex-1 flex-col p-4">
            <ModulePanel
              moduleKey={active.moduleKey}
              panelKey={active.key}
              entity={context.entity}
              uuid={context.uuid}
            />
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
