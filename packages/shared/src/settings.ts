import { z } from 'zod';
import { complianceSettingsSchema } from './compliance';

export const generalSettingsSchema = z.object({
  locale: z.string().min(2).max(10).default('en'),
  currency: z.string().length(3).default('USD'),
  timezone: z.string().min(1).max(64).default('UTC'),
  dateFormat: z.enum(['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY']).default('YYYY-MM-DD'),
  weekStartsOn: z.union([z.literal(0), z.literal(1), z.literal(6)]).default(1),
});
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;

export const securitySettingsSchema = z.object({
  passwordMinLength: z.number().int().min(8).max(128).default(12),
  passwordRequireMixed: z.boolean().default(true),
  lockoutMaxAttempts: z.number().int().min(3).max(50).default(5),
  lockoutMinutes: z.number().int().min(1).max(1440).default(15),
  totpAllowed: z.boolean().default(true),
  totpRequiredForAdmins: z.boolean().default(false),
  sessionIdleDays: z.number().int().min(1).max(90).default(14),
});
export type SecuritySettings = z.infer<typeof securitySettingsSchema>;

export const featureSettingsSchema = z.object({
  leads: z.boolean().default(true),
});
export type FeatureSettings = z.infer<typeof featureSettingsSchema>;

export const dealSettingsSchema = z.object({
  lostReasons: z
    .array(z.string().min(1).max(100))
    .max(50)
    .default(['Price', 'Timing', 'Chose a competitor', 'No response', 'Not a fit']),
  numberPrefix: z.string().max(10).default(''),
});
export type DealSettings = z.infer<typeof dealSettingsSchema>;

export const contactSettingsSchema = z.object({
  sources: z
    .array(z.string().min(1).max(100))
    .max(100)
    .default(['Website', 'Referral', 'Walk-in', 'Phone', 'Email', 'Event', 'Social', 'Other']),
  lifecycleStatuses: z
    .array(z.string().min(1).max(50))
    .max(30)
    .default(['Subscriber', 'Prospect', 'Customer', 'Former customer']),
});
export type ContactSettings = z.infer<typeof contactSettingsSchema>;

/** Business details and defaults printed on quotes, invoices and contracts. */
export const commerceSettingsSchema = z.object({
  legalName: z.string().max(200).default(''),
  address: z.string().max(1000).default(''),
  taxId: z.string().max(100).default(''),
  email: z.union([z.email().max(254), z.literal('')]).default(''),
  phone: z.string().max(50).default(''),
  quotePrefix: z.string().max(10).default('Q-'),
  invoicePrefix: z.string().max(10).default('INV-'),
  contractPrefix: z.string().max(10).default('C-'),
  quoteValidityDays: z.number().int().min(1).max(365).default(30),
  invoiceDueDays: z.number().int().min(0).max(365).default(14),
  defaultTaxRate: z.number().min(0).max(100).default(0),
  quoteTerms: z.string().max(5000).default(''),
  invoiceTerms: z.string().max(5000).default(''),
  paymentInstructions: z.string().max(2000).default(''),
  renewalNoticeDays: z.number().int().min(1).max(365).default(30),
});
export type CommerceSettings = z.infer<typeof commerceSettingsSchema>;

/** Setting groups addressable via PATCH /settings/:group. Branding has its own endpoint. */
export const SETTINGS_GROUPS = {
  general: generalSettingsSchema,
  security: securitySettingsSchema,
  features: featureSettingsSchema,
  deals: dealSettingsSchema,
  contacts: contactSettingsSchema,
  commerce: commerceSettingsSchema,
  compliance: complianceSettingsSchema,
} as const;
export type SettingsGroup = keyof typeof SETTINGS_GROUPS;

export function passwordPolicySchema(
  s: Pick<SecuritySettings, 'passwordMinLength' | 'passwordRequireMixed'>,
) {
  let schema = z.string().min(s.passwordMinLength, `Use at least ${s.passwordMinLength} characters`).max(256);
  if (s.passwordRequireMixed) {
    schema = schema
      .regex(/[a-z]/, 'Add a lowercase letter')
      .regex(/[A-Z]/, 'Add an uppercase letter')
      .regex(/\d/, 'Add a digit');
  }
  return schema;
}
