import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme.ts"; // applies the saved theme before first paint — must stay the first import (see theme.ts)
import App from "./App.tsx";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("no #root element in index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
