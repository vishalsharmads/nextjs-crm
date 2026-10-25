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
