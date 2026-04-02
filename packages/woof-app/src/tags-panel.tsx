import { useState } from "react";
import { useMutation, useVennbase, useQuery } from "@vennbase/react";

import type { DogRowHandle, WoofSchema } from "./schema";
import { getErrorMessage } from "./utils";

interface DogTag {
  id: string;
  label: string;
  createdBy: string | null;
  createdAt: number | null;
}

function mapDogTags(rows: Array<{ id: string; fields: Record<string, unknown> }> | undefined): DogTag[] {
  if (!rows) {
    return [];
  }

  return rows
    .map((row) => {
      const label = typeof row.fields.label === "string" ? row.fields.label.trim() : "";
      if (!label) {
        return null;
      }

      return {
        id: row.id,
        label,
        createdBy: typeof row.fields.createdBy === "string" ? row.fields.createdBy : null,
        createdAt: typeof row.fields.createdAt === "number" ? row.fields.createdAt : null,
      } satisfies DogTag;
    })
    .filter((row): row is DogTag => row !== null);
}

export interface TagsPanelProps {
  row: DogRowHandle;
  onCreateTag(label: string): Promise<void>;
}

export function TagsPanel({ row, onCreateTag }: TagsPanelProps) {
  const db = useVennbase<WoofSchema>();
  const [tagInput, setTagInput] = useState("");
  const [validationError, setValidationError] = useState("");
  const tagsQuery = useQuery(db, "tags", {
    in: row,
    orderBy: "createdAt",
    order: "asc",
    limit: 100,
  });
  const createTag = useMutation(async (label: string) => {
    await onCreateTag(label);
    void tagsQuery.refresh();
  });
  const tags = mapDogTags(tagsQuery.rows);

  const errorMessage = validationError
    || (createTag.error ? getErrorMessage(createTag.error, "Failed to add tag.") : "")
    || (tagsQuery.error ? getErrorMessage(tagsQuery.error, "Failed to load tags.") : "")
    || (tagsQuery.refreshError ? getErrorMessage(tagsQuery.refreshError, "Failed to refresh tags.") : "");

  return (
    <section className="tag-section">
      <h2>Tags</h2>
      {tagsQuery.status === "loading" ? <p className="muted">Loading tags…</p> : null}
      <ul className="tag-list">
        {tagsQuery.status === "success" && tags.length === 0 ? (
          <li className="tag-empty">No tags yet.</li>
        ) : tags.map((tag) => (
          <li key={tag.id} className="tag-item">
            <span className="tag-label">{tag.label}</span>
            {tag.createdBy ? <span className="tag-meta">by {tag.createdBy}</span> : null}
          </li>
        ))}
      </ul>
      <form
        className="tag-form"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = tagInput.trim();
          if (!trimmed) {
            setValidationError("Tag text is required.");
            return;
          }

          setValidationError("");
          void createTag.mutate(trimmed).then(() => {
            setTagInput("");
          }).catch(() => undefined);
        }}
      >
        <label htmlFor="tag-input">Add tag</label>
        <div className="tag-form-row">
          <input
            id="tag-input"
            maxLength={32}
            name="tag"
            placeholder="friendly"
            value={tagInput}
            onChange={(event) => {
              setTagInput(event.target.value);
              if (validationError) {
                setValidationError("");
              }
            }}
          />
          <button className="secondary" type="submit" disabled={createTag.status === "loading"}>
            {createTag.status === "loading" ? "Adding…" : "Add tag"}
          </button>
        </div>
      </form>
      <p className="muted">{errorMessage}</p>
    </section>
  );
}
