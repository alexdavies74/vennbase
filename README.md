# covedb

Monorepo containing:
- `packages/covedb-core`: Core TypeScript SDK for Puter-backed rows, invites, member access, and CRDT sync.
- `packages/covedb-react`: React bindings for `@covedb/core`.
- `packages/covedb-yjs`: Yjs bindings that reuse the app's Yjs runtime.
- `packages/woof-app`: Vite TypeScript SPA using the SDK.

Start with the SDK docs in [`packages/covedb-core/README.md`](packages/covedb-core/README.md) for the current product surface and usage.

## Quick start

```bash
pnpm install
pnpm build
pnpm test
pnpm dev
```
