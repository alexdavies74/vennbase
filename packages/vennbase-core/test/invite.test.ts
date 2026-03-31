import { describe, expect, it } from "vitest";

import { VENNBASE_INVITE_TARGET_PARAM } from "../src/invites";
import { Vennbase } from "../src/vennbase";
import { defineSchema } from "../src/schema";

function buildDb(appBaseUrl = "https://woof.example") {
  return new Vennbase({
    schema: defineSchema({}),
    identityProvider: async () => ({ username: "test" }),
    appBaseUrl,
  });
}

describe("invite parsing", () => {
  it("creates and parses app invite links with a dedicated Vennbase param", () => {
    const db = buildDb("https://woof.example");
    const ref = {
      id: "row_abc",
      collection: "dogs",
      baseUrl: "https://workers.example/alex-1234abcd-federation",
    } as const;
    const link = db.createShareLink(ref, {
      token: "invite_xyz",
      rowId: ref.id,
      invitedBy: "test",
      createdAt: 1,
      role: "editor",
    });

    expect(link).toBe(
      `https://woof.example/?${VENNBASE_INVITE_TARGET_PARAM}=%7B%22ref%22%3A%7B%22id%22%3A%22row_abc%22%2C%22collection%22%3A%22dogs%22%2C%22baseUrl%22%3A%22https%3A%2F%2Fworkers.example%2Falex-1234abcd-federation%22%7D%2C%22shareToken%22%3A%22invite_xyz%22%7D`,
    );

    const parsed = db.parseInvite(link);
    expect(parsed).toEqual({
      ref,
      shareToken: "invite_xyz",
    });
  });

  it("parses structured invite payloads with a token", () => {
    const db = buildDb();
    const parsed = db.parseInvite(
      `https://woof.example/?${VENNBASE_INVITE_TARGET_PARAM}=${encodeURIComponent(JSON.stringify({
        ref: {
          id: "row_abc",
          collection: "dogs",
          baseUrl: "https://workers.example/alex-1234abcd-federation",
        },
        shareToken: "invite_xyz",
      }))}`,
    );

    expect(parsed.ref).toEqual({
      id: "row_abc",
      collection: "dogs",
      baseUrl: "https://workers.example/alex-1234abcd-federation",
    });
    expect(parsed.shareToken).toBe("invite_xyz");
  });

  it("parses structured invite payloads without a token", () => {
    const db = buildDb();
    const parsed = db.parseInvite(
      `https://woof.example/?${VENNBASE_INVITE_TARGET_PARAM}=${encodeURIComponent(JSON.stringify({
        ref: {
          id: "row_abc",
          collection: "dogs",
          baseUrl: "https://workers.example/alex-1234abcd-federation",
        },
      }))}`,
    );

    expect(parsed.ref).toEqual({
      id: "row_abc",
      collection: "dogs",
      baseUrl: "https://workers.example/alex-1234abcd-federation",
    });
    expect(parsed.shareToken).toBeUndefined();
  });

  it("rejects invite inputs without a Vennbase payload", () => {
    const db = buildDb();
    expect(() =>
      db.parseInvite("https://woof.example/?worker=https%3A%2F%2Fworkers.example%2Falex-1234abcd-federation%2Frows%2Frow_abc&token=invite_xyz"),
    ).toThrow("Invite input must include a Vennbase invite payload.");
  });

  it("rejects malformed invite payloads", () => {
    const db = buildDb();
    expect(() =>
      db.parseInvite(`https://woof.example/?${VENNBASE_INVITE_TARGET_PARAM}=${encodeURIComponent(JSON.stringify({
        shareToken: "invite_xyz",
      }))}`),
    ).toThrow("Invite payload must include a row ref.");
  });
});
