import { useAcceptInviteFromUrl, useMutation, useQuery, useRow, useSession, useShareLink } from "@covedb/react";
import { useEffect, useState } from "react";
import type { RowHandle } from "@covedb/core";
import { db } from "./db";
import type { Schema } from "./schema";

// Convenience type aliases
export type BoardHandle = RowHandle<Schema, "boards">;
export type RecentBoardHandle = RowHandle<Schema, "recentBoards">;
export type CardHandle = RowHandle<Schema, "cards">;

async function rememberRecentBoard(board: BoardHandle): Promise<void> {
  // `recentBoards` is declared as `in: ["user"]`, so omitting `in` uses the
  // current signed-in user's built-in user row.
  const existingRecentBoards = await db.query("recentBoards", {
    index: "byBoardRef",
    value: board.ref,
    limit: 1,
  });
  const existingRecentBoard = existingRecentBoards[0] ?? null;

  if (existingRecentBoard) {
    const updatedRecentBoardWrite = db.update("recentBoards", existingRecentBoard.ref, {
      openedAt: Date.now(),
    });
    await updatedRecentBoardWrite.committed;
    return;
  }

  const recentBoardWrite = db.create("recentBoards", {
    boardRef: board.ref,
    openedAt: Date.now(),
  });
  await recentBoardWrite.committed;
}

async function loadRecentBoards(): Promise<RecentBoardHandle[]> {
  // This query also runs inside the current signed-in user's implicit `user` scope.
  return db.query("recentBoards", {
    index: "byOpenedAt",
    order: "desc",
    limit: 10,
  });
}

async function openRecentBoard(recentBoard: RecentBoardHandle): Promise<BoardHandle> {
  const row = await db.getRow(recentBoard.fields.boardRef);
  await rememberRecentBoard(row);
  return row;
}

// ─── Top-level app ───────────────────────────────────────────────────────────

export default function App() {
  const [board, setBoard] = useState<BoardHandle | null>(null);
  const [loginError, setLoginError] = useState("");
  const [loginStatus, setLoginStatus] = useState<"idle" | "loading">("idle");
  const session = useSession(db);
  const signedIn = session.status === "success" && session.data?.signedIn === true;
  const incomingInvite = useAcceptInviteFromUrl<Schema, BoardHandle>(db, {
    enabled: board === null,
    onOpen: (nextBoard) => {
      void rememberRecentBoard(nextBoard).catch(console.error);
      setBoard(nextBoard);
    },
  });
  const invitePending = incomingInvite.hasInvite;
  const inviteError = incomingInvite.error instanceof Error
    ? incomingInvite.error.message
    : incomingInvite.status === "error"
      ? "Failed to open invite link."
      : "";

  return !signedIn
    ? (
      <main>
        <h1>CoveDB Todo</h1>
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
    : invitePending && incomingInvite.status !== "error"
      ? <OpeningInviteView />
      : <LandingView errorMessage={inviteError} onBoard={setBoard} />;
}

// ─── Landing: create or join ──────────────────────────────────────────────────

function LandingView({ errorMessage, onBoard }: { errorMessage?: string; onBoard: (b: BoardHandle) => void }) {
  const [title, setTitle] = useState("");
  const [recentBoards, setRecentBoards] = useState<RecentBoardHandle[]>([]);
  const [recentBoardsError, setRecentBoardsError] = useState("");

  const createBoard = useMutation(async (t: string) => {
    const boardWrite = db.create("boards", { title: t });
    const board = boardWrite.value;
    await boardWrite.committed;
    await rememberRecentBoard(board);
    return board;
  });
  const openRecent = useMutation(async (recentBoard: RecentBoardHandle) => openRecentBoard(recentBoard));

  useEffect(() => {
    let cancelled = false;

    void loadRecentBoards()
      .then((rows) => {
        if (!cancelled) {
          setRecentBoards(rows);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "Could not load recent boards.";
          setRecentBoardsError(message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>CoveDB Todo</h1>

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
        {errorMessage ? <p className="error">{errorMessage}</p> : null}
      </section>

      {recentBoards.length > 0 ? (
        <section>
          <h2>Recent boards</h2>
          <ul>
            {recentBoards.map((recentBoard) => (
              <RecentBoardListItem
                key={recentBoard.id}
                onOpen={(boardRow) => openRecent.mutate(boardRow).then((board) => onBoard(board))}
                recentBoard={recentBoard}
              />
            ))}
          </ul>
          {openRecent.error ? <p className="error">Failed to open recent board.</p> : null}
        </section>
      ) : null}

      {recentBoardsError ? <p className="error">{recentBoardsError}</p> : null}
    </main>
  );
}

function RecentBoardListItem(props: {
  onOpen: (recentBoard: RecentBoardHandle) => Promise<void>;
  recentBoard: RecentBoardHandle;
}) {
  const board = useRow(db, props.recentBoard.fields.boardRef);
  const boardRow = board.status === "success" ? board.data : null;

  const label = boardRow
    ? boardRow.fields.title
    : board.status === "error"
      ? "Unavailable board"
      : "Loading board…";

  return (
    <li>
      <button
        className="secondary small"
        type="button"
        onClick={() => {
          props.onOpen(props.recentBoard)
            .catch(console.error);
        }}
      >
        Open
      </button>
      {" "}
      {label}
    </li>
  );
}

function OpeningInviteView() {
  return (
    <main>
      <section>
        <h1>CoveDB Todo</h1>
        <h2>Opening shared board</h2>
        <p className="muted">Joining the invite and loading the board…</p>
      </section>
    </main>
  );
}

// ─── Board view: cards + invite ───────────────────────────────────────────────

function BoardView({ board, onLeave }: { board: BoardHandle; onLeave: () => void }) {
  const [text, setText] = useState("");

  const { rows: cards } = useQuery<Schema, "cards">(db, "cards", {
    in: board.ref,
    index: "byCreatedAt",
    order: "asc",
  });

  const { shareLink } = useShareLink(db, board.ref);

  const addCard = useMutation(async (cardText: string) => {
    const cardWrite = db.create("cards", { text: cardText, done: false, createdAt: Date.now() }, { in: board.ref });
    await cardWrite.committed;
  });

  const toggleDone = useMutation(async (card: CardHandle) => {
    const updatedCardWrite = db.update("cards", card.ref, { done: !card.fields.done });
    await updatedCardWrite.committed;
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
        {shareLink
          ? (
            <button
              className="secondary small"
              onClick={() => navigator.clipboard.writeText(shareLink)}
            >
              Copy invite link
            </button>
          )
          : <span className="muted">Generating…</span>}
      </div>
    </main>
  );
}
