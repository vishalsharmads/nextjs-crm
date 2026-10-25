import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useBoot, useT, bootstrapKey } from '@/app/session';
import { apiPost } from '@/lib/api';
import { idleMs, markActive } from '@/lib/activity';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';

const WARN_MS = 60_000;

/** Compliance automatic logoff: warn a minute before the workspace idle limit, then sign out. */
export function IdleTimeout() {
  const t = useT();
  const { settings } = useBoot();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const limitMs = settings.session.idleTimeoutMinutes * 60_000;
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!limitMs) return;
    let done = false;
    const tick = () => {
      const remaining = limitMs - idleMs();
      if (remaining <= 0 && !done) {
        done = true;
        void apiPost('/auth/logout')
          .catch(() => undefined)
          .finally(() => {
            qc.setQueryData(bootstrapKey, null);
            qc.clear();
            navigate('/login?reason=idle');
          });
      }
      setLeft(remaining <= Math.min(WARN_MS, limitMs / 2) ? Math.max(0, remaining) : null);
    };
    tick();
    const id = window.setInterval(tick, 1_000);
    return () => window.clearInterval(id);
  }, [limitMs, navigate, qc]);

  const stay = () => {
    markActive();
    setLeft(null);
  };

  return (
    <Dialog open={left !== null} onOpenChange={(open) => !open && stay()}>
      <DialogContent
        title={t('idle.title')}
        description={t('idle.body', { seconds: Math.ceil((left ?? 0) / 1000) })}
        footer={
          <>
            <Button
              onClick={() => {
                markActive();
                void apiPost('/auth/logout').finally(() => {
                  qc.setQueryData(bootstrapKey, null);
                  qc.clear();
                  navigate('/login');
                });
              }}
            >
              {t('idle.signOut')}
            </Button>
            <Button variant="primary" onClick={stay} autoFocus>
              {t('idle.stay')}
            </Button>
          </>
        }
      />
    </Dialog>
  );
}
