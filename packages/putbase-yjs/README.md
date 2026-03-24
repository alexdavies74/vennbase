# `@putbase/yjs`

Yjs adapters for PutBase CRDT sync.

`@putbase/yjs` uses the app's `yjs` instance instead of bundling its own runtime. Install both packages and pass your `Y` module into `createYjsAdapter`.

```ts
import * as Y from "yjs";
import { createYjsAdapter } from "@putbase/yjs";

const adapter = createYjsAdapter(Y);
```
