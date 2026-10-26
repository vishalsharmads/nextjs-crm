import type { ReactNode } from 'react';
import { relativeLuminance } from '@app/shared';
import { useBranding } from '@/app/branding';
import { cn } from '@/lib/cn';

/** Cards per column of the board motif; the accent card is the first card of column 2. */
const BOARD = [4, 5, 2, 4, 3];
const MOVER = { column: 2, card: 0 };

/**
 * An abstract pipeline board drawn in the brand's own colors: faded cards in the panel's text color (current
 * color) and
 * one accent card that moves into its column once on load. Decoration only.
 */
function BoardMotif({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none grid grid-cols-5 items-start gap-3 [--board-gap:0.75rem]',
        className,
      )}
    >
      {BOARD.map((cards, column) => (
        <div key={column} className="flex flex-col gap-3 rounded-lg bg-current/[0.06] p-3">
          <div className="mb-1 h-2 w-1/2 rounded-full bg-current/20" />
          {Array.from({ length: cards }, (_, card) => {
            const mover = column === MOVER.column && card === MOVER.card;
            return (
              <div
                key={card}
                className={cn(
                  'flex h-20 flex-col justify-between rounded-md p-3',
                  mover ? 'bg-accent shadow-lg' : 'bg-current/[0.09]',
                  mover && 'anim-board-move',
                )}
              >
                <div
                  className={cn('h-1.5 w-3/4 rounded-full', mover ? 'bg-accent-fg/70' : 'bg-current/25')}
                />
                <div
                  className={cn('h-1.5 w-1/3 rounded-full', mover ? 'bg-accent-fg/45' : 'bg-current/15')}
                />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * The logo made for the panel's background: in dark mode the panel is a deep brand tint, in light mode the
 * primary color decides. A logo made for the other kind of background is not shown (the name is instead).
 */
function useBrandMark() {
  const { branding, mode } = useBranding();
  const dark =
    mode === 'dark' ||
    (mode === 'system' &&
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const onDark = dark || relativeLuminance(branding.colors.light.primary) < 0.35;
  return onDark ? branding.assets.logoDark : branding.assets.logoLight;
}

function Wordmark({ className, hideName }: { className?: string; hideName?: boolean }) {
  const { branding } = useBranding();
  const logo = useBrandMark();
  if (!logo && hideName) return null;
  return logo ? (
    <img src={logo} alt={branding.appName} className={cn('max-w-48 object-contain object-left', className)} />
  ) : (
    <span className="text-lg font-semibold tracking-tight">{branding.appName}</span>
  );
}

/** Tints a login photo with the panel color behind the text, fading out so the photo shows. */
function PhotoTint() {
  return (
    <div
      aria-hidden
      className="absolute inset-0 bg-linear-to-br from-primary/90 via-primary/60 to-primary/5 dark:from-canvas/95 dark:via-canvas/70 dark:to-canvas/10"
    />
  );
}

/** Branded sign-in frame: everything visible comes from branding settings. */
export function AuthLayout({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const { branding } = useBranding();
  const bg = branding.assets.loginBackground;
  const headline = branding.loginTitle || branding.appName;
  const tagline = branding.loginTagline || branding.tagline;
  const photo = bg
    ? { backgroundImage: `url(${bg})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : undefined;

  return (
    <div className="grid min-h-dvh bg-surface lg:grid-cols-[minmax(0,1fr)_minmax(440px,36rem)]">
      {/* Brand panel (wide screens): the workspace's name, tagline and colors. */}
      <aside
        className="relative hidden flex-col overflow-hidden p-12 lg:flex xl:p-16 bg-primary text-primary-fg dark:bg-[color-mix(in_oklch,var(--primary)_28%,var(--canvas))] dark:text-ink"
        style={photo}
      >
        {bg ? <PhotoTint /> : null}
        <div className="relative min-h-9">
          <Wordmark className="h-9" hideName={headline === branding.appName} />
        </div>
        <div className="relative mt-[12vh] max-w-xl">
          <p className="text-[clamp(2.5rem,4.4vw,4.5rem)] leading-[1.02] font-semibold tracking-[-0.03em] text-balance">
            {headline}
          </p>
          {tagline ? <p className="mt-5 max-w-md text-lg leading-relaxed opacity-80">{tagline}</p> : null}
        </div>
        {/* In the flow under the text, so a long title or tagline pushes it down instead of overlapping. */}
        {bg ? null : (
          <div className="relative -me-12 -mb-12 mt-14 min-h-48 flex-1 xl:-me-16 xl:-mb-16">
            <BoardMotif className="absolute start-0 top-0 w-[min(1040px,125%)] opacity-90" />
          </div>
        )}
      </aside>

      <main className="flex min-h-dvh flex-col lg:min-h-0">
        {/* Brand band (small screens). */}
        <header
          className="relative overflow-hidden px-6 pt-8 pb-9 sm:px-10 lg:hidden bg-primary text-primary-fg dark:bg-[color-mix(in_oklch,var(--primary)_28%,var(--canvas))] dark:text-ink"
          style={photo}
        >
          {bg ? <PhotoTint /> : null}
          <div className="relative">
            <Wordmark className="h-7" hideName={headline === branding.appName} />
            <p className="mt-5 max-w-[16ch] text-3xl leading-tight font-semibold tracking-tight text-balance">
              {headline}
            </p>
            {tagline ? <p className="mt-2 max-w-sm text-sm opacity-80">{tagline}</p> : null}
          </div>
        </header>

        <div className="flex flex-1 flex-col px-6 sm:px-10 lg:px-14">
          <div className="mx-auto my-auto w-full max-w-sm py-10 lg:py-16">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {description ? <p className="mt-2 text-sm leading-relaxed text-muted">{description}</p> : null}
            <div className="mt-8">{children}</div>
          </div>
          {branding.footerText ? (
            <footer className="mx-auto w-full max-w-sm pb-8 text-xs text-faint">{branding.footerText}</footer>
          ) : null}
        </div>
      </main>
    </div>
  );
}
