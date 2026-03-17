import { puter } from "@heyputer/puter.js";
import { useInviteLink, useMutation, useSession } from "@putbase/react";
import { useEffect, useRef, useState } from "react";

import type { DogProfile } from "./profile";
import type { ChatEntry } from "./service";
import { useChatEntries, useRoomConnection } from "./app-hooks";
import { TagsPanel } from "./tags-panel";
import { getErrorMessage, clearInviteLocation, getInviteInputFromLocation } from "./utils";
import { service } from "./services";

function SetupPanel(props: {
  disabled: boolean;
  initialError: string;
  onEnter(profile: DogProfile): void;
}) {
  const [dogName, setDogName] = useState("");
  const enterChat = useMutation(async (nextDogName: string) => service.enterChat({ dogName: nextDogName }));
  const isSubmitting = enterChat.status === "loading";

  const errorMessage = enterChat.error
    ? getErrorMessage(enterChat.error, "Failed to enter chat.")
    : props.disabled
      ? "Initializing app…"
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

          void enterChat.mutate(trimmed).then((profile) => {
            setDogName("");
            props.onEnter(profile);
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
        <button className="primary" type="submit" disabled={props.disabled || isSubmitting}>
          {isSubmitting ? "Loading…" : "Enter chat"}
        </button>
      </form>
      <p className="muted">{errorMessage}</p>
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
  entries: ChatEntry[];
  profile: DogProfile;
}) {
  const [message, setMessage] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sendTurn = useMutation(async (content: string) => {
    await service.sendTurn(props.profile, content, puter.ai);
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
            {entry.userType === "dog" ? String(props.profile.row.fields.name ?? "") : "You"}: {entry.content}
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
  onRelinquished(): void;
  profile: DogProfile;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const inviteLink = useInviteLink(props.profile.row);
  const relinquish = useMutation(async () => {
    await service.relinquish();
    props.onRelinquished();
  });
  useRoomConnection(service, props.profile);
  const entries = useChatEntries(service, props.profile, props.currentUsername);

  return (
    <section className="panel">
      <h1>{String(props.profile.row.fields.name ?? "")}&apos;s Room</h1>
      <div className="toolbar">
        <button
          id="copy-link"
          className="secondary"
          type="button"
          disabled={!inviteLink.data}
          onClick={() => {
            if (!inviteLink.data) {
              return;
            }

            void navigator.clipboard.writeText(inviteLink.data).then(() => {
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
        {inviteLink.data ? <a id="invite-link" href={inviteLink.data}>{inviteLink.data}</a> : "Could not create invite link yet."}
        {" "}
        <span id="invite-status">
          {copyStatus || (inviteLink.error ? getErrorMessage(inviteLink.error, "Could not create invite link yet.") : "")}
        </span>
      </p>
      <TagsPanel
        profile={props.profile}
        onCreateTag={(label) => service.createTag(props.profile, label)}
      />
      <ChatPanel currentUsername={props.currentUsername} entries={entries} profile={props.profile} />
      <p className="muted">{relinquish.error ? getErrorMessage(relinquish.error, "Failed to relinquish dog.") : ""}</p>
    </section>
  );
}

export function App() {
  const session = useSession();
  const signedInUser =
    session.status === "success" && session.data?.state === "signed-in"
      ? session.data.user
      : null;
  const [bootError, setBootError] = useState("");
  const [bootStatus, setBootStatus] = useState<"idle" | "loading" | "ready">("idle");
  const [loginError, setLoginError] = useState("");
  const [loginStatus, setLoginStatus] = useState<"idle" | "loading">("idle");
  const [profile, setProfile] = useState<DogProfile | null>(null);
  const bootPromise = useRef<Promise<{
    error: unknown | null;
    fallbackMessage: string;
    profile: DogProfile | null;
  }> | null>(null);

  useEffect(() => {
    if (!signedInUser) {
      bootPromise.current = null;
      setBootStatus("idle");
      setProfile(null);
      setBootError("");
      return;
    }

    let cancelled = false;
    setBootStatus("loading");
    if (bootPromise.current === null) {
      const inviteInput = getInviteInputFromLocation(window.location.href);
      bootPromise.current = (async () => {
        try {
          if (inviteInput) {
            const joined = await service.joinFromInvite(inviteInput);
            clearInviteLocation();
            return {
              error: null,
              fallbackMessage: "Failed to join invite link.",
              profile: joined,
            };
          }

          return {
            error: null,
            fallbackMessage: "Could not restore saved room.",
            profile: await service.restoreProfile(),
          };
        } catch (error) {
          await service.relinquish();
          console.error("[woof-app] boot failed", {
            error,
            inviteInput,
          });
          return {
            error,
            fallbackMessage: inviteInput ? "Failed to join invite link." : "Could not restore saved room.",
            profile: null,
          };
        }
      })();
    }

    void bootPromise.current.then((result) => {
      if (cancelled) {
        return;
      }

      if (result.error) {
        setProfile(null);
        setBootError(getErrorMessage(result.error, result.fallbackMessage));
      } else {
        setProfile(result.profile);
        setBootError("");
      }

      setBootStatus("ready");
    });

    return () => {
      cancelled = true;
    };
  }, [signedInUser?.username]);

  const invitePending = getInviteInputFromLocation(window.location.href) !== null;

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

  if (session.data?.state !== "signed-in") {
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

  if (bootStatus === "loading") {
    return <SetupPanel disabled initialError="" onEnter={setProfile} />;
  }

  if (!profile) {
    return <SetupPanel disabled={false} initialError={bootError} onEnter={setProfile} />;
  }

  return (
    <RoomScreen
      currentUsername={signedInUser?.username ?? null}
      profile={profile}
      onRelinquished={() => {
        setProfile(null);
        setBootError("");
      }}
    />
  );
}
