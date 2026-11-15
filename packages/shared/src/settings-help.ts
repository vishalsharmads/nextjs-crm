import type { z } from 'zod';
import type { SETTINGS_GROUPS, SettingsGroup } from './settings';

export interface SettingHelp {
  label: string;
  /** What it does, for the people who change it. Plain language, one or two sentences. */
  description: string;
}

/**
 * Every setting, explained. Keyed by the schemas themselves: adding a setting without a description
 * here does not compile, so in-app help never falls behind the code. Allowed values and defaults
 * are read from the schemas when help is shown.
 */
type HelpFor<S extends z.ZodType> = { [K in keyof z.output<S>]-?: SettingHelp };

export const SETTINGS_HELP: { [G in SettingsGroup]: HelpFor<(typeof SETTINGS_GROUPS)[G]> } = {
  general: {
    locale: {
      label: 'Language',
      description: 'The language of the interface and of emails the workspace sends.',
    },
    currency: {
      label: 'Currency',
      description:
        'The main currency. New records use it, and reports and quotas are in it unless converted.',
    },
    timezone: {
      label: 'Time zone',
      description:
        'Used for schedules, due dates, scheduled automations and shared calendars, so everyone sees the same times.',
    },
    dateFormat: { label: 'Date format', description: 'How dates are written across the workspace.' },
    weekStartsOn: { label: 'First day of the week', description: 'Used by calendars and date pickers.' },
  },
  security: {
    passwordMinLength: {
      label: 'Minimum password length',
      description: 'Passwords shorter than this are refused.',
    },
    passwordRequireMixed: {
      label: 'Require mixed characters',
      description: 'Passwords must contain lowercase and uppercase letters and a digit.',
    },
    lockoutMaxAttempts: {
      label: 'Failed sign-ins before lockout',
      description: 'After this many wrong passwords in a row, the account is locked for a while.',
    },
    lockoutMinutes: {
      label: 'Lockout length (minutes)',
      description: 'How long a locked account waits before trying again.',
    },
    totpAllowed: {
      label: 'Allow two-factor authentication',
      description: 'People can protect their account with an authenticator app.',
    },
    totpRequiredForAdmins: {
      label: 'Require two-factor for admins',
      description: 'Admins must set up two-factor authentication before they can use anything else.',
    },
    sessionIdleDays: {
      label: 'Stay signed in (days)',
      description: 'A browser that has not been used for this many days is signed out.',
    },
  },
  features: {
    leads: {
      label: 'Use {{leadPluralLower}}',
      description: 'Qualify new enquiries as {{leadPluralLower}} before they become {{contactPluralLower}}.',
    },
    leadPipeline: {
      label: '{{lead}} pipeline',
      description:
        'Move {{leadPluralLower}} through stages on a board, like {{dealPluralLower}}. Needs {{leadPluralLower}} on.',
    },
    taskPipeline: {
      label: 'Task statuses',
      description:
        'Give tasks, calls and meetings statuses (such as To do, In progress, Waiting, Done) and a board. Reaching the done stage completes them.',
    },
    emailTracking: {
      label: 'Email tracking',
      description:
        'Let people see when emails sent from the app are opened and their links clicked. Off under the Privacy and Health data profiles, and never for people who opted out of marketing.',
    },
  },
  deals: {
    lostReasons: {
      label: 'Lost reasons',
      description: 'The choices offered when marking {{dealPluralLower}} lost, used in reports.',
    },
    numberPrefix: {
      label: 'Reference prefix',
      description:
        'Added before each {{dealLower}} reference number, for example "OPP-". Empty means no references.',
    },
  },
  contacts: {
    sources: {
      label: 'Sources',
      description: 'Where {{contactPluralLower}} come from. Used in lists, filters and reports.',
    },
    lifecycleStatuses: {
      label: 'Lifecycle statuses',
      description:
        'The stages of your relationship with {{contactPluralLower}}, from first touch to customer.',
    },
  },
  commerce: {
    legalName: { label: 'Legal name', description: 'Printed on quotes, invoices and contracts.' },
    address: { label: 'Address', description: 'Printed on quotes, invoices and contracts.' },
    taxId: {
      label: 'Tax number',
      description: 'Your VAT, GST or other tax registration number, printed on documents.',
    },
    email: {
      label: 'Billing email',
      description: 'Shown on documents as the address customers can reply to.',
    },
    phone: { label: 'Phone', description: 'Shown on documents.' },
    quotePrefix: {
      label: 'Quote prefix',
      description: 'Quote numbers start with this, followed by a gap-free number.',
    },
    invoicePrefix: {
      label: 'Invoice prefix',
      description:
        'Invoice numbers start with this, followed by a gap-free number (required for tax in many countries).',
    },
    contractPrefix: { label: 'Contract prefix', description: 'Contract numbers start with this.' },
    quoteValidityDays: {
      label: 'Quotes valid for (days)',
      description: 'The default expiry of a new quote.',
    },
    invoiceDueDays: {
      label: 'Invoices due after (days)',
      description: 'The default payment term of a new invoice. 0 means due on receipt.',
    },
    defaultTaxRate: {
      label: 'Default tax rate (%)',
      description: 'Used on new line items unless the product has its own rate.',
    },
    quoteTerms: { label: 'Quote terms', description: 'Printed at the end of every quote.' },
    invoiceTerms: { label: 'Invoice terms', description: 'Printed at the end of every invoice.' },
    paymentInstructions: {
      label: 'Payment instructions',
      description: 'How to pay, for example bank details. Printed on invoices.',
    },
    renewalNoticeDays: {
      label: 'Renewal notice (days)',
      description: 'How many days before a contract ends its owner is reminded to renew it.',
    },
  },
  compliance: {
    profile: {
      label: 'Compliance profile',
      description:
        'Standard, privacy (GDPR-style) or health-data rules. Stricter profiles set minimums for the security and privacy settings below.',
    },
    idleTimeoutMinutes: {
      label: 'Sign out when idle (minutes)',
      description: 'Sign people out after this long without using the app. 0 turns it off.',
    },
    sessionMaxHours: {
      label: 'Maximum session (hours)',
      description: 'Force a new sign-in after this long, active or not. 0 turns it off.',
    },
    mfaRequiredForAll: {
      label: 'Require two-factor for everyone',
      description: 'Everyone must set up two-factor authentication.',
    },
    mfaRequiredRoles: {
      label: 'Require two-factor for roles',
      description: 'Members of these roles must use two-factor authentication.',
    },
    apiKeyMaxDays: {
      label: 'Credential age limit (days)',
      description:
        'API keys and AI-client tokens stop working this many days after they are created or approved. 0 means no limit.',
    },
    accessLogging: {
      label: 'Access logging',
      description: 'Record who viewed records, downloaded files, exported data and read the audit log.',
    },
    auditRetentionDays: {
      label: 'Keep audit history (days)',
      description: 'Older audit and access log entries are deleted. 0 keeps them forever.',
    },
    dsarDueDays: {
      label: 'Privacy request deadline (days)',
      description: 'How long you have to answer an access or erasure request.',
    },
    consentPurposes: {
      label: 'Consent purposes',
      description:
        'What people can agree to, such as a newsletter. Web forms show a checkbox for each purpose they use.',
    },
    retentionRules: {
      label: 'Retention rules',
      description: 'Records that match a rule are erased automatically once they are old enough.',
    },
    housekeeping: {
      label: 'Housekeeping',
      description:
        'How long sign-in sessions, background jobs, webhook deliveries, notifications, automation runs and deleted files are kept.',
    },
    webhookMinimal: {
      label: 'Minimal webhooks',
      description:
        'Webhooks send only ids and the names of changed fields; receivers fetch the record through the API.',
    },
    notificationEmailMinimal: {
      label: 'Minimal notification emails',
      description:
        'Notification emails say only that something needs attention, with a link, and no names or details.',
    },
    noEmailTracking: {
      label: 'Never track emails',
      description:
        'No open or click tracking on any email, whatever the workspace setting. Always on under the Privacy and Health data profiles.',
    },
    encryptUploads: {
      label: 'Encrypt uploaded files',
      description: 'Files are encrypted at rest with the workspace keys.',
    },
    loginNotice: {
      label: 'Sign-in notice',
      description: 'Shown on the sign-in screen, for example an authorized-use warning.',
    },
  },
  mcp: {
    enabled: {
      label: 'Allow AI clients',
      description: 'Let AI assistants that support MCP work with the workspace on a person’s behalf.',
    },
    allTools: {
      label: 'All tools',
      description:
        'Clients may use every tool, including ones added later. Turn off to choose tools one by one.',
    },
    tools: {
      label: 'Allowed tools',
      description:
        'The tools clients may call when "All tools" is off. None means clients can connect but do nothing.',
    },
    rateLimitPerMinute: {
      label: 'Calls per minute',
      description: 'How many calls each person’s AI clients may make per minute.',
    },
  },
};
