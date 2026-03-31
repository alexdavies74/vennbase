# vennbase

Monorepo containing:
- `packages/vennbase-core`: Core TypeScript SDK for Puter-backed rows, invites, member access, and CRDT sync.
- `packages/vennbase-react`: React bindings for `@vennbase/core`.
- `packages/vennbase-yjs`: Yjs bindings that reuse the app's Yjs runtime.
- `packages/todo-app`: Minimal shared todo board example app.
- `packages/appointment-app`: Appointment booking example app with owner schedules and customer reservations.
- `packages/woof-app`: Vite TypeScript SPA using the SDK.

Start with the SDK docs in [`packages/vennbase-core/README.md`](packages/vennbase-core/README.md) for the current product surface and usage.

## Quick start

```bash
pnpm install
pnpm build
pnpm test
pnpm dev
```
