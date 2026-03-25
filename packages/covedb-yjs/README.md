# `@covedb/yjs`

Yjs adapters for CoveDB CRDT sync.

`@covedb/yjs` uses the app's `yjs` instance instead of bundling its own runtime. Install both packages and pass your `Y` module into `createYjsAdapter`.

```ts
import * as Y from "yjs";
import { createYjsAdapter } from "@covedb/yjs";

const adapter = createYjsAdapter(Y);
```
