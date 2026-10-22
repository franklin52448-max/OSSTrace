import { Analytics } from "@vercel/analytics/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme.ts"; // applies the saved theme before first paint — must stay the first import (see theme.ts)
import App from "./App.tsx";
import { ToastProvider } from "./kit/Toast.tsx";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("no #root element in index.html");

const queryClient = new QueryClient();

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
      <Analytics />
    </QueryClientProvider>
  </StrictMode>,
);
