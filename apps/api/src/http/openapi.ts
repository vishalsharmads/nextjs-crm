import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { routeRegistry } from './routes';

extendZodWithOpenApi(z);

/** OpenAPI 3.1 generated from the same route registry and Zod schemas the API validates with. */
export function buildOpenApi(appName: string) {
  const registry = new OpenAPIRegistry();
  for (const r of routeRegistry) {
    const path = `/api/v1${r.path.replace(/:([A-Za-z]+)/g, '{$1}')}`;
    registry.registerPath({
      method: r.method,
      path,
      summary: r.summary,
      tags: r.tags,
      description: `Requires: ${r.permission}`,
      request: {
        ...(r.params ? { params: r.params as z.ZodObject } : {}),
        ...(r.query ? { query: r.query as z.ZodObject } : {}),
        ...(r.body ? { body: { content: { 'application/json': { schema: r.body } } } } : {}),
      },
      responses: {
        200: { description: 'OK' },
        401: { description: 'Not signed in' },
        403: { description: 'Not allowed' },
        422: { description: 'Validation failed' },
      },
    });
  }
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: `${appName} API`, version: '1.0.0' },
  });
}
