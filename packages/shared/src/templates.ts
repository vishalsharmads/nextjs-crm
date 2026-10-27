/** A field a template author can insert as `{{path}}`, grouped by the record it comes from. */
export interface MergeField {
  path: string;
  label: string;
}

export interface MergeFieldGroup {
  key: string;
  label: string;
  fields: MergeField[];
}

/**
 * Email templates whose key starts with this are saved replies: anyone can insert them into an
 * email or note, rendered for the record they are on. Other keys are system emails.
 */
export const SAVED_REPLY_PREFIX = 'reply.';

/** A saved reply as the insert menu lists it. */
export interface SavedReply {
  uuid: string;
  key: string;
  name: string;
  subject: string;
}

/** A simple placeholder (`{{contact.firstName}}`); block helpers like `{{#if}}` do not match. */
export const MERGE_FIELD_RE = /\{\{\s*([A-Za-z_][\w]*(?:\.[\w]+)*)\s*\}\}/g;
