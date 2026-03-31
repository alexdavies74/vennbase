import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { VennbaseProvider } from "@vennbase/react";

import App from "./App";
import { db } from "./db";

const root = document.getElementById("app");
if (!root) {
  throw new Error("No #app element found");
}

createRoot(root).render(
  <StrictMode>
    <VennbaseProvider db={db}>
      <App />
    </VennbaseProvider>
  </StrictMode>,
);
