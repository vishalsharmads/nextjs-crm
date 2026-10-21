import { Button } from '@/components/ui/button';
import type { EntityConfig } from './entities';

/** Selection bar. Bulk actions arrive in milestone 1c. */
export function BulkBar({
  selected,
  onClear,
}: {
  config: EntityConfig;
  selected: Set<string>;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-line bg-primary-soft px-4 py-1.5 text-sm md:px-6">
      <span className="font-medium">{selected.size} selected</span>
      <Button size="sm" variant="ghost" onClick={onClear}>
        Clear selection
      </Button>
    </div>
  );
}
