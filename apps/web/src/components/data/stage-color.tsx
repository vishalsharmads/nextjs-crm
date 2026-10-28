import type { CSSProperties } from 'react';
import { stageColor } from '@app/shared';
import { cn } from '@/lib/cn';

/**
 * Exposes a stage's color as `--sc` (solid) and `--sc-fg` (readable text on it). Pair with the `bg-(--sc)`,
 * `text-(--sc-fg)` and `stage-soft` classes so the color always comes from the theme's stage tokens.
 */
export function stageStyle(color: string | null | undefined): CSSProperties {
  const key = stageColor(color);
  return { '--sc': `var(--stage-${key})`, '--sc-fg': `var(--stage-${key}-fg)` } as CSSProperties;
}

export function StageDot({ color, className }: { color: string | null | undefined; className?: string }) {
  return (
    <span
      aria-hidden="true"
      style={stageStyle(color)}
      className={cn('inline-block size-2 shrink-0 rounded-full bg-(--sc)', className)}
    />
  );
}

/** A stage name with its color: used in list cells, the peek sheet and search results. */
export function StageBadge({
  name,
  color,
  className,
}: {
  name: string;
  color: string | null | undefined;
  className?: string;
}) {
  return (
    <span
      style={stageStyle(color)}
      className={cn(
        'stage-soft inline-flex h-5 items-center gap-1.5 rounded-sm px-1.5 text-2xs font-medium whitespace-nowrap text-ink',
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-(--sc)" />
      {name}
    </span>
  );
}
