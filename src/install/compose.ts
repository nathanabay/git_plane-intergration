// Installer: adds git-sync to (and removes it from) Plane's docker-compose.override.yaml. The operator's own
// entries, comments and Compose merge tags (!override, !reset) are kept; only what git-sync needs is touched.
import { YAMLMap, isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { Document } from "yaml";

export const GITSYNC_SERVICE = "git-sync";
export const FORK_IMAGES = { admin: "${GITSYNC_ADMIN_IMAGE:-plane-admin-gitsync:v1.4.2}", web: "${GITSYNC_WEB_IMAGE:-plane-frontend-gitsync:v1.4.2}" } as const;
export const PROXY_MOUNT = "./git-sync/Caddyfile:/etc/caddy/Caddyfile:ro";
const MARK = " Added by git-sync install.sh (./install.sh --uninstall removes it)";

export interface OverrideOptions {
  /** Run Plane's admin and web apps from the git-sync fork images (adds the Git Sync settings pages). */
  uiForks: boolean;
  /** "plane": route /git-sync/* through Plane's bundled proxy (mounts git-sync/Caddyfile into it). */
  proxy: "plane" | "external";
  /** An external reverse-proxy network (e.g. a host Caddy) that git-sync joins under the alias git-sync. */
  gatewayNetwork?: string;
}

// Compose's merge tags. Without them the parser drops the tag and the override changes meaning.
const composeTags = ["!override", "!reset"].flatMap((tag) => [
  { tag, collection: "seq" as const, resolve: (v: unknown) => v },
  { tag, collection: "map" as const, resolve: (v: unknown) => v },
  { tag, resolve: (v: string) => v },
]);

function load(text: string): Document {
  const doc = parseDocument(text.trim() ? text : "services: {}\n", { customTags: composeTags });
  if (doc.errors.length) throw new Error(`docker-compose.override.yaml is not valid YAML: ${doc.errors[0]?.message}`);
  if (doc.contents === null) doc.contents = doc.createNode({ services: {} }) as never;
  if (!isMap(doc.contents)) throw new Error("docker-compose.override.yaml must be a mapping at the top level");
  if (!doc.hasIn(["services"]) || doc.getIn(["services"]) === null) doc.setIn(["services"], doc.createNode({}));
  if (!isMap(doc.getIn(["services"]))) throw new Error("docker-compose.override.yaml: services must be a mapping");
  return doc;
}
const dump = (doc: Document) => doc.toString({ lineWidth: 0, flowCollectionPadding: false });

export function gitSyncService(opts: OverrideOptions): Record<string, unknown> {
  const service: Record<string, unknown> = {
    image: "${GITSYNC_IMAGE:-git-sync:local}",
    restart: "unless-stopped",
    depends_on: ["plane-db", "plane-redis"],
    env_file: ["git-sync.env"],
    environment: { GITHUB_CREDENTIAL_MARKER_PATH: "/var/lib/gitsync/credentials/bootstrap-retired" },
    volumes: ["./git-sync/github-app.pem:/run/secrets/github-app.pem:ro", "./git-sync/credential-state:/var/lib/gitsync/credentials"],
    healthcheck: {
      test: ["CMD", "node", "-e", "http.get('http://127.0.0.1:3100/git-sync/healthz', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"],
      interval: "30s", timeout: "10s", retries: 3, start_period: "20s",
    },
  };
  if (opts.gatewayNetwork) service.networks = { default: {}, [opts.gatewayNetwork]: { aliases: ["git-sync"] } };
  return service;
}

function seqHas(seq: unknown, value: string): boolean {
  return isSeq(seq) && seq.items.some((i) => (isScalar(i) ? i.value : i) === value);
}

/** Adds or refreshes git-sync's entries. Idempotent: merging twice gives the same text as merging once. */
export function mergeOverride(text: string, opts: OverrideOptions): string {
  const doc = load(text);
  const services = doc.getIn(["services"]) as YAMLMap;
  const existing = services.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === GITSYNC_SERVICE);
  const node = doc.createNode(gitSyncService(opts));
  if (existing) existing.value = node;
  else {
    services.add(doc.createPair(GITSYNC_SERVICE, node));
    const key = services.items.at(-1)!.key as { commentBefore?: string };
    key.commentBefore = MARK;
  }
  if (opts.uiForks) {
    for (const [name, image] of Object.entries(FORK_IMAGES)) {
      const current = doc.getIn(["services", name, "image"]);
      if (current === undefined || current === null || String(current).includes("gitsync")) doc.setIn(["services", name, "image"], image);
      else throw new Error(`docker-compose.override.yaml already sets services.${name}.image to ${String(current)}; remove it or use --keep-plane-ui`);
    }
  }
  if (opts.proxy === "plane") {
    const volumes = doc.getIn(["services", "proxy", "volumes"]);
    if (volumes === undefined || volumes === null) doc.setIn(["services", "proxy", "volumes"], doc.createNode([PROXY_MOUNT]));
    else if (!isSeq(volumes)) throw new Error("docker-compose.override.yaml: services.proxy.volumes must be a list");
    else if (!seqHas(volumes, PROXY_MOUNT)) {
      const other = volumes.items.find((i) => String(isScalar(i) ? i.value : "").includes(":/etc/caddy/Caddyfile"));
      if (other) throw new Error(`Plane's proxy already mounts its own Caddyfile (${String((other as { value?: unknown }).value)}); use --proxy external and add the /git-sync/* route to it yourself`);
      volumes.add(doc.createNode(PROXY_MOUNT));
    }
  }
  if (opts.gatewayNetwork && !doc.hasIn(["networks", opts.gatewayNetwork])) {
    doc.setIn(["networks", opts.gatewayNetwork], doc.createNode({ external: true }));
  }
  return dump(doc);
}

