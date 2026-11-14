import { z } from 'zod';
import type { Scope } from './permissions';
import type { VisibilityLevel } from './custom-fields';

export const loginSchema = z.object({
  email: z
    .email()
    .max(255)
    .transform((e) => e.toLowerCase()),
  password: z.string().min(1).max(256),
});

export const totpCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });

/** Second sign-in step: an authenticator code or a one-time recovery code. */
export const mfaVerifySchema = z
  .object({
    code: z
      .string()
      .regex(/^\d{6}$/, 'Enter the 6-digit code')
      .optional(),
    recoveryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/, 'Enter a recovery code like abcde-12345')
      .optional(),
  })
  .refine((v) => !!v.code !== !!v.recoveryCode, 'Enter a code or a recovery code');

export const forgotPasswordSchema = z.object({
  email: z
    .email()
    .max(255)
    .transform((e) => e.toLowerCase()),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(1).max(256),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

export interface MeDto {
  uuid: string;
  email: string;
  firstName: string;
  lastName: string;
  locale: string | null;
  timezone: string | null;
  totpEnabled: boolean;
  recoveryCodesLeft: number;
  roles: { key: string; name: string }[];
  /** Guided tours this person finished or dismissed, so they are not offered again. */
  toursSeen: string[];
  /** Personal notification choices. */
  notifications: NotificationPrefs;
}

/** Effective access for the current user, used by the UI to show/hide affordances. */
export interface AccessDto {
  isAdmin: boolean;
  permissions: string[];
  scopes: Record<string, Scope>;
  /** entity → field key → level */
  fields: Record<string, Record<string, VisibilityLevel>>;
  /** Workspace requires this admin to turn on 2FA before doing anything else. */
  mfaSetupRequired: boolean;
}

export interface SessionDto {
  uuid: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
}

export interface NotificationPrefs {
  /** Mirror notifications by email (assignments, mentions, reminders). Off turns every email off. */
  email: boolean;
  /** One email each morning with tasks due today and overdue. */
  taskDigest: boolean;
  /** Email and push per kind of notification. In-app notifications are always kept. */
  categories: Record<NotificationCategory, { email: boolean; push: boolean }>;
}

/** Kinds of notification people can tune separately. */
export const NOTIFICATION_CATEGORIES = [
  { key: 'assigned', label: 'Assigned to me' },
  { key: 'mentioned', label: 'Mentioned me' },
  { key: 'comments', label: 'Comments and replies on my records' },
  { key: 'reminders', label: 'Reminders and things coming due' },
  { key: 'shared', label: 'Shared with me' },
  { key: 'other', label: 'Automations and everything else' },
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]['key'];

/** Which category a notification type (`deal.assigned`, `comment.mentioned`…) belongs to. */
export function notificationCategory(type: string): NotificationCategory {
  if (type.endsWith('.assigned')) return 'assigned';
  if (type.endsWith('.mentioned')) return 'mentioned';
  if (['comment.created', 'activity.commented', 'ticket.replied'].includes(type)) return 'comments';
  if (
    type === 'activity.reminder' ||
    type.endsWith('.due') ||
    type.endsWith('_due') ||
    type.endsWith('.overdue')
  )
    return 'reminders';
  if (type.endsWith('.shared')) return 'shared';
  return 'other';
}

/** Defaults: email follows what the sender asked for; push is on for anything addressed to you. */
export const DEFAULT_NOTIFICATION_PUSH: Record<NotificationCategory, boolean> = {
  assigned: true,
  mentioned: true,
  comments: true,
  reminders: true,
  shared: true,
  other: false,
};
export const DEFAULT_NOTIFICATION_EMAIL: Record<NotificationCategory, boolean> = {
  assigned: true,
  mentioned: true,
  comments: false,
  reminders: true,
  shared: true,
  other: true,
};
