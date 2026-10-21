import {
  Box,
  Building2,
  Calendar,
  CalendarDays,
  CheckSquare,
  ClipboardList,
  CreditCard,
  FileText,
  Handshake,
  Home,
  KeyRound,
  LifeBuoy,
  Mail,
  MapPin,
  Notebook,
  Package,
  Receipt,
  Settings,
  Target,
  Ticket,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { BootstrapDto } from '@app/shared';
import { hasPermission } from '@app/shared';
import { labelVars } from '@/lib/labels';

export interface NavItem {
  key: string;
  label: string;
  to: string;
  icon: LucideIcon;
  shortcut?: string;
  section: 'main' | 'modules' | 'footer';
}

const ADMIN_PERMISSIONS = [
  'core.settings.manage',
  'core.branding.manage',
  'core.users.manage',
  'core.roles.manage',
  'core.fields.manage',
  'core.pipelines.manage',
  'core.labels.manage',
  'core.audit.view',
  'core.blueprints.manage',
  'core.modules.manage',
];

/** Icons modules may name in their manifest menu items (kept small so the bundle stays small). */
const MODULE_ICONS: Record<string, LucideIcon> = {
  box: Box,
  calendar: CalendarDays,
  'clipboard-list': ClipboardList,
  'credit-card': CreditCard,
  'file-text': FileText,
  key: KeyRound,
  'life-buoy': LifeBuoy,
  mail: Mail,
  'map-pin': MapPin,
  notebook: Notebook,
  package: Package,
  receipt: Receipt,
  ticket: Ticket,
};

export function moduleIcon(name: string): LucideIcon {
  return MODULE_ICONS[name] ?? Box;
}

/** Navigation is derived from vocabulary, feature toggles, enabled modules and permissions. */
export function buildNav(boot: BootstrapDto, t: (k: string) => string): NavItem[] {
  const can = (p: string) => boot.access.isAdmin || hasPermission(boot.access.permissions, p);
  const v = labelVars(boot.labels);
  const items: NavItem[] = [
    { key: 'home', label: t('nav.home'), to: '/', icon: Home, shortcut: 'g h', section: 'main' },
  ];
  if (boot.settings.features.leads && can('core.leads.view')) {
    items.push({
      key: 'leads',
      label: v.leadPlural!,
      to: '/leads',
      icon: Target,
      shortcut: 'g l',
      section: 'main',
    });
  }
  if (can('core.contacts.view'))
    items.push({
      key: 'contacts',
      label: v.contactPlural!,
      to: '/contacts',
      icon: Users,
      shortcut: 'g c',
      section: 'main',
    });
  if (can('core.organizations.view')) {
    items.push({
      key: 'organizations',
      label: v.organizationPlural!,
      to: '/organizations',
      icon: Building2,
      shortcut: 'g o',
      section: 'main',
    });
  }
  if (can('core.deals.view'))
    items.push({
      key: 'deals',
      label: v.dealPlural!,
      to: '/deals',
      icon: Handshake,
      shortcut: 'g d',
      section: 'main',
    });
  if (can('core.activities.view')) {
    items.push({
      key: 'tasks',
      label: t('nav.tasks'),
      to: '/tasks',
      icon: CheckSquare,
      shortcut: 'g t',
      section: 'main',
    });
    items.push({
      key: 'calendar',
      label: t('nav.calendar'),
      to: '/calendar',
      icon: Calendar,
      section: 'main',
    });
  }
  for (const m of boot.modules.menu) {
    items.push({
      key: `m:${m.moduleKey}:${m.key}`,
      label: m.label,
      to: m.path,
      icon: moduleIcon(m.icon),
      section: 'modules',
    });
  }
  if (ADMIN_PERMISSIONS.some(can))
    items.push({
      key: 'settings',
      label: t('nav.settings'),
      to: '/settings',
      icon: Settings,
      shortcut: 'g s',
      section: 'footer',
    });
  return items;
}
