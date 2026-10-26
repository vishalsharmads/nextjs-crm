import type { DealDto } from '@app/shared';
import { apiPatch } from '@/lib/api';

export interface StageMove {
  uuid: string;
  stageUuid: string;
  beforeUuid?: string;
  afterUuid?: string;
  lostReason?: string;
}

/** The one call that moves a deal between stages; the board and the record page both use it. */
export const patchDealStage = (v: StageMove) => apiPatch<DealDto>(`/deals/${v.uuid}/stage`, v);
