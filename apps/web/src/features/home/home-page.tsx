import { useEffect } from 'react';
import { useBoot, useT } from '@/app/session';
import { useBranding } from '@/app/branding';
import { setDocumentTitle } from '@/theme/apply';
import { PageHeader } from '@/components/ui/misc';

export function HomePage() {
  const { me } = useBoot();
  const t = useT();
  const { branding } = useBranding();
  useEffect(() => setDocumentTitle(t('nav.home'), branding.appName), [t, branding.appName]);
  return <PageHeader title={t('home.greeting', { name: me.firstName || me.email })} />;
}
