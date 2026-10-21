import { ERROR_STATUS, type ErrorCode } from '@app/shared';

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = ERROR_STATUS[code];
  }
}

export const notFound = (what = 'Record') => new AppError('NOT_FOUND', `${what} not found`);
export const forbidden = (message = 'You do not have permission to do that') =>
  new AppError('FORBIDDEN', message);
export const conflict = (message: string, details?: unknown) => new AppError('CONFLICT', message, details);
export const invalid = (message: string, details?: unknown) =>
  new AppError('VALIDATION_FAILED', message, details);
