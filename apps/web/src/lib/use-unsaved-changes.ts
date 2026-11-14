import { useEffect, useLayoutEffect, useRef } from 'react';
import { useBlocker } from 'react-router';
import { confirmAction } from '@/components/ui/confirm';

/**
 * Ask before leaving a page with unsaved changes: in-app navigation shows the app's dialog,
 * closing or reloading the tab shows the browser's own prompt.
 */
export function useUnsavedChanges(dirty: boolean) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  // The blocker object changes on every render; ask once per blocked navigation, act on the latest.
  const latest = useRef(blocker);
  useLayoutEffect(() => {
    latest.current = blocker;
  });
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    void confirmAction({
      title: 'Leave without saving?',
      description: 'Your changes on this page have not been saved.',
      action: 'Leave',
      cancel: 'Stay',
      danger: true,
    }).then((leave) => {
      const b = latest.current;
      if (b.state !== 'blocked') return;
      if (leave) b.proceed();
      else b.reset();
    });
  }, [blocker.state]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}
