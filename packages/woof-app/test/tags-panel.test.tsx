// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RowHandle, type Vennbase } from "@vennbase/core";

import { VennbaseProvider } from "@vennbase/react";
import { TagsPanel } from "../src/tags-panel";
import { woofSchema } from "../src/schema";

class FakeDb {
  queryResult: ReturnType<typeof this.buildRows> | Promise<ReturnType<typeof this.buildRows>> = this.buildRows();
  peekQueryResult: ReturnType<typeof this.buildRows> | null = null;
  localMutationListener: (() => void) | null = null;

  private buildRows() {
    return [
      new RowHandle(
        backend,
        {
          id: "tag_1",
          collection: "tags",
          baseUrl: "https://worker.example",
        },
        "alex",
        { label: "playful", createdBy: "alex", createdAt: 100 },
      ),
      new RowHandle(
        backend,
        {
          id: "tag_2",
          collection: "tags",
          baseUrl: "https://worker.example",
        },
        "alex",
        { label: " ", createdBy: "alex", createdAt: 101 },
      ),
    ];
  }

  async getSession() {
    return {
      signedIn: true as const,
      user: { username: "alex" },
    };
  }

  async query() {
    return this.queryResult;
  }

  peekQuery() {
    return this.peekQueryResult ?? (Array.isArray(this.queryResult) ? this.queryResult : []);
  }

  subscribeToLocalMutations(listener: () => void): () => void {
    this.localMutationListener = listener;
    return () => {
      if (this.localMutationListener === listener) {
        this.localMutationListener = null;
      }
    };
  }

  emitLocalMutation(): void {
    this.localMutationListener?.();
  }
}

const backend = {
  addParent: async () => undefined,
  removeParent: async () => undefined,
  listParents: async () => [],
  addMember: async () => undefined,
  removeMember: async () => undefined,
  listDirectMembers: async () => [],
  listEffectiveMembers: async () => [],
  refreshFields: async () => ({}),
  connectCrdt: () => ({
    disconnect: () => undefined,
    flush: async () => undefined,
  }),
  listMembers: async () => [],
};

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(check: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flushMicrotasks();
      });
    }
  }

  throw lastError;
}

async function renderApp(element: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(element);
    await flushMicrotasks();
  });

  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
        await flushMicrotasks();
      });
      container.remove();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

function dogRow() {
  return {
    id: "dog_1",
    collection: "dogs" as const,
    owner: "alex",
    ref: {
      id: "dog_1",
      collection: "dogs" as const,
      baseUrl: "https://worker.example",
    },
    fields: { name: "Rex" },
    connectCrdt: () => ({
      disconnect: () => undefined,
      flush: async () => undefined,
    }),
  };
}

function tagRow(id: string, label: string, createdAt: number) {
  return new RowHandle(
    backend,
    {
      id,
      collection: "tags",
      baseUrl: "https://worker.example",
    },
    "alex",
    { label, createdBy: "alex", createdAt },
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("TagsPanel", () => {
  it("renders tags from the React query hook", async () => {
    const row = dogRow();

    const app = await renderApp(
      <VennbaseProvider db={new FakeDb() as unknown as Vennbase<typeof woofSchema>}>
        <TagsPanel row={row} onCreateTag={async () => undefined} />
      </VennbaseProvider>,
    );

    await waitFor(() => {
      expect(app.container.textContent).toContain("playful");
      expect(app.container.querySelectorAll(".tag-item")).toHaveLength(1);
    });
    await app.unmount();
  });

  it("shows loading before the first result, then empty state after a successful empty load", async () => {
    const row = dogRow();
    const query = deferred<Array<RowHandle<typeof woofSchema, "tags">>>();
    const db = new FakeDb();
    db.queryResult = query.promise;

    const app = await renderApp(
      <VennbaseProvider db={db as unknown as Vennbase<typeof woofSchema>}>
        <TagsPanel row={row} onCreateTag={async () => undefined} />
      </VennbaseProvider>,
    );

    expect(app.container.textContent).toContain("Loading tags…");
    expect(app.container.textContent).not.toContain("No tags yet.");

    await act(async () => {
      query.resolve([]);
      await flushMicrotasks();
    });

    await waitFor(() => {
      expect(app.container.textContent).toContain("No tags yet.");
    });
    await app.unmount();
  });

  it("shows an optimistic tag immediately without waiting for refresh completion", async () => {
    const row = dogRow();
    const db = new FakeDb();
    db.queryResult = [];
    const refresh = deferred<Array<RowHandle<typeof woofSchema, "tags">>>();

    const app = await renderApp(
      <VennbaseProvider db={db as unknown as Vennbase<typeof woofSchema>}>
        <TagsPanel
          row={row}
          onCreateTag={async () => {
            db.peekQueryResult = [tagRow("tag_3", "friendly", 102)];
            db.queryResult = refresh.promise;
            db.emitLocalMutation();
          }}
        />
      </VennbaseProvider>,
    );

    await waitFor(() => {
      expect(app.container.textContent).toContain("No tags yet.");
    });

    const input = app.container.querySelector("#tag-input") as HTMLInputElement;
    const button = app.container.querySelector("button[type=\"submit\"]") as HTMLButtonElement;
    const form = button.closest("form") as HTMLFormElement;

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "friendly");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await flushMicrotasks();
    });

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });

    await waitFor(() => {
      expect(app.container.textContent).toContain("friendly");
      expect(button.textContent).toBe("Add tag");
      expect(input.value).toBe("");
    });

    await act(async () => {
      refresh.resolve([tagRow("tag_3", "friendly", 102)]);
      await flushMicrotasks();
    });

    await app.unmount();
  });
});
