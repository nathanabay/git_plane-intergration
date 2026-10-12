export default function GitSyncPage() {
  return (
    <div className="h-full w-full">
      <iframe
        src="/git-sync/ui/admin"
        className="w-full border-none"
        // h-full collapses here: the dashboard container has no fixed height, so fill the viewport.
        style={{ height: "calc(100vh - 4rem)" }}
        title="GitHub Sync Admin Configuration"
      />
    </div>
  );
}
