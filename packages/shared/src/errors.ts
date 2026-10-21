/** Stable machine-readable error codes. Never rename a released code. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'CSRF_INVALID',
  'FORBIDDEN',
  'FIELD_FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'DUPLICATE_DETECTED',
  'RATE_LIMITED',
  'ACCOUNT_LOCKED',
  'MFA_REQUIRED',
  'MFA_INVALID',
  'STAGE_INVALID',
  'BLUEPRINT_CONFLICT',
  'MODULE_DEPENDENCY',
  'MODULE_DISABLED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_FILE_TYPE',
  'NOT_INSTALLED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  CSRF_INVALID: 403,
  FORBIDDEN: 403,
  FIELD_FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DUPLICATE_DETECTED: 409,
  RATE_LIMITED: 429,
  ACCOUNT_LOCKED: 423,
  MFA_REQUIRED: 401,
  MFA_INVALID: 401,
  STAGE_INVALID: 422,
  BLUEPRINT_CONFLICT: 409,
  MODULE_DEPENDENCY: 409,
  MODULE_DISABLED: 404,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_FILE_TYPE: 415,
  NOT_INSTALLED: 503,
  INTERNAL: 500,
};

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export interface ListMeta {
  page: number;
  pageSize: number;
  total: number;
}

export interface ListResponse<T> {
  data: T[];
  meta: ListMeta;
}
