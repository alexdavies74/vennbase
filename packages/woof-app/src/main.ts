import { puter } from "@heyputer/puter.js";
import * as Y from "yjs";
import { PutBase, PuterFedError, type DbQueryWatchHandle } from "puter-federation-sdk";

import type { DogProfile } from "./profile";
import { woofSchema } from "./schema";
import { WoofService, type ChatEntry } from "./service";

const appElement = document.getElementById("app");
if (!appElement) {
  throw new Error("#app element missing");
}
const app = appElement as HTMLDivElement;

const doc = new Y.Doc();
const chatArray = doc.getArray<ChatEntry>("messages");

const db = new PutBase({
  appBaseUrl: window.location.origin,
  puter,
  schema: woofSchema,
});
const service = new WoofService(db, puter.kv, doc);

let currentProfile: DogProfile | null = null;
let currentUsername: string | null = null;
let tagsWatcher: DbQueryWatchHandle | null = null;

async function boot() {
  try {
    await db.init();
    const me = await db.whoAmI();
    currentUsername = me.username;
  } catch (error) {
    console.error("[woof-app] boot/init failed", error);
    renderSetup(getErrorMessage(error, "Could not initialize app."));
    return;
  }

  const inviteInput = getInviteInputFromLocation(window.location.href);
  if (inviteInput) {
    try {
      const profile = await service.joinFromInvite(inviteInput);
      clearInviteLocation();
      currentProfile = profile;

      await renderChat(profile);
      service.connectToRoom(profile);
      return;
    } catch (error) {
      console.error("[woof-app] invite join failed", {
        error,
        inviteInput,
      });
      await service.relinquish();
      currentProfile = null;
      renderSetup(getErrorMessage(error, "Failed to join invite link."));
      return;
    }
  }

  try {
    const restored = await service.restoreProfile();
    if (restored) {
      currentProfile = restored;

      await renderChat(restored);
      service.connectToRoom(restored);
      return;
    }
  } catch (error) {
    console.error("[woof-app] profile restore failed", {
      error,
    });
    await service.relinquish();
    currentProfile = null;
    renderSetup(getErrorMessage(error, "Could not restore saved room."));
    return;
  }

  renderSetup();
}

function renderSetup(initialError = "") {
  clearTagsWatcher();
  service.relinquish().catch(() => {});

  app.innerHTML = `
    <section class="panel">
      <h1>Adopt a dog</h1>
      <p class="muted">Create a room for your dog, or join an existing room via invite link.</p>
      <form id="setup-form">
        <label for="dog-name">Dog name</label>
        <input id="dog-name" name="dogName" placeholder="Rex" required />
        <button class="primary" type="submit">Enter chat</button>
      </form>
      <p id="setup-error" class="muted"></p>
    </section>
  `;

  const form = document.getElementById("setup-form") as HTMLFormElement;
  const setupError = document.getElementById("setup-error") as HTMLParagraphElement;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setupError.textContent = "";

    const formData = new FormData(form);
    const dogName = String(formData.get("dogName") ?? "").trim();

    if (!dogName) {
      setupError.textContent = "Dog name is required.";
      return;
    }

    try {
      const profile = await service.enterChat({
        dogName,
      });
      currentProfile = profile;

      await renderChat(profile);
      service.connectToRoom(profile);
    } catch (error) {
      console.error("[woof-app] enterChat failed", {
        error,
        dogName,
      });
      setupError.textContent = getErrorMessage(error, "Failed to enter chat.");
    }
  });

  if (initialError) {
    setupError.textContent = initialError;
  }
}

