import type { ReactNode } from 'react';
import { DropdownMenu as M, Popover as P, Tooltip as T } from 'radix-ui';
import { cn } from '@/lib/cn';

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;

const panel = 'anim-pop z-50 min-w-44 rounded-md border border-line bg-surface p-1 shadow-xl';

export function MenuContent({
  children,
  align = 'end',
  className,
}: {
  children: ReactNode;
  align?: 'start' | 'end' | 'center';
  className?: string;
}) {
  return (
    <M.Portal>
      <M.Content align={align} sideOffset={4} className={cn(panel, className)}>
        {children}
      </M.Content>
    </M.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  danger,
  disabled,
}: {
  children: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <M.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover [&_svg]:size-4 [&_svg]:text-muted',
        danger && 'text-accent [&_svg]:text-accent',
      )}
    >
      {children}
    </M.Item>
  );
}

export const MenuSeparator = () => <M.Separator className="my-1 h-px bg-line" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <M.Label className="px-2 py-1 text-xs text-muted">{children}</M.Label>
);

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverClose = P.Close;
export function PopoverContent({
  children,
  className,
  align = 'start',
}: {
  children: ReactNode;
  className?: string;
  align?: 'start' | 'end' | 'center';
}) {
  return (
    <P.Portal>
      <P.Content align={align} sideOffset={4} className={cn(panel, 'p-3', className)}>
        {children}
      </P.Content>
    </P.Portal>
  );
}

export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <T.Root delayDuration={300}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={4}
          className="anim-fade z-50 rounded-sm bg-ink px-2 py-1 text-xs text-surface"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
export const TooltipProvider = T.Provider;
