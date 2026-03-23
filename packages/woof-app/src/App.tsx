import { puter } from "@heyputer/puter.js";
import type { CrdtBinding, RowRef } from "@putbase/core";
import { useCrdt, useInviteFromLocation, useInviteLink, useMutation, usePutBase, useQuery, useRow, useSession } from "@putbase/react";
import { createYjsBinding } from "@putbase/yjs";
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";

import type { ChatEntry } from "./service";
import type { DogRowHandle, WoofSchema } from "./schema";
import { TagsPanel } from "./tags-panel";
import { getErrorMessage } from "./utils";
import { service } from "./services";

function SetupPanel(props: {
  initialError: string;
  onEnter(row: DogRowHandle): Promise<void>;
}) {
  const [dogName, setDogName] = useState("");
  const enterChat = useMutation(async (nextDogName: string) => service.enterChat({ dogName: nextDogName }));
  const isSubmitting = enterChat.status === "loading";

  const errorMessage = enterChat.error
    ? getErrorMessage(enterChat.error, "Failed to enter chat.")
    : props.initialError;

  return (
    <section className="panel">
      <h1>Adopt a dog</h1>
      <p className="muted">Create a room for your dog, or join an existing room via invite link.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = dogName.trim();
          if (!trimmed) {
            return;
          }

          void enterChat.mutate(trimmed).then((row) => {
            setDogName("");
            return props.onEnter(row);
          }).catch((error) => {
            console.error("[woof-app] enterChat failed", {
              error,
              dogName: trimmed,
            });
          });
        }}
      >
        <label htmlFor="dog-name">Dog name</label>
        <input
          id="dog-name"
          name="dogName"
          placeholder="Rex"
          required
          value={dogName}
          onChange={(event) => setDogName(event.target.value)}
        />
        <button className="primary" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Loading…" : "Enter chat"}
        </button>
      </form>
      <p className="muted">{errorMessage}</p>
    </section>
  );
}

function LoadingPanel(props: {
  message: string;
}) {
  return (
    <section className="panel panel-loading" aria-busy="true" aria-live="polite">
      <div className="loading-badge">Loading</div>
      <h1>Getting things ready</h1>
      <p className="muted loading-copy">{props.message}</p>
      <div className="loading-pulse" aria-hidden="true" />
    </section>
  );
}

function SignInPanel(props: {
  busy: boolean;
  errorMessage: string;
  hasInvite: boolean;
  onSignIn(): void;
}) {
  const description = props.hasInvite
    ? "Log in with Puter to join this shared dog room."
    : "Log in with Puter before creating or restoring a dog room.";

  return (
    <section className="panel">
      <h1>Adopt a dog</h1>
      <p className="muted">{description}</p>
      <button className="primary" type="button" disabled={props.busy} onClick={props.onSignIn}>
        {props.busy ? "Opening Puter…" : props.hasInvite ? "Log in to join invite" : "Log in with Puter"}
      </button>
      <p className="muted">{props.errorMessage}</p>
    </section>
  );
}

function ChatPanel(props: {
  currentUsername: string | null;
  flush(): Promise<void>;
  doc: Y.Doc;
  entries: ChatEntry[];
  row: DogRowHandle;
}) {
  const [message, setMessage] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sendTurn = useMutation(async (content: string) => {
    await service.sendTurn(props.row, {
      content,
      doc: props.doc,
      flush: props.flush,
      puterAI: puter.ai,
    });
  });

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [props.entries]);

  return (
    <>
      <div ref={containerRef} id="messages">
        {props.entries.map((entry) => (
          <div key={entry.id} className={`message ${entry.userType === "dog" ? "dog" : "user"}`}>
            {entry.userType === "dog" ? String(props.row.fields.name ?? "") : "You"}: {entry.content}
          </div>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = message.trim();
          if (!trimmed) {
            return;
          }

          void sendTurn.mutate(trimmed).then(() => {
            setMessage("");
          }).catch(() => undefined);
        }}
      >
        <label htmlFor="message-input">Message</label>
        <textarea
          id="message-input"
          rows={3}
          placeholder="Say hello"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <button className="primary" type="submit" disabled={sendTurn.status === "loading" || !props.currentUsername}>
          {sendTurn.status === "loading" ? "Sending…" : "Send"}
        </button>
      </form>
      <p className="muted">{sendTurn.error ? getErrorMessage(sendTurn.error, "Failed to send message.") : ""}</p>
    </>
  );
}

function RoomScreen(props: {
  currentUsername: string | null;
  onRelinquished(): Promise<void>;
  row: DogRowHandle;
}) {
  const db = usePutBase<WoofSchema>();
  const [copyStatus, setCopyStatus] = useState("");
  const bindingRef = useRef<CrdtBinding<Y.Doc> | null>(null);
  if (bindingRef.current === null) {
    bindingRef.current = createYjsBinding(Y);
  }
  const inviteLink = useInviteLink(db, props.row.ref);
  const crdt = useCrdt(props.row, bindingRef.current);
  const relinquish = useMutation(async () => {
    await service.relinquish();
    await props.onRelinquished();
  });
  const entries = service.getChatEntries(crdt.value, props.currentUsername);

  return (
    <section className="panel">
      <h1>{String(props.row.fields.name ?? "")}&apos;s Room</h1>
      <div className="toolbar">
        <button
          id="copy-link"
          className="secondary"
          type="button"
          disabled={!inviteLink.inviteLink}
          onClick={() => {
            if (!inviteLink.inviteLink) {
              return;
            }

            void navigator.clipboard.writeText(inviteLink.inviteLink).then(() => {
              setCopyStatus("Invite link copied.");
            }).catch(() => {
              setCopyStatus("Could not copy invite link.");
            });
          }}
        >
          Copy link
        </button>
        <button
          id="relinquish"
          className="secondary"
          type="button"
          onClick={() => {
            void relinquish.mutate().catch(() => undefined);
          }}
        >
          Relinquish Dog
        </button>
      </div>
      <p className="muted">
        {inviteLink.inviteLink ? <a id="invite-link" href={inviteLink.inviteLink}>{inviteLink.inviteLink}</a> : "Could not create invite link yet."}
        {" "}
        <span id="invite-status">
          {copyStatus || (inviteLink.error ? getErrorMessage(inviteLink.error, "Could not create invite link yet.") : "")}
        </span>
      </p>
      <TagsPanel
        row={props.row}
        onCreateTag={(label) => service.createTag(props.row, label)}
      />
      <ChatPanel currentUsername={props.currentUsername} doc={crdt.value} entries={entries} flush={crdt.flush} row={props.row} />
      <p className="muted">{relinquish.error ? getErrorMessage(relinquish.error, "Failed to relinquish dog.") : ""}</p>
    </section>
  );
}

