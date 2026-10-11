import { createRoot } from "react-dom/client";
import { AdminPage } from "./client/Admin.tsx";
import { WorkspacePage } from "./client/Workspace.tsx";
import { Link, usePathname } from "./client/common.tsx";
import { parseLocation } from "./client/router.ts";
import "./styles.css";

function App() {
  const route = parseLocation(usePathname());
  switch (route.name) {
    case "admin":
      return <AdminPage />;
    case "notfound":
      return (
        <main>
          <h1>Page not found</h1>
          <p>This page is not part of the git-sync settings. <Link href="/git-sync/ui/admin">Instance settings</Link></p>
        </main>
      );
    default:
      return <WorkspacePage route={route} />;
  }
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
