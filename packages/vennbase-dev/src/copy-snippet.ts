const COPY_RESET_DELAY_MS = 1800;

const prompts = document.querySelectorAll("[data-copy-prompt]");

Array.prototype.forEach.call(prompts, (promptNode: Element) => {
  const prompt = promptNode as HTMLElement;
  const textarea = prompt.querySelector("[data-copy-snippet]") as HTMLTextAreaElement | null;
  const button = prompt.querySelector("[data-copy-button]") as HTMLButtonElement | null;

  if (!textarea || !button) {
    return;
  }

  const defaultLabel = button.textContent?.trim() || "Copy";
  let resetTimer: number | undefined;

  button.addEventListener("click", async () => {
    const copied = await copyPromptText(textarea);
    button.dataset.copyState = copied ? "success" : "error";
    button.textContent = copied ? "Copied" : "Copy failed";

    if (resetTimer) {
      window.clearTimeout(resetTimer);
    }

    resetTimer = window.setTimeout(() => {
      button.dataset.copyState = "idle";
      button.textContent = defaultLabel;
    }, COPY_RESET_DELAY_MS);
  });
});

async function copyPromptText(textarea: HTMLTextAreaElement): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(textarea.value);
      return true;
    }
  } catch {
    // Fall through to the selection-based copy path.
  }

  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    return document.execCommand("copy");
  } finally {
    textarea.blur();
  }
}
