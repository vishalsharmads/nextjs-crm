import type { CoreEntity, FilterCondition } from '@app/shared';
import type { EntityConfig } from './entities';

/** Saved views as tabs. Implemented in milestone 1c. */
export function ViewTabs(_props: {
  entity: CoreEntity;
  config: EntityConfig;
  activeView: string | null;
  onSelect: (uuid: string | null) => void;
  conditions: FilterCondition[];
  sort?: string;
  columns: string[];
  onApplyColumns: (ids: string[]) => void;
}) {
  return <div className="h-2" />;
}
