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
const service = new WoofService(rooms);

let currentProfile: DogProfile | null = null;
let latestTimestamp = 0;

async function boot() {
  try {
    await rooms.init();
  } catch (error) {
    console.error("[woof-app] boot/init failed", error);
    renderSetup();
    return;
  }

  const restored = service.restoreProfile();
  if (restored) {
    currentProfile = restored;
    renderChat(restored);
    await refreshMessages();
    startPolling();
    return;
  }

  renderSetup();
}

function renderSetup() {
  stopPolling();

  app.innerHTML = `
    <section class="panel">
      <h1>Adopt a dog</h1>
      <p class="muted">Create a room for your dog, or join an existing room via invite link.</p>
      <form id="setup-form">
        <label for="dog-name">Dog name</label>
        <input id="dog-name" name="dogName" placeholder="Rex" required />

        <label for="invite-input">Invite link or worker URL (optional)</label>
        <input id="invite-input" name="invite" placeholder="https://..." />

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
    const inviteInput = String(formData.get("invite") ?? "").trim();

    if (!dogName) {
      setupError.textContent = "Dog name is required.";
      return;
    }

    try {
      const profile = await service.enterChat({
        dogName,
        inviteInput: inviteInput || undefined,
      });
      currentProfile = profile;
      latestTimestamp = 0;

      renderChat(profile);
      await refreshMessages();
      startPolling();
    } catch (error) {
      console.error("[woof-app] enterChat failed", {
        error,
        dogName,
        hasInviteInput: Boolean(inviteInput),
      });
      setupError.textContent = getErrorMessage(error, "Failed to enter chat.");
    }
  });
}

async function renderChat(profile: DogProfile) {
  app.innerHTML = `
    <section class="panel">
      <h1>${escapeHtml(profile.dogName)}'s Room</h1>
      <div class="toolbar">
        <button id="copy-link" class="secondary" type="button">Copy link</button>
        <button id="relinquish" class="secondary" type="button">Relinquish Dog</button>
      </div>
      <p id="invite-status" class="muted"></p>
      <div id="messages"></div>
      <form id="message-form">
        <label for="message-input">Message</label>
        <textarea id="message-input" rows="3" placeholder="Say hello"></textarea>
        <button class="primary" type="submit">Send</button>
      </form>
      <p id="chat-error" class="muted"></p>
    </section>
  `;

  const inviteStatus = document.getElementById("invite-status") as HTMLParagraphElement;
  const copyButton = document.getElementById("copy-link") as HTMLButtonElement;

  try {
    const inviteLink = await service.generateInviteLink(profile.room);
    inviteStatus.textContent = inviteLink;

    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(inviteLink);
        inviteStatus.textContent = "Invite link copied.";
      } catch {
        inviteStatus.textContent = inviteLink;
      }
    });
  } catch {
    inviteStatus.textContent = "Could not create invite link yet.";
  }

  const relinquishButton = document.getElementById("relinquish") as HTMLButtonElement;
  relinquishButton.addEventListener("click", () => {
    service.relinquish();
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

  for (const message of messages) {
    const payload = normalizeMessageBody(message.body);
    const div = document.createElement("div");
    div.className = `message ${payload.userType === "dog" ? "dog" : "user"}`;
    div.textContent = `${payload.userType === "dog" ? "Dog" : "You"}: ${payload.content}`;
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

void boot();