async function renderChat(profile: DogProfile) {
  clearTagsWatcher();
  const dogName = String(profile.row.fields.name ?? "");

  app.innerHTML = `
    <section class="panel">
      <h1>${escapeHtml(dogName)}'s Room</h1>
      <div class="toolbar">
        <button id="copy-link" class="secondary" type="button">Copy link</button>
        <button id="relinquish" class="secondary" type="button">Relinquish Dog</button>
      </div>
      <p class="muted">
        <a id="invite-link" href="#"></a>
        <span id="invite-status"></span>
      </p>
      <section class="tag-section">
        <h2>Tags</h2>
        <ul id="tag-list" class="tag-list"></ul>
        <form id="tag-form" class="tag-form">
          <label for="tag-input">Add tag</label>
          <div class="tag-form-row">
            <input id="tag-input" name="tag" maxlength="32" placeholder="friendly" />
            <button class="secondary" type="submit">Add tag</button>
          </div>
        </form>
        <p id="tag-error" class="muted"></p>
      </section>
      <div id="messages"></div>
      <form id="message-form">
        <label for="message-input">Message</label>
        <textarea id="message-input" rows="3" placeholder="Say hello"></textarea>
        <button class="primary" type="submit">Send</button>
      </form>
      <p id="chat-error" class="muted"></p>
    </section>
  `;

  const inviteLinkElement = document.getElementById("invite-link") as HTMLAnchorElement;
  const inviteStatus = document.getElementById("invite-status") as HTMLSpanElement;
  const copyButton = document.getElementById("copy-link") as HTMLButtonElement;

  try {
    const inviteLink = await service.generateInviteLink(profile.row);
    inviteLinkElement.href = inviteLink;
    inviteLinkElement.textContent = inviteLink;
    inviteStatus.textContent = "";

    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(inviteLink);
        inviteStatus.textContent = " Invite link copied.";
      } catch {
        inviteStatus.textContent = " Could not copy invite link.";
      }
    });
  } catch {
    inviteLinkElement.removeAttribute("href");
    inviteLinkElement.textContent = "Could not create invite link yet.";
    inviteStatus.textContent = "";
  }

  const relinquishButton = document.getElementById("relinquish") as HTMLButtonElement;
  relinquishButton.addEventListener("click", () => {
    void service.relinquish();
    currentProfile = null;
    clearTagsWatcher();
    renderSetup();
  });

  const tagList = document.getElementById("tag-list") as HTMLUListElement;
  const tagForm = document.getElementById("tag-form") as HTMLFormElement;
  const tagInput = document.getElementById("tag-input") as HTMLInputElement;
  const tagError = document.getElementById("tag-error") as HTMLParagraphElement;

  const renderTags = (tags: Awaited<ReturnType<typeof service.listTags>>) => {
    if (currentProfile?.row.id !== profile.row.id) {
      return;
    }

    tagList.innerHTML = "";

    if (tags.length === 0) {
      const empty = document.createElement("li");
      empty.className = "tag-empty";
      empty.textContent = "No tags yet.";
      tagList.appendChild(empty);
      tagError.textContent = "";
      return;
    }

    for (const tag of tags) {
      const item = document.createElement("li");
      item.className = "tag-item";

      const label = document.createElement("span");
      label.className = "tag-label";
      label.textContent = tag.label;
      item.appendChild(label);

      if (tag.createdBy) {
        const meta = document.createElement("span");
        meta.className = "tag-meta";
        meta.textContent = `by ${tag.createdBy}`;
        item.appendChild(meta);
      }

      tagList.appendChild(item);
    }

    tagError.textContent = "";
  };

  tagsWatcher = service.watchTags(profile, {
    onChange: renderTags,
    onError: (error) => {
      if (currentProfile?.row.id !== profile.row.id) {
        return;
      }
      tagError.textContent = getErrorMessage(error, "Failed to load tags.");
    },
  });

  tagForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!currentProfile) {
      return;
    }

    const value = tagInput.value.trim();
    if (!value) {
      tagError.textContent = "Tag text is required.";
      return;
    }

    tagError.textContent = "";
    try {
      await service.createTag(currentProfile, value);
      tagInput.value = "";
      await tagsWatcher?.refresh();
    } catch (error) {
      tagError.textContent = getErrorMessage(error, "Failed to add tag.");
    }
  });

  const form = document.getElementById("message-form") as HTMLFormElement;
  const chatError = document.getElementById("chat-error") as HTMLParagraphElement;

  // Observe CRDT changes and re-render messages reactively
  chatArray.observe(() => {
    renderFromDoc(profile);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    chatError.textContent = "";

    const input = document.getElementById("message-input") as HTMLTextAreaElement;
    const content = input.value.trim();
    if (!content || !currentProfile) {
      return;
    }

    try {
      input.value = "";
      await service.sendTurn(currentProfile, content, puter.ai);
    } catch (error) {
      console.error("[woof-app] sendTurn failed", {
        error,
        rowId: currentProfile.row.id,
      });
      chatError.textContent = getErrorMessage(error, "Failed to send message.");
    }
  });
}

function clearTagsWatcher() {
  if (tagsWatcher === null) {
    return;
  }

  tagsWatcher.disconnect();
  tagsWatcher = null;
}

function renderFromDoc(profile: DogProfile) {
  const container = document.getElementById("messages") as HTMLDivElement | null;
  if (!container) {
    return;
  }

  const dogLabel = String(profile.row.fields.name ?? "");
  const myUsername = currentUsername;

  const entries = chatArray.toArray().filter(
    (entry) => entry.threadUser === myUsername,
  );

  container.innerHTML = "";
  for (const entry of entries) {
    const div = document.createElement("div");
    div.className = `message ${entry.userType === "dog" ? "dog" : "user"}`;
    div.textContent = `${entry.userType === "dog" ? dogLabel : "You"}: ${entry.content}`;
    container.appendChild(div);
  }

  container.scrollTop = container.scrollHeight;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof PuterFedError) {
    const detailsParts: Array<string | number> = [error.code];
    if (error.status !== undefined) {
      detailsParts.push(error.status);
    }
    const details = detailsParts.join(", ");
    return details ? `${error.message} (${details})` : error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (hasStringMessage(error)) {
    return error.message;
  }

  return fallback;
}

function hasStringMessage(value: unknown): value is { message: string } {
  return (
    !!value &&
    typeof value === "object" &&
    "message" in value &&
    typeof (value as { message?: unknown }).message === "string" &&
    Boolean((value as { message: string }).message.trim())
  );
}

function getInviteInputFromLocation(href: string): string | null {
  const url = new URL(href);
  const hasWorker = url.searchParams.has("worker");
  return hasWorker ? url.toString() : null;
}

function clearInviteLocation() {
  const clean = new URL(window.location.href);
  clean.pathname = clean.pathname === "/join" ? "/" : clean.pathname;
  clean.search = "";
  clean.hash = "";
  window.history.replaceState({}, "", clean.toString());
}

void boot();
