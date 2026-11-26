# Architecture

The Next.js frontend lives in `apps/frontend`. Shared React components live in `packages/ui`.

The backend design uses Express in `apps/backend` to serve versioned routes from `packages/api`. See the [package ownership rules](../rules/architecture.md) for the server entry points, supporting packages, and API contract.
