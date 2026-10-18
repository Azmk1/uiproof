import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Home } from "./pages/Home.jsx";
import { Inbox } from "./pages/Inbox.jsx";
import { Settings } from "./pages/Settings.jsx";

/**
 * A two-route application with a hand-rolled router, so the fixture needs no router
 * dependency. It is served by `vite preview`, whose SPA fallback returns this document for
 * `/settings` as well as `/`.
 */
const ROUTES = {
  "/": Home,
  "/inbox": Inbox,
  "/settings": Settings,
};

function currentPath() {
  return window.location.pathname.replace(/\/+$/, "") || "/";
}

function App() {
  const [path, setPath] = useState(currentPath);

  useEffect(() => {
    const onPopState = () => setPath(currentPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const Page = ROUTES[path] ?? Home;
  return (
    <div className="shell">
      <nav aria-label="Sections">
        <a href="/" aria-current={path === "/" ? "page" : undefined}>
          Support
        </a>
        <a href="/inbox" aria-current={path === "/inbox" ? "page" : undefined}>
          Inbox
        </a>
        <a href="/settings" aria-current={path === "/settings" ? "page" : undefined}>
          Settings
        </a>
      </nav>
      <Page />
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
