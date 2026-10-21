import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PublicBranding } from '@app/shared';
import { apiGet } from '@/lib/api';
import { applyBranding, type ColorMode } from '@/theme/apply';
import { FACTORY_THEME } from '@/theme/defaults';

interface BrandingContextValue {
  branding: PublicBranding;
  loaded: boolean;
  mode: ColorMode;
  setMode: (mode: ColorMode) => void;
  /** Temporarily render with unsaved branding (admin live preview). Pass null to stop. */
  preview: (b: PublicBranding | null) => void;
}

const FALLBACK: PublicBranding = {
  ...FACTORY_THEME,
  assets: {},
  locale: 'en',
  installed: true,
  demoLogin: null,
};
const BrandingContext = createContext<BrandingContextValue | null>(null);
const MODE_KEY = 'ui.colorMode';

function readMode(): ColorMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const query = useQuery({
    queryKey: ['public', 'branding'],
    queryFn: () => apiGet<PublicBranding>('/public/branding'),
    staleTime: 60_000,
  });
  const [mode, setModeState] = useState<ColorMode>(readMode);
  const [previewing, setPreviewing] = useState<PublicBranding | null>(null);
  const branding = previewing ?? query.data ?? FALLBACK;

  useEffect(() => {
    applyBranding(branding, mode);
    if (mode !== 'system') return;
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => applyBranding(branding, mode);
    mq?.addEventListener('change', onChange);
    return () => mq?.removeEventListener('change', onChange);
  }, [branding, mode]);

  const setMode = useCallback((m: ColorMode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* storage unavailable: keep in memory */
    }
  }, []);

  const value = useMemo(
    () => ({ branding, loaded: query.isSuccess, mode, setMode, preview: setPreviewing }),
    [branding, query.isSuccess, mode, setMode],
  );
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding() {
  const ctx = useContext(BrandingContext);
  if (!ctx) throw new Error('useBranding outside BrandingProvider');
  return ctx;
}
