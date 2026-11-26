# Package ownership

Use these boundaries when adding or moving application code.

| Location | Responsibility |
| --- | --- |
| `apps/backend/src/app.ts` | Create the Express application, configure middleware, and mount the API routers. The backend entry point starts the HTTP listener. |
| `packages/api` | Implement the HTTP API, including versioned routers, route handlers, and response mapping. |
| `packages/common` | Place shared application helpers and other common files here. |
| `packages/config` | Centralize application configuration, including environment settings and defaults. |
| `packages/drizzle` | Keep all Drizzle ORM code and artifacts here, including the client, table definitions, relations, migrations, queries, and Drizzle Kit configuration. |
| `packages/services` | Implement all external service integrations and provider clients here. |
| `packages/types` | Maintain application TypeScript types and interfaces here. Derive schema-backed types from their validators to keep the definitions consistent. |
| `packages/validators` | Define all Zod schemas here. API handlers use these schemas to validate incoming inputs before processing them. |

## API contract

Maintain [the OpenAPI specification](../../packages/api/openapi.yaml) in the same change as every externally visible API change. When adding, changing, or removing an endpoint, update its path, HTTP method, parameters, request body, response bodies and status codes, and authentication requirements as applicable. Keep documented input constraints aligned with the Zod schemas.
