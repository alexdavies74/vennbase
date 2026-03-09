import type { Puter } from "@heyputer/puter.js";

declare global {
  interface Window {
    puter?: Puter;
  }
}

export {};
