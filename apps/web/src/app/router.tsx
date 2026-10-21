import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router';
import { useSession } from '@/app/session';
import { Spinner } from '@/components/ui/spinner';
import { AppShell } from '@/app/shell/app-shell';
import { AcceptInvitePage, ForgotPasswordPage, LoginPage, ResetPasswordPage } from '@/features/auth/pages';
import { HomePage } from '@/features/home/home-page';
import { SettingsLayout } from '@/features/settings/layout';
import { RecordListPage } from '@/features/records/list-page';
import { RecordPage } from '@/features/records/record-page';

const lazyPage = <T extends Record<string, unknown>>(loader: () => Promise<T>, name: keyof T) =>
  lazy(() => loader().then((m) => ({ default: m[name] as React.ComponentType })));

const ProfilePage = lazyPage(() => import('@/features/settings/profile-page'), 'ProfilePage');
const BrandingPage = lazyPage(() => import('@/features/settings/branding-page'), 'BrandingPage');
const GeneralSettingsPage = lazyPage(() => import('@/features/settings/general-page'), 'GeneralSettingsPage');
const SecuritySettingsPage = lazyPage(
  () => import('@/features/settings/general-page'),
  'SecuritySettingsPage',
);
const VocabularyPage = lazyPage(() => import('@/features/settings/vocabulary-page'), 'VocabularyPage');
const UsersPage = lazyPage(() => import('@/features/settings/people-pages'), 'UsersPage');
const TeamsPage = lazyPage(() => import('@/features/settings/people-pages'), 'TeamsPage');
const RolesPage = lazyPage(() => import('@/features/settings/people-pages'), 'RolesPage');
const FieldsPage = lazyPage(() => import('@/features/settings/fields-page'), 'FieldsPage');
const PipelinesPage = lazyPage(() => import('@/features/settings/pipelines-page'), 'PipelinesPage');
const DealsPage = lazyPage(() => import('@/features/deals/deals-page'), 'DealsPage');
const TasksPage = lazyPage(() => import('@/features/activities/tasks-page'), 'TasksPage');
const CalendarPage = lazyPage(() => import('@/features/activities/calendar-page'), 'CalendarPage');

export function PageFallback() {
  return (
    <div className="flex h-full min-h-40 items-center justify-center text-muted">
      <Spinner />
    </div>
  );
}

const page = (el: ReactNode) => <Suspense fallback={<PageFallback />}>{el}</Suspense>;

function RequireAuth() {
  const { status } = useSession();
  const location = useLocation();
  if (status === 'loading') {
    return (
      <div className="flex h-dvh items-center justify-center text-muted">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (status === 'anonymous')
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <Outlet />;
}

const settingsPages: { path: string; element: ReactNode }[] = [
  { path: 'profile', element: <ProfilePage /> },
  { path: 'general', element: <GeneralSettingsPage /> },
  { path: 'branding', element: <BrandingPage /> },
  { path: 'vocabulary', element: <VocabularyPage /> },
  { path: 'security', element: <SecuritySettingsPage /> },
  { path: 'users', element: <UsersPage /> },
  { path: 'teams', element: <TeamsPage /> },
  { path: 'roles', element: <RolesPage /> },
  { path: 'fields', element: <FieldsPage /> },
  { path: 'pipelines', element: <PipelinesPage /> },
];

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/accept-invite', element: <AcceptInvitePage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'contacts', element: <RecordListPage entity="contact" /> },
          { path: 'contacts/:uuid', element: <RecordPage entity="contact" /> },
          { path: 'organizations', element: <RecordListPage entity="organization" /> },
          { path: 'organizations/:uuid', element: <RecordPage entity="organization" /> },
          { path: 'leads', element: <RecordListPage entity="lead" /> },
          { path: 'leads/:uuid', element: <RecordPage entity="lead" /> },
          { path: 'deals', element: page(<DealsPage />) },
          { path: 'deals/:uuid', element: <RecordPage entity="deal" /> },
          { path: 'tasks', element: page(<TasksPage />) },
          { path: 'calendar', element: page(<CalendarPage />) },
          {
            path: 'settings',
            element: <SettingsLayout available={settingsPages.map((p) => p.path)} />,
            children: settingsPages.map((p) => ({ path: p.path, element: page(p.element) })),
          },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]);
