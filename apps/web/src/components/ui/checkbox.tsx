import { Checkbox as C, Switch as S } from 'radix-ui';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/cn';

export function Checkbox({
  checked,
  onCheckedChange,
  className,
  ...props
}: {
  checked: boolean | 'indeterminate';
  onCheckedChange: (v: boolean) => void;
  className?: string;
  'aria-label'?: string;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <C.Root
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-line-strong bg-surface data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary text-primary-fg',
        className,
      )}
      {...props}
    >
      <C.Indicator>
        {checked === 'indeterminate' ? <Minus className="size-3" /> : <Check className="size-3" />}
      </C.Indicator>
    </C.Root>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  ...props
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  id?: string;
  'aria-label'?: string;
  disabled?: boolean;
}) {
  return (
    <S.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      className="relative h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors data-[state=checked]:bg-primary disabled:opacity-50"
      {...props}
    >
      <S.Thumb className="block size-4 translate-x-0.5 rounded-full bg-surface shadow transition-transform data-[state=checked]:translate-x-[18px] rtl:data-[state=checked]:-translate-x-[18px] rtl:-translate-x-0.5" />
    </S.Root>
  );
}
