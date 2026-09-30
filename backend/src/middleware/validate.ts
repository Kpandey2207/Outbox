import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { badRequest } from '../utils/errors.js';

type Part = 'body' | 'query' | 'params';

/** Parses a request part with a zod schema and stores the typed result on res.locals. */
export function validate<S extends z.ZodType>(part: Part, schema: S) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      return next(
        badRequest(
          'Validation failed',
          result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ),
      );
    }
    res.locals[part] = result.data;
    next();
  };
}
