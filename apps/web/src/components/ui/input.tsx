import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/cn';

const control =
  'w-full rounded-sm border border-line bg-surface px-2.5 text-sm text-ink placeholder:text-faint transition-colors hover:border-line-strong focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-soft disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-accent';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(control, 'h-8', className)} {...props} />,
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(control, 'min-h-20 py-1.5 leading-relaxed', className)} {...props} />
  ),
);
Textarea.displayName = 'Textarea';

export const NativeSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select ref={ref} className={cn(control, 'h-8 pe-7', className)} {...props}>
      {children}
    </select>
  ),
);
NativeSelect.displayName = 'NativeSelect';

export function Label({
  htmlFor,
  children,
  required,
  className,
}: {
  htmlFor?: string;
  children: ReactNode;
  required?: boolean;
  className?: string;
}) {
  return (
    <label htmlFor={htmlFor} className={cn('text-xs font-medium text-muted', className)}>
      {children}
      {required ? <span className="text-accent"> *</span> : null}
    </label>
  );
}

/** Label + control + help/error, wired for screen readers. */
export function Field({
  label,
  error,
  help,
  required,
  children,
  className,
}: {
  label: ReactNode;
  error?: string;
  help?: ReactNode;
  required?: boolean;
  children: (props: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      {children({
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': error || help ? descId : undefined,
      })}
      {error ? (
        <p id={descId} className="text-xs text-accent" role="alert">
          {error}
        </p>
      ) : help ? (
        <p id={descId} className="text-xs text-faint">
          {help}
        </p>
      ) : null}
    </div>
  );
}