export function App() {
  const db = usePutBase<WoofSchema>();
  const session = useSession(db);
  const signedInUser =
    session.status === "success" && session.data?.signedIn
      ? session.data.user
      : null;
  const [loginError, setLoginError] = useState("");
  const [loginStatus, setLoginStatus] = useState<"idle" | "loading">("idle");
  const [readyStatus, setReadyStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [readyError, setReadyError] = useState("");
  const [dismissedDogRef, setDismissedDogRef] = useState<RowRef<"dogs"> | null>(null);
  const invite = useInviteFromLocation<WoofSchema, DogRowHandle>(db, {
    clearLocation: (url) => {
      url.pathname = url.pathname === "/join" ? "/" : url.pathname;
      url.search = "";
      url.hash = "";
      return url.toString();
    },
    open: async (inviteInput, client) => service.expectDogRow(await client.openInvite(inviteInput)),
    onOpen: (nextRow) => {
      setDismissedDogRef(null);
      service.activateHistory(nextRow);
    },
  });
  const invitePending = invite.hasInvite;
  const inviteRow = invite.status === "success" ? invite.data ?? null : null;
  const dogHistory = useQuery(
    db,
    "dogHistory",
    signedInUser
      ? {
        where: { status: "active" },
        limit: 1,
      }
      : null,
  );
  const activeHistoryRow = dogHistory.rows.find((historyRow) => {
    if (!dismissedDogRef) {
      return true;
    }
    const dogRef = historyRow.fields.dogRef;
    return dogRef.id !== dismissedDogRef.id || dogRef.baseUrl !== dismissedDogRef.baseUrl;
  }) ?? null;
  const activeRowRef = inviteRow ? null : activeHistoryRow?.fields.dogRef ?? null;
  const openedActiveRow = useRow(db, activeRowRef, {
    enabled: !!activeRowRef,
  });
  const restoredRow = openedActiveRow.status === "success" ? openedActiveRow.data : null;
  const row = inviteRow ?? restoredRow;
  const bootError = invite.status === "error"
    ? getErrorMessage(invite.error, "Failed to join invite link.")
    : dogHistory.status === "error"
      ? getErrorMessage(dogHistory.error, "Could not restore saved room.")
      : openedActiveRow.status === "error"
        ? getErrorMessage(openedActiveRow.error, "Could not reopen saved room.")
        : readyStatus === "error"
          ? readyError
          : "";
  const bootLoading =
    invite.status === "loading"
    || dogHistory.status === "loading"
    || (!!activeRowRef && openedActiveRow.status === "loading")
    || (session.status === "success" && session.data?.signedIn && readyStatus !== "ready" && readyStatus !== "error");

  useEffect(() => {
    if (session.status !== "success" || !session.data?.signedIn) {
      setReadyStatus("idle");
      setReadyError("");
      return;
    }

    let cancelled = false;
    setReadyStatus("loading");
    setReadyError("");
    void db.ensureReady()
      .then(() => {
        if (cancelled) {
          return;
        }
        setReadyStatus("ready");
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setReadyStatus("error");
        setReadyError(getErrorMessage(error, "Could not initialize write access."));
      });

    return () => {
      cancelled = true;
    };
  }, [db, session.data, session.status]);

  if (session.status === "loading") {
    return <SignInPanel busy errorMessage="" hasInvite={invitePending} onSignIn={() => undefined} />;
  }

  if (session.status === "error") {
    return (
      <SignInPanel
        busy={loginStatus === "loading"}
        errorMessage={getErrorMessage(session.error, "Could not initialize app.")}
        hasInvite={invitePending}
        onSignIn={() => undefined}
      />
    );
  }

  if (!session.data?.signedIn) {
    return (
      <SignInPanel
        busy={loginStatus === "loading"}
        errorMessage={loginError}
        hasInvite={invitePending}
        onSignIn={() => {
          setLoginError("");
          setLoginStatus("loading");
          void session.signIn()
            .catch((error) => {
              setLoginError(getErrorMessage(error, "Could not sign in."));
            })
            .finally(() => {
              setLoginStatus("idle");
            });
        }}
      />
    );
  }

  if (bootLoading) {
    return (
      <LoadingPanel
        message="Loading app data…"
      />
    );
  }

  if (!row) {
    return (
      <SetupPanel
        initialError={bootError}
        onEnter={async (nextRow) => {
          setDismissedDogRef(null);
          void nextRow;
        }}
      />
    );
  }

  return (
    <RoomScreen
      currentUsername={signedInUser?.username ?? null}
      row={row}
      onRelinquished={async () => {
        setDismissedDogRef(row.ref);
      }}
    />
  );
}
