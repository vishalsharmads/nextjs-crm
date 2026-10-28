import { useState } from 'react';
import type { DealDto } from '@app/shared';
import { useBoot } from '@/app/session';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ListSelect } from '@/components/fields/pickers';

/** Asks why a deal was lost. Used wherever a deal can be moved to a lost stage. */
export function LostReasonDialog({
  deal,
  onCancel,
  onConfirm,
}: {
  deal: Pick<DealDto, 'title'>;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const boot = useBoot();
  const [reason, setReason] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        title={`Why was “${deal.title}” lost?`}
        description="Knowing why helps you see patterns later."
        footer={
          <>
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant="primary" disabled={!reason} onClick={() => reason && onConfirm(reason)}>
              Mark as lost
            </Button>
          </>
        }
      >
        <ListSelect
          value={reason}
          onChange={setReason}
          options={boot.settings.deals.lostReasons}
          placeholder="Choose a reason"
        />
      </DialogContent>
    </Dialog>
  );
}
