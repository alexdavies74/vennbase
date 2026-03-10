import { puter } from "@heyputer/puter.js";
import { PuterFedError, PuterFedRooms, type Message } from "puter-federation-sdk";

import type { DogProfile } from "./profile";
import { WoofService } from "./service";

const appElement = document.getElementById("app");
if (!appElement) {
  throw new Error("#app element missing");
}
const app = appElement as HTMLDivElement;

const rooms = new PuterFedRooms({
  appBaseUrl: window.location.origin,
  puter,
});
const service = new WoofService(rooms, puter.kv);

let currentProfile: DogProfile | null = null;
let latestTimestamp = 0;

async function boot() {
  try {
    await rooms.init();
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
      latestTimestamp = 0;

      await renderChat(profile);
      await refreshMessages();
      startPolling();
      return;
    } catch (error) {
      console.error("[woof-app] invite join failed", {
        error,
        inviteInput,
      });
      await service.relinquish();
      currentProfile = null;
      latestTimestamp = 0;
      renderSetup(getErrorMessage(error, "Failed to join invite link."));
      return;
    }
  }

  try {
    const restored = await service.restoreProfile();
    if (restored) {
      currentProfile = restored;
      latestTimestamp = 0;

      await renderChat(restored);
      await refreshMessages();
      startPolling();
      return;
    }
  } catch (error) {
    console.error("[woof-app] profile restore failed", {
      error,
    });
    await service.relinquish();
    currentProfile = null;
    latestTimestamp = 0;
    renderSetup(getErrorMessage(error, "Could not restore saved room."));
    return;
  }

  renderSetup();
}

function renderSetup(initialError = "") {
  stopPolling();

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
      latestTimestamp = 0;

      await renderChat(profile);
      await refreshMessages();
      startPolling();
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
  app.innerHTML = `
    <section class="panel">
      <h1>${escapeHtml(profile.room.name)}'s Room</h1>
      <div class="toolbar">
        <button id="copy-link" class="secondary" type="button">Copy link</button>
        <button id="relinquish" class="secondary" type="button">Relinquish Dog</button>
      </div>
      <p class="muted">
        <a id="invite-link" href="#"></a>
        <span id="invite-status"></span>
      </p>
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
    const inviteLink = await service.generateInviteLink(profile.room);
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
    latestTimestamp = 0;
    currentProfile = null;
    renderSetup();
  });

  const form = document.getElementById("message-form") as HTMLFormElement;
  const chatError = document.getElementById("chat-error") as HTMLParagraphElement;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    chatError.textContent = "";

    const input = document.getElementById("message-input") as HTMLTextAreaElement;
    const content = input.value.trim();
    if (!content || !currentProfile) {
      return;
    }

    try {
      await service.sendTurn(currentProfile, content, puter.ai);

      input.value = "";
      await refreshMessages();
    } catch (error) {
      console.error("[woof-app] sendTurn failed", {
        error,
        roomId: currentProfile.room.id,
      });
      chatError.textContent = getErrorMessage(error, "Failed to send message.");
    }
  });
}

async function refreshMessages() {
  if (!currentProfile) {
    return;
  }

  const messages = await rooms.pollMessages(currentProfile.room, latestTimestamp);
  if (messages.length === 0) {
    return;
  }

  renderMessages(messages);

  const latest = messages[messages.length - 1];
  latestTimestamp = Math.max(latestTimestamp, latest.createdAt);
}

function renderMessages(messages: Message[]) {
  const container = document.getElementById("messages") as HTMLDivElement | null;
  if (!container) {
    return;
  }

  const dogLabel = currentProfile?.room.name || "Dog";

  for (const message of messages) {
    const payload = normalizeMessageBody(message.body);
    const div = document.createElement("div");
    div.className = `message ${payload.userType === "dog" ? "dog" : "user"}`;
    div.textContent = `${payload.userType === "dog" ? dogLabel : "You"}: ${payload.content}`;
    container.appendChild(div);
  }

  container.scrollTop = container.scrollHeight;
}

function normalizeMessageBody(body: Message["body"]): { userType: string; content: string } {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, Message["body"]>;
    return {
      userType: String(record.userType ?? "user"),
      content: String(record.content ?? ""),
    };
  }

  return {
    userType: "user",
    content: String(body),
  };
}

function startPolling() {
  service.startPolling(refreshMessages, 5000);
}

function stopPolling() {
  service.stopPolling();
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
  const hasToken = url.searchParams.has("token");
  const hasWorker = url.searchParams.has("worker");
  const hasOwnerRoom = url.searchParams.has("owner") && url.searchParams.has("room");

  return hasToken || hasWorker || hasOwnerRoom ? url.toString() : null;
}

function clearInviteLocation() {
  const clean = new URL(window.location.href);
  clean.pathname = clean.pathname === "/join" ? "/" : clean.pathname;
  clean.search = "";
  clean.hash = "";
  window.history.replaceState({}, "", clean.toString());
}

void boot();
