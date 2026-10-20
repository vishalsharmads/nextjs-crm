import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { MulterError } from 'multer';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(new AppError('NOT_FOUND', `No route for ${req.method} ${req.originalUrl.split('?')[0]}`));
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  let appErr: AppError;
  if (err instanceof AppError) {
    appErr = err;
  } else if (err instanceof ZodError) {
    appErr = new AppError(
      'VALIDATION_FAILED',
      'Some fields need attention',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
    );
  } else if (err instanceof MulterError) {
    appErr =
      err.code === 'LIMIT_FILE_SIZE'
        ? new AppError('PAYLOAD_TOO_LARGE', 'That file is too large')
        : new AppError('VALIDATION_FAILED', err.message);
  } else if (isBodyParserError(err)) {
    appErr =
      err.type === 'entity.too.large'
        ? new AppError('PAYLOAD_TOO_LARGE', 'Request body is too large')
        : new AppError('VALIDATION_FAILED', 'Request body is not valid JSON');
  } else {
    logger.error({ err, requestId: req.ctx?.requestId }, 'Unhandled error');
    appErr = new AppError('INTERNAL', 'Something went wrong on our side. Try again in a moment.');
  }
  res.status(appErr.status).json({
    error: {
      code: appErr.code,
      message: appErr.message,
      ...(appErr.details !== undefined ? { details: appErr.details } : {}),
    },
  });
}

function isBodyParserError(err: unknown): err is { type: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    typeof (err as { type: unknown }).type === 'string'
  );
}
