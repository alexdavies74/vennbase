import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { CoveDBProvider } from "@covedb/react";

import { App } from "./App";
import { db } from "./services";

const appElement = document.getElementById("app");
if (!appElement) {
  throw new Error("#app element missing");
}

createRoot(appElement).render(
  <StrictMode>
    <CoveDBProvider db={db}>
      <App />
    </CoveDBProvider>
  </StrictMode>,
);
