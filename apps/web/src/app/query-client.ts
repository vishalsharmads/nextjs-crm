import { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
    mutations: {
      onError: (err) => {
        // Field-level validation errors are shown inline by forms; everything else gets a toast.
        if (
          err instanceof ApiError &&
          err.code === 'VALIDATION_FAILED' &&
          Object.keys(err.fieldErrors()).length
        )
          return;
        toast.error(err instanceof Error ? err.message : 'Something went wrong');
      },
    },
  },
});
