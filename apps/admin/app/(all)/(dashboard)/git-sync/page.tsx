export default function GitSyncPage() {
  return (
    <div className="h-full w-full">
      <iframe
        src="/git-sync/ui/admin"
        className="h-full w-full border-none"
        title="GitHub Sync Admin Configuration"
      />
    </div>
  );
}
