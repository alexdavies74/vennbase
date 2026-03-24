// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RowHandle, type PutBase } from "@putbase/core";

import { PutBaseProvider } from "@putbase/react";
import { TagsPanel } from "../src/tags-panel";
import { woofSchema } from "../src/schema";

class FakeDb {
  async getSession() {
    return {
      signedIn: true as const,
      user: { username: "alex" },
    };
  }

  async query() {
    return [
      new RowHandle(
        {
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
        },
        {
          id: "tag_1",
          collection: "tags",
          owner: "alex",
          target: "https://worker.example/rows/tag_1",
        },
        { label: "playful", createdBy: "alex", createdAt: 100 },
      ),
      new RowHandle(
        {
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
        },
        {
          id: "tag_2",
          collection: "tags",
          owner: "alex",
          target: "https://worker.example/rows/tag_2",
        },
        { label: " ", createdBy: "alex", createdAt: 101 },
      ),
    ];
  }
}

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

afterEach(() => {
  document.body.innerHTML = "";
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("TagsPanel", () => {
  it("renders tags from the React query hook", async () => {
    const row = {
      id: "dog_1",
      collection: "dogs" as const,
      owner: "alex",
      target: "https://worker.example/rows/dog_1",
      fields: { name: "Rex" },
      connectCrdt: () => ({
        disconnect: () => undefined,
        flush: async () => undefined,
      }),
      toRef: () => ({
        id: "dog_1",
        collection: "dogs" as const,
        owner: "alex",
        target: "https://worker.example/rows/dog_1",
      }),
    };

    const app = await renderApp(
      <PutBaseProvider pb={new FakeDb() as unknown as PutBase<typeof woofSchema>}>
        <TagsPanel row={row} onCreateTag={async () => undefined} />
      </PutBaseProvider>,
    );

    await waitFor(() => {
      expect(app.container.textContent).toContain("playful");
      expect(app.container.querySelectorAll(".tag-item")).toHaveLength(1);
    });
    await app.unmount();
  });
});
