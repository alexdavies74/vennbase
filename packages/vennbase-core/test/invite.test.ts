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

function inviteUrl(payload: string): string {
  const url = new URL("https://woof.example/");
  url.searchParams.set(VENNBASE_INVITE_TARGET_PARAM, payload);
  return url.toString();
}

describe("invite parsing", () => {
  it("creates and parses compact app invite links for hosted workers", () => {
    const db = buildDb("https://woof.example");
    const ref = {
      id: "row_abc",
      collection: "dogs",
      baseUrl: "https://alex-1234abcd-federation.workers.example",
    } as const;
    const link = db.createShareLink(ref, {
      token: "invite_xyz",
      rowId: ref.id,
      invitedBy: "test",
      createdAt: 1,
      role: "all-editor",
    });

    expect(link).toBe(
      inviteUrl("1*abc*dogs*xyz*halex-1234abcd-federation.workers.example"),
    );

    const parsed = db.parseInvite(link);
    expect(parsed).toEqual({
      ref,
      shareToken: "invite_xyz",
    });
  });

  it("parses compact invite payloads with a token", () => {
    const db = buildDb();
    const parsed = db.parseInvite(inviteUrl("1*abc*dogs*xyz*halex-1234abcd-federation.workers.example"));

    expect(parsed.ref).toEqual({
      id: "row_abc",
      collection: "dogs",
      baseUrl: "https://alex-1234abcd-federation.workers.example",
    });
    expect(parsed.shareToken).toBe("invite_xyz");
  });

  it("parses compact invite payloads without a token", () => {
    const db = buildDb();
    const parsed = db.parseInvite(inviteUrl("1*abc*dogs**halex-1234abcd-federation.workers.example"));

    expect(parsed.ref).toEqual({
      id: "row_abc",
      collection: "dogs",
      baseUrl: "https://alex-1234abcd-federation.workers.example",
    });
    expect(parsed.shareToken).toBeUndefined();
  });

  it("creates and parses fallback invite links for custom worker URLs", () => {
    const db = buildDb("https://woof.example");
    const ref = {
      id: "row_custom",
      collection: "dogs",
      baseUrl: "https://workers.example/custom/alex",
    } as const;

    const link = db.createShareLink(ref, {
      token: "invite_xyz",
      rowId: ref.id,
      invitedBy: "test",
      createdAt: 1,
      role: "all-editor",
    });

    expect(new URL(link).searchParams.get(VENNBASE_INVITE_TARGET_PARAM)).toBe(
      "1*custom*dogs*xyz*uaHR0cHM6Ly93b3JrZXJzLmV4YW1wbGUvY3VzdG9tL2FsZXg",
    );

    expect(db.parseInvite(link)).toEqual({
      ref,
      shareToken: "invite_xyz",
    });
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
      db.parseInvite(inviteUrl("1*abc*dogs")),
    ).toThrow("Invite payload is malformed.");
  });

  it("rejects unsupported invite payload versions", () => {
    const db = buildDb();
    expect(() =>
      db.parseInvite(inviteUrl("2*abc*dogs*xyz*hworkers.example")),
    ).toThrow('Invite payload version "2" is unsupported.');
  });

  it("rejects invalid worker locators", () => {
    const db = buildDb();
    expect(() =>
      db.parseInvite(inviteUrl("1*abc*dogs*xyz*xworkers.example")),
    ).toThrow("Invite payload has an invalid worker locator.");
  });

  it("rejects legacy JSON invite payloads", () => {
    const db = buildDb();
    expect(() =>
      db.parseInvite(inviteUrl("{\"ref\":{\"id\":\"row_abc\"}}")),
    ).toThrow("Invite payload is malformed.");
  });
});