/** Removes everything mergeOverride adds. Entries the operator wrote are left alone. */
export function removeOverride(text: string): string {
  if (!text.trim()) return text;
  const doc = load(text);
  const gitsync = doc.getIn(["services", GITSYNC_SERVICE]);
  const gateways = isMap(gitsync) && isMap(gitsync.get("networks"))
    ? (gitsync.get("networks") as YAMLMap).items.map((p) => String(isScalar(p.key) ? p.key.value : p.key)).filter((n) => n !== "default") : [];
  doc.deleteIn(["services", GITSYNC_SERVICE]);
  const services = doc.getIn(["services"]) as YAMLMap;
  const dropIfEmpty = (name: string) => { const s = doc.getIn(["services", name]); if (isMap(s) && s.items.length === 0) doc.deleteIn(["services", name]); };
  for (const [name, image] of Object.entries(FORK_IMAGES)) {
    if (doc.getIn(["services", name, "image"]) === image) { doc.deleteIn(["services", name, "image"]); dropIfEmpty(name); }
  }
  const volumes = doc.getIn(["services", "proxy", "volumes"]);
  if (isSeq(volumes)) {
    volumes.items = volumes.items.filter((i) => (isScalar(i) ? i.value : i) !== PROXY_MOUNT);
    if (volumes.items.length === 0) { doc.deleteIn(["services", "proxy", "volumes"]); dropIfEmpty("proxy"); }
  }
  // A gateway network git-sync brought in goes too, unless another service still uses it.
  for (const net of gateways) {
    const used = services.items.some((p) => { const n = isMap(p.value) ? p.value.get("networks") : undefined;
      return (isMap(n) && n.has(net)) || seqHas(n, net); });
    if (!used) doc.deleteIn(["networks", net]);
  }
  const networks = doc.getIn(["networks"]);
  if (isMap(networks) && networks.items.length === 0) doc.deleteIn(["networks"]);
  return dump(doc);
}

export function hasGitSync(text: string): boolean {
  return text.trim() !== "" && load(text).hasIn(["services", GITSYNC_SERVICE]);
}
