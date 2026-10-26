import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, useLocation, useRouteError } from 'react-router';
import { ErrorState } from '@/components/ui/misc';
import { useSession } from '@/app/session';
import { Spinner } from '@/components/ui/spinner';
import { AppShell } from '@/app/shell/app-shell';
import { AcceptInvitePage, ForgotPasswordPage, LoginPage, ResetPasswordPage } from '@/features/auth/pages';
import { SettingsLayout } from '@/features/settings/layout';
import { RecordListPage } from '@/features/records/list-page';
import { RecordPage } from '@/features/records/record-page';
import { ModuleOutlet, PublicModuleOutlet } from '@/modules/loader';
import { basePath } from '@/lib/app-url';

const lazyPage = <T extends Record<string, unknown>>(loader: () => Promise<T>, name: keyof T) =>
  lazy(() => loader().then((m) => ({ default: m[name] as React.ComponentType })));

const ProfilePage = lazyPage(() => import('@/features/settings/profile-page'), 'ProfilePage');
const BrandingPage = lazyPage(() => import('@/features/settings/branding-page'), 'BrandingPage');
const GeneralSettingsPage = lazyPage(() => import('@/features/settings/general-page'), 'GeneralSettingsPage');
const SecuritySettingsPage = lazyPage(
  () => import('@/features/settings/general-page'),
  'SecuritySettingsPage',
);
const ComplianceSettingsPage = lazyPage(
  () => import('@/features/settings/compliance-page'),
  'ComplianceSettingsPage',
);
const VocabularyPage = lazyPage(() => import('@/features/settings/vocabulary-page'), 'VocabularyPage');
const UsersPage = lazyPage(() => import('@/features/settings/people-pages'), 'UsersPage');
const TeamsPage = lazyPage(() => import('@/features/settings/people-pages'), 'TeamsPage');
const RolesPage = lazyPage(() => import('@/features/settings/people-pages'), 'RolesPage');
const FieldsPage = lazyPage(() => import('@/features/settings/fields-page'), 'FieldsPage');
const PipelinesPage = lazyPage(() => import('@/features/settings/pipelines-page'), 'PipelinesPage');
const DealsPage = lazyPage(() => import('@/features/deals/deals-page'), 'DealsPage');
const TasksPage = lazyPage(() => import('@/features/activities/tasks-page'), 'TasksPage');
const ImportPage = lazyPage(() => import('@/features/imports/import-page'), 'ImportPage');
const DashboardPage = lazyPage(() => import('@/features/dashboard/dashboard-page'), 'DashboardPage');
const AuditPage = lazyPage(() => import('@/features/audit/audit-page'), 'AuditPage');
const ModulesPage = lazyPage(() => import('@/features/settings/platform-pages'), 'ModulesPage');
const BlueprintPage = lazyPage(() => import('@/features/settings/platform-pages'), 'BlueprintPage');
const PrivacyPage = lazyPage(() => import('@/features/privacy/privacy-page'), 'PrivacyPage');
const DataMapPage = lazyPage(() => import('@/features/privacy/data-map-page'), 'DataMapPage');
const ApiKeysPage = lazyPage(() => import('@/features/settings/integration-pages'), 'ApiKeysPage');
const WebhooksPage = lazyPage(() => import('@/features/settings/integration-pages'), 'WebhooksPage');
const TemplatesPage = lazyPage(() => import('@/features/settings/integration-pages'), 'TemplatesPage');
const EmailSettingsPage = lazyPage(
  () => import('@/features/settings/integration-pages'),
  'EmailSettingsPage',
);
const AutomationsPage = lazyPage(() => import('@/features/settings/workflow-pages'), 'AutomationsPage');
const FormsPage = lazyPage(() => import('@/features/settings/workflow-pages'), 'FormsPage');
const LayoutBuilderPage = lazyPage(() => import('@/features/settings/layout-builder'), 'LayoutBuilderPage');
const PublicFormPage = lazyPage(() => import('@/features/forms/public-form-page'), 'PublicFormPage');
const UnsubscribePage = lazyPage(() => import('@/features/privacy/unsubscribe-page'), 'UnsubscribePage');
const CommerceSettingsPage = lazyPage(
  () => import('@/features/settings/commerce-page'),
  'CommerceSettingsPage',
);
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
  { path: 'compliance', element: <ComplianceSettingsPage /> },
  { path: 'users', element: <UsersPage /> },
  { path: 'teams', element: <TeamsPage /> },
  { path: 'roles', element: <RolesPage /> },
  { path: 'fields', element: <FieldsPage /> },
  { path: 'pipelines', element: <PipelinesPage /> },
  { path: 'audit', element: <AuditPage /> },
  { path: 'modules', element: <ModulesPage /> },
  { path: 'blueprint', element: <BlueprintPage /> },
  { path: 'privacy', element: <PrivacyPage /> },
  { path: 'data-map', element: <DataMapPage /> },
  { path: 'api-keys', element: <ApiKeysPage /> },
  { path: 'webhooks', element: <WebhooksPage /> },
  { path: 'templates', element: <TemplatesPage /> },
  { path: 'email', element: <EmailSettingsPage /> },
  { path: 'automations', element: <AutomationsPage /> },
  { path: 'forms', element: <FormsPage /> },
  { path: 'layouts', element: <LayoutBuilderPage /> },
  { path: 'sales-documents', element: <CommerceSettingsPage /> },
];

/** Shown instead of a blank screen when a page throws while rendering. */
function RouteError() {
  const error = useRouteError();
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <ErrorState
        error={error instanceof Error ? error : new Error('This page could not be shown.')}
        onRetry={() => window.location.reload()}
      />
    </div>
  );
}

export const router = createBrowserRouter(
  [
    { path: '/login', element: <LoginPage /> },
    { path: '/forgot-password', element: <ForgotPasswordPage /> },
    { path: '/reset-password', element: <ResetPasswordPage /> },
    { path: '/accept-invite', element: <AcceptInvitePage /> },
    { path: '/f/:uuid', element: page(<PublicFormPage />) },
    { path: '/unsubscribe', element: page(<UnsubscribePage />) },
    { path: '/p/:moduleKey/*', element: <PublicModuleOutlet />, errorElement: <RouteError /> },
    {
      element: <RequireAuth />,
      errorElement: <RouteError />,
      children: [
        {
          element: <AppShell />,
          children: [
            { index: true, element: page(<DashboardPage />) },
            { path: 'import/:route', element: page(<ImportPage />) },
            { path: 'm/:moduleKey/*', element: <ModuleOutlet /> },
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
  ],
  { basename: basePath || '/' },
);
