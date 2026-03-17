import { PutBaseProvider, useInviteLink, useMutation, useQuery, useSession } from "@putbase/react";
import { useEffect, useState } from "react";
import type { RowHandle, RowFields } from "@putbase/core";
import { db } from "./db";
import type { Schema } from "./schema";

// Convenience type aliases
export type BoardHandle = RowHandle<"boards", RowFields<Schema, "boards">, never, Schema>;
export type CardHandle = RowHandle<"cards", RowFields<Schema, "cards">, "boards", Schema>;

// ─── Top-level app ───────────────────────────────────────────────────────────

export default function App() {
  const [board, setBoard] = useState<BoardHandle | null>(null);
  const [loginError, setLoginError] = useState("");
  const [loginStatus, setLoginStatus] = useState<"idle" | "loading">("idle");
  const session = useSession({ client: db });
  const signedIn = session.status === "success" && session.data?.state === "signed-in";
  const invitePending = new URLSearchParams(window.location.search).has("target");

  useEffect(() => {
    if (!signedIn) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    if (params.has("target")) {
      db.openInvite(window.location.href)
        .then((handle) => {
          setBoard(handle as BoardHandle);
          window.history.replaceState({}, "", window.location.pathname);
        })
        .catch(console.error);
    }
  }, []);

  return (
    <PutBaseProvider client={db}>
      {!signedIn
        ? (
          <main>
            <h1>PutBase Todo</h1>
            <section>
              <h2>{invitePending ? "Log in to join board" : "Log in to start"}</h2>
              <p>{invitePending ? "Sign in with Puter to open this shared board." : "Sign in with Puter before creating or joining a board."}</p>
              <button
                type="button"
                disabled={loginStatus === "loading" || session.status === "loading"}
                onClick={() => {
                  setLoginError("");
                  setLoginStatus("loading");
                  void session.signIn()
                    .catch((error) => {
                      const message = error instanceof Error ? error.message : "Sign-in failed.";
                      setLoginError(message);
                    })
                    .finally(() => {
                      setLoginStatus("idle");
                    });
                }}
              >
                {loginStatus === "loading" || session.status === "loading" ? "Opening Puter…" : invitePending ? "Log in to join" : "Log in with Puter"}
              </button>
              {loginError ? <p className="error">{loginError}</p> : null}
            </section>
          </main>
        )
        : board
        ? <BoardView board={board} onLeave={() => setBoard(null)} />
        : <LandingView onBoard={setBoard} />}
    </PutBaseProvider>
  );
}

// ─── Landing: create or join ──────────────────────────────────────────────────

function LandingView({ onBoard }: { onBoard: (b: BoardHandle) => void }) {
  const [title, setTitle] = useState("");

  const createBoard = useMutation(async (t: string) => {
    const board = await db.put("boards", { title: t });
    return board;
  });

  return (
    <main>
      <h1>PutBase Todo</h1>

      <section>
        <h2>New board</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createBoard.mutate(title.trim())
              .then((b) => onBoard(b))
              .catch(console.error);
          }}
        >
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Board title"
            required
          />
          <button type="submit" disabled={createBoard.status === "loading"}>
            {createBoard.status === "loading" ? "Creating…" : "Create"}
          </button>
        </form>
        {createBoard.error != null && (
          <p className="error">Failed to create board.</p>
        )}
      </section>
    </main>
  );
}

// ─── Board view: cards + invite ───────────────────────────────────────────────

function BoardView({ board, onLeave }: { board: BoardHandle; onLeave: () => void }) {
  const [text, setText] = useState("");

  const { rows: cards } = useQuery<Schema, "cards">("cards", {
    in: board,
    index: "byCreatedAt",
    order: "asc",
  });

  const { data: inviteLink } = useInviteLink(board);

  const addCard = useMutation(async (cardText: string) => {
    await db.put("cards", { text: cardText, done: false, createdAt: Date.now() }, { in: board });
  });

  const toggleDone = useMutation(async (card: CardHandle) => {
    await db.update("cards", card, { done: !card.fields.done });
  });

  return (
    <main>
      <div className="toolbar">
        <h1>{board.fields.title}</h1>
        <button className="secondary small" onClick={onLeave}>← Back</button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = text.trim();
          if (!trimmed) return;
          addCard.mutate(trimmed)
            .then(() => setText(""))
            .catch(console.error);
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="New card"
          required
        />
        <button type="submit" disabled={addCard.status === "loading"}>
          Add card
        </button>
      </form>

      <ul>
        {cards.map((card) => (
          <li key={card.id} className={card.fields.done ? "done" : ""}>
            <button
              className="secondary small"
              onClick={() => toggleDone.mutate(card).catch(console.error)}
            >
              {card.fields.done ? "✓" : "○"}
            </button>
            {card.fields.text}
          </li>
        ))}
      </ul>

      <div className="invite-bar">
        <span>Invite others to collaborate:</span>
        {inviteLink
          ? (
            <button
              className="secondary small"
              onClick={() => navigator.clipboard.writeText(inviteLink)}
            >
              Copy invite link
            </button>
          )
          : <span className="muted">Generating…</span>}
      </div>
    </main>
  );
}
