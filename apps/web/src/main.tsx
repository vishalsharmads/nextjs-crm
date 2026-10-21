import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import './i18n';
import './styles.css';
import { queryClient } from '@/app/query-client';
import { BrandingProvider } from '@/app/branding';
import { SessionProvider } from '@/app/session';
import { TooltipProvider } from '@/components/ui/menu';
import { router } from '@/app/router';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrandingProvider>
        <SessionProvider>
          <TooltipProvider>
            <RouterProvider router={router} />
            <Toaster position="bottom-right" closeButton toastOptions={{ className: 'text-sm' }} />
          </TooltipProvider>
        </SessionProvider>
      </BrandingProvider>
    </QueryClientProvider>
  </StrictMode>,
);
