import type { ReactNode } from 'react';
import { Tabs as TabsPrimitive } from 'radix-ui';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from './button';

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'primary' | 'accent' | 'outline';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-2xs font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-subtle text-muted',
        tone === 'primary' && 'bg-primary-soft text-primary',
        tone === 'accent' && 'bg-accent-soft text-accent',
        tone === 'outline' && 'border border-line text-muted',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-primary-soft font-medium text-primary',
        size === 'sm' && 'size-5 text-2xs',
        size === 'md' && 'size-7 text-xs',
        size === 'lg' && 'size-10 text-sm',
      )}
    >
      {initials || '?'}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-sm bg-subtle', className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[4px] border border-line bg-subtle px-1 text-2xs font-medium text-muted">
      {children}
    </kbd>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon ? <div className="mb-3 text-faint [&_svg]:size-8">{icon}</div> : null}
      <p className="font-medium">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div role="alert" className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <AlertCircle className="mb-3 size-8 text-accent" />
      <p className="font-medium">This could not be loaded</p>
      <p className="mt-1 max-w-sm text-sm text-muted">{message}</p>
      {onRetry ? (
        <Button className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;
export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <TabsPrimitive.List className={cn('flex gap-1 border-b border-line', className)}>
      {children}
    </TabsPrimitive.List>
  );
}
export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted transition-colors hover:text-ink data-[state=active]:border-primary data-[state=active]:font-medium data-[state=active]:text-ink"
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="border-b border-line bg-surface px-4 pt-4 md:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** A bordered pane on the canvas. Used for grouping, not decoration. */
export function Pane({
  title,
  actions,
  children,
  className,
  padded = true,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={cn('rounded-md border border-line bg-surface', className)}>
      {title ? (
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}
