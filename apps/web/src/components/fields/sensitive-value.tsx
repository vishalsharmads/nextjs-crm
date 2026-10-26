import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { SENSITIVE_MASK, type CustomFieldDef } from '@app/shared';
import { apiGet } from '@/lib/api';
import { useCan } from '@/app/session';
import { Button } from '@/components/ui/button';

/** Reveals hide again after this long, so a value is not left on screen. */
const SHOW_MS = 30_000;

/**
 * A sensitive (special) field: masked by default. People with `core.fields.reveal` can show it
 * for a moment; each reveal is written to the access log.
 */
export function SensitiveValue({ def, uuid, value }: { def: CustomFieldDef; uuid: string; value: unknown }) {
  const can = useCan();
  const [shown, setShown] = useState<string | null>(null);
  const reveal = useMutation({
    mutationFn: () =>
      apiGet<{ value: unknown }>('/custom-fields/reveal', { entity: def.entity, uuid, key: def.key }),
    onSuccess: (r) => setShown(r.value === null || r.value === undefined ? '' : String(r.value)),
  });
  useEffect(() => {
    if (shown === null) return;
    const t = window.setTimeout(() => setShown(null), SHOW_MS);
    return () => window.clearTimeout(t);
  }, [shown]);

  if (value !== SENSITIVE_MASK) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className={shown === null ? 'tracking-widest text-muted' : 'break-words whitespace-pre-line'}>
        {shown ?? SENSITIVE_MASK}
      </span>
      {can('core.fields.reveal') ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={shown === null ? `Reveal ${def.label}` : `Hide ${def.label}`}
          loading={reveal.isPending}
          onClick={(e) => {
            e.stopPropagation();
            if (shown === null) reveal.mutate();
            else setShown(null);
          }}
        >
          {shown === null ? <Eye /> : <EyeOff />}
        </Button>
      ) : null}
    </span>
  );
}
