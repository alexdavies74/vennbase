import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { PutBaseProvider } from "@putbase/react";

import { App } from "./App";
import { pb } from "./services";

const appElement = document.getElementById("app");
if (!appElement) {
  throw new Error("#app element missing");
}

createRoot(appElement).render(
  <StrictMode>
    <PutBaseProvider pb={pb}>
      <App />
    </PutBaseProvider>
  </StrictMode>,
);
