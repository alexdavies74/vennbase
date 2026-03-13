import { describe, expect, it } from "vitest";

import { PutBase } from "../src/putbase";
import { defineSchema } from "../src/schema";

function buildDb(appBaseUrl = "https://woof.example") {
  return new PutBase({
    schema: defineSchema({}),
    identityProvider: async () => ({ username: "test" }),
    appBaseUrl,
  });
}

describe("invite parsing", () => {
  it("creates and parses worker-based app invite links", () => {
    const db = buildDb("https://woof.example");
    const link = db.createInviteLink(
      { workerUrl: "https://workers.example/alex-1234abcd-federation/rooms/room_abc" },
      "invite_xyz",
    );

    expect(link).toBe(
      "https://woof.example/?worker=https%3A%2F%2Fworkers.example%2Falex-1234abcd-federation%2Frooms%2Froom_abc&token=invite_xyz",
    );

    const parsed = db.parseInviteInput(link);
    expect(parsed).toEqual({
      workerUrl: "https://workers.example/alex-1234abcd-federation/rooms/room_abc",
      inviteToken: "invite_xyz",
    });
  });

  it("supports worker URL input with token", () => {
    const db = buildDb();
    const parsed = db.parseInviteInput(
      "https://workers.example/alex-1234abcd-federation/rooms/room_abc?token=invite_xyz",
    );

    expect(parsed.workerUrl).toBe("https://workers.example/alex-1234abcd-federation/rooms/room_abc");
    expect(parsed.inviteToken).toBe("invite_xyz");
  });

  it("supports plain worker URL input", () => {
    const db = buildDb();
    const parsed = db.parseInviteInput("https://workers.example/alex-1234abcd-federation/rooms/room_abc");

    expect(parsed.workerUrl).toBe("https://workers.example/alex-1234abcd-federation/rooms/room_abc");
    expect(parsed.inviteToken).toBeUndefined();
  });

  it("rejects owner+room legacy invites", () => {
    const db = buildDb();
    expect(() =>
      db.parseInviteInput("https://woof.example/?owner=alex&room=room_abc&token=invite_xyz"),
    ).toThrow("owner/room parameters are no longer supported");
  });
});
