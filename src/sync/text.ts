// Mirrored prose conversion. API contracts: Context7 /websites/developers_plane_so and /github/docs;
// Plane mention/HTML attributes are verified in makeplane/plane v1.4.2 content_validator.py and notification_task.py.
import { escapeHtml, safeUrl } from "../github/html.ts";

export interface TextContext {
  webOrigin: string;
  owner: string;
  repo: string;
  planeUserForGithubLogin?(login: string): Promise<{ id: string; displayName?: string } | null>;
  githubUserForPlaneId?(id: string): Promise<{ login?: string; displayName?: string } | null>;
}

// Conversion limits are independent of the webhook transport's payload limit.
const MAX_SOURCE = 256_000;
const MAX_OUTPUT = 1_000_000;
const MAX_DEPTH = 48;
function conversionLimit(): never {
  const error = new Error("mirrored text exceeds its conversion size, depth or work limit");
  error.name = "TextConversionLimitError";
  throw error;
}
class Budget {
  remaining: number;
  constructor(source: string) {
    if (source.length > MAX_SOURCE) conversionLimit();
    this.remaining = source.length * 32 + 4096;
  }
  take(count = 1): void { this.remaining -= count; if (this.remaining < 0) conversionLimit(); }
  depth(depth: number): void { if (depth > MAX_DEPTH) conversionLimit(); }
  output(value: string): string { if (value.length > MAX_OUTPUT) conversionLimit(); return value; }
}

// Scope lookup memoization to one conversion; never retain workspace/user data across calls.
function cachedContext(context?: TextContext): TextContext | undefined {
  if (!context) return undefined;
  const plane = new Map<string, ReturnType<NonNullable<TextContext["planeUserForGithubLogin"]>>>();
  const github = new Map<string, ReturnType<NonNullable<TextContext["githubUserForPlaneId"]>>>();
  return { ...context,
    ...(context.planeUserForGithubLogin ? { planeUserForGithubLogin: (login: string) => {
      let result = plane.get(login);
      if (!result) {
        if (plane.size + github.size >= 128) conversionLimit();
        result = context.planeUserForGithubLogin!(login).then((user) => {
          if (user && user.id.length > 256) conversionLimit();
          return user;
        });
        plane.set(login, result);
      }
      return result;
    } } : {}),
    ...(context.githubUserForPlaneId ? { githubUserForPlaneId: (id: string) => {
      let result = github.get(id);
      if (!result) {
        if (plane.size + github.size >= 128) conversionLimit();
        result = context.githubUserForPlaneId!(id).then((user) => {
          if (user && (user.login && user.login.length > 256 || user.displayName && user.displayName.length > 1000)) conversionLimit();
          return user;
        });
        github.set(id, result);
      }
      return result;
    } } : {}),
  };
}

function origin(context?: TextContext): string | null {
  const value = safeUrl(context?.webOrigin);
  return value ? new URL(value).origin : null;
}
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const repoPart = /^[A-Za-z0-9_.-]+$/;
function reference(url: string, context?: TextContext): { label: string; url: string } | null {
  const web = origin(context);
  if (!web) return null;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== web || parsed.search || parsed.hash) return null;
    const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/?$/.exec(parsed.pathname);
    if (!match) return null;
    return { label: `${match[1]}/${match[2]}#${match[3]}`, url: `${web}/${match[1]}/${match[2]}/issues/${match[3]}` };
  } catch { return null; }
}
const anchor = (label: string, url: string) => `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
const backticks = (text: string, minimum = 1) => {
  let length = minimum;
  for (const run of text.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
  return "`".repeat(length);
};

/** Parses inline syntax before enriching prose; code, destinations and image alt text are opaque. */
async function inline(text: string, context: TextContext | undefined, budget: Budget, enrich = true, tableCell = false, depth = 0): Promise<string> {
  budget.depth(depth + 1); budget.take(text.length);
  let out = "";
  const web = origin(context);
  for (let i = 0; i < text.length;) {
    budget.take();
    const tail = text.slice(i);
    if (text[i] === "\\" && /[\\`*_[\]{}()#+.!|><-]/.test(text[i + 1] ?? "")) {
      out += escapeHtml(text[i + 1]!); i += 2; continue;
    }
    const ticks = /^`+/.exec(tail)?.[0];
    if (ticks) {
      const rest = text.slice(i + ticks.length);
      let closing: RegExpExecArray | undefined;
      let scanned = 0;
      for (const run of rest.matchAll(/`+/g)) {
        budget.take(run.index + run[0].length - scanned); scanned = run.index + run[0].length;
        if (run[0].length === ticks.length) { closing = run; break; }
      }
      if (!closing) budget.take(rest.length - scanned);
      if (closing) {
        let body = rest.slice(0, closing.index);
        if (body.startsWith(" ") && body.endsWith(" ") && body.trim()) body = body.slice(1, -1);
        out += `<code>${escapeHtml(tableCell ? body.replace(/\\\|/g, "|") : body)}</code>`;
        i += ticks.length + closing.index + ticks.length; continue;
      }
      out += ticks; i += ticks.length; continue;
    }
    // Alternatives start with disjoint characters: no escaped-label backtracking explosion.
    const link = /^(!?)\[((?:\\[^\n]|[^\]\\\n])*)\]\((<[^<>\n]*>|(?:[^\s<>()\\]|\\[^\n]|\([^\s<>()\\]*\))*)(?:\s+"((?:\\[^\n]|[^"\\\n])*)")?\)/.exec(tail);
    if ((text[i] === "[" || text[i] === "!" && text[i + 1] === "[") && !link) budget.take(tail.length);
    const destination = link?.[3]?.replace(/^<([\s\S]*)>$/, "$1").replace(/\\([()[\]\\])/g, "$1");
    if (link && safeUrl(destination)) {
      const url = safeUrl(destination)!;
      const title = link[4] !== undefined ? ` title="${escapeHtml(link[4].replace(/\\(["\\])/g, "$1"))}"` : "";
      out += link[1] ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(link[2]!.replace(/\\([\\`*_[\]{}()#+.!|><-])/g, "$1"))}"${title}>`
        : `<a href="${escapeHtml(url)}"${title}>${await inline(link[2]!, context, budget, false, false, depth + 1)}</a>`;
      i += link[0].length; continue;
    }
    if (link) { out += escapeHtml(link[0]); i += link[0].length; continue; }
    const auto = /^(?:<https?:\/\/[^\s<>]+>|https?:\/\/[^\s<>]+)/.exec(tail)?.[0];
    if (auto) {
      let urlText = auto.startsWith("<") ? auto.slice(1, -1) : auto.replace(/[.,;!?]+$/, "");
      if (!auto.startsWith("<")) {
        let excess = 0;
        for (const char of urlText) { if (char === ")") excess++; else if (char === "(") excess--; }
        let end = urlText.length;
        while (excess > 0 && urlText[end - 1] === ")") { end--; excess--; }
        urlText = urlText.slice(0, end);
      }
      const url = safeUrl(urlText);
      if (url) {
        const ref = enrich ? reference(url, context) : null;
        out += anchor(ref?.label ?? urlText, ref?.url ?? url);
        i += auto.startsWith("<") ? auto.length : urlText.length; continue;
      }
    }
    if (enrich && web) {
      const before = text[i - 1] ?? "";
      const qualified = !/[\w/.-]/.test(before) ? /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)\b/.exec(tail) : null;
      const local = /^#([1-9][0-9]*)\b/.exec(tail);
      if (!/[\w/]/.test(before) && (qualified || local) && context) {
        const owner = qualified?.[1] ?? context.owner, repo = qualified?.[2] ?? context.repo, number = qualified?.[3] ?? local![1];
        if (repoPart.test(owner) && repoPart.test(repo) && ![".", ".."].includes(owner) && ![".", ".."].includes(repo)) {
          out += anchor(`${owner}/${repo}#${number}`, `${web}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`);
          i += (qualified ?? local)![0].length; continue;
        }
      }
      const mention = /^@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\b/.exec(tail);
      if (mention && text[i + mention[0].length] !== "/" && !/[\w@/]/.test(before)) {
        const login = mention[1]!;
        const user = await context?.planeUserForGithubLogin?.(login) ?? null;
        out += user?.id ? `<mention-component entity_identifier="${escapeHtml(user.id)}" entity_name="user_mention"></mention-component>`
          : anchor(`@${login}`, `${web}/${encodeURIComponent(login)}`);
        i += mention[0].length; continue;
      }
    }
    const emphasis = text[i] === "_" && /\w/.test(text[i - 1] ?? "") ? null : /^(\*\*|__|~~|\*|_)(?=\S)([\s\S]*?\S)\1/.exec(tail);
    if (emphasis && (!emphasis[1]!.includes("_")
      || (!/\w/.test(text[i - 1] ?? "") && !/\w/.test(text[i + emphasis[0].length] ?? "")))) {
      const tag = emphasis[1] === "~~" ? "del" : emphasis[1]!.length === 2 ? "strong" : "em";
      out += `<${tag}>${await inline(emphasis[2]!, context, budget, enrich, tableCell, depth + 1)}</${tag}>`; i += emphasis[0].length; continue;
    }
    // GitHub issue/PR prose preserves line breaks. Plain newline nodes survive an HTML round trip as well.
    if (text[i] === "\n") { out += "<br>"; i++; continue; }
    const entity = /^&(?:#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/i.exec(tail)?.[0];
    if (entity) { out += escapeHtml(decode(entity)); i += entity.length; continue; }
    out += escapeHtml(text[i]!); i++;
  }
  return budget.output(out);
}

function escapedAt(value: string, index: number): boolean {
  let slashes = 0;
  while (index > 0 && value[--index] === "\\") slashes++;
  return slashes % 2 === 1;
}
function tablePipes(value: string): string {
  let out = "", slashes = 0;
  for (const char of value) {
    if (char === "|" && slashes % 2 === 0) out += "\\";
    out += char; slashes = char === "\\" ? slashes + 1 : 0;
  }
  return out;
}
function cells(line: string): string[] {
  const out: string[] = []; let part = "", ticks = "";
  let body = line.trim().replace(/^\|/, "");
  if (body.endsWith("|") && !escapedAt(body, body.length - 1)) body = body.slice(0, -1);
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "\\") { part += "\\\\"; i++; continue; }
    if (body[i] === "\\" && body[i + 1] === "|") { part += "\\|"; i++; continue; }
    if (body[i] === "`") {
      const run = /^`+/.exec(body.slice(i))![0];
      ticks = ticks === run ? "" : ticks || run; part += run; i += run.length - 1; continue;
    }
    if (body[i] === "|" && !ticks) { out.push(part.trim()); part = ""; } else part += body[i];
  }
  out.push(part.trim()); return out;
}
const separator = (line: string) => cells(line).every((cell) => /^:?-{3,}:?$/.test(cell));

/** Safe, deterministic rich HTML for mirrored GitHub descriptions/comments, with code-aware enrichment. */
export async function textToHtml(text: string, context?: TextContext): Promise<string> {
  const budget = new Budget(text);
  return markdown(text, cachedContext(context), budget, 0);
}

async function markdown(text: string, context: TextContext | undefined, budget: Budget, depth: number): Promise<string> {
  budget.depth(depth); budget.take(text.length);
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (!lines[i]!.trim()) { i++; continue; }
    const candidateFence = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(lines[i]!);
    const fence = candidateFence && !candidateFence[2]!.includes("`") ? candidateFence : null;
    if (fence) {
      budget.depth(depth + 2);
      const code: string[] = []; const close = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      i++; while (i < lines.length && !close.test(lines[i]!)) code.push(lines[i++]!);
      if (i < lines.length) i++;
      const language = fence[2]!.trim().split(/\s+/)[0] ?? "";
      out.push(`<pre${language ? ` language="${escapeHtml(language)}"` : ""}><code>${escapeHtml(code.join("\n"))}${code.length ? "\n" : ""}</code></pre>`); continue;
    }
    if (i + 1 < lines.length && lines[i]!.includes("|") && separator(lines[i + 1]!)) {
      const header = cells(lines[i]!); const align = cells(lines[i + 1]!); i += 2;
      if (header.length > 1024) conversionLimit();
      const row = async (values: string[], tag: "th" | "td") => {
        if (values.length > 1024) conversionLimit();
        return `<tr>${(await Promise.all(values.map(async (value, n) => {
        const alignment = align[n]?.startsWith(":") ? align[n]?.endsWith(":") ? "center" : "left" : align[n]?.endsWith(":") ? "right" : null;
        return `<${tag}${alignment ? ` style="text-align: ${alignment}"` : ""}>${await inline(value, context, budget, true, true, depth + 4)}</${tag}>`;
      }))).join("")}</tr>`;
      };
      let table = `<table><thead>${await row(header, "th")}</thead><tbody>`;
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) table += await row(cells(lines[i++]!), "td");
      out.push(table + "</tbody></table>"); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(lines[i]!);
    if (heading) { out.push(`<h${heading[1]!.length}>${await inline(heading[2]!, context, budget, true, false, depth + 1)}</h${heading[1]!.length}>`); i++; continue; }
    const list = /^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(lines[i]!);
    if (list) {
      const tag = /^\d/.test(list[1]!) ? "ol" : "ul"; const start = tag === "ol" ? Number.parseInt(list[1]!, 10) : 1;
      let body = "";
      while (i < lines.length) {
        const item = /^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(lines[i]!);
        if (!item || (/^\d/.test(item[1]!) ? "ol" : "ul") !== tag) break;
        body += `<li>${await inline(item[2]!, context, budget, true, false, depth + 2)}</li>`; i++;
      }
      out.push(`<${tag}${start !== 1 ? ` start="${start}"` : ""}>${body}</${tag}>`); continue;
    }
    if (/^>\s?/.test(lines[i]!)) {
      const quote: string[] = []; while (i < lines.length && /^>\s?/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^>\s?/, ""));
      out.push(`<blockquote>${await markdown(quote.join("\n"), context, budget, depth + 1)}</blockquote>`); continue;
    }
    const paragraph: string[] = [lines[i++]!];
    while (i < lines.length && lines[i]!.trim() && !/^ {0,3}(?:`{3,}|~{3,}|#{1,6}\s|>\s?|[-+*]\s|\d+[.)]\s)/.test(lines[i]!)
      && !(i + 1 < lines.length && lines[i]!.includes("|") && separator(lines[i + 1]!))) paragraph.push(lines[i++]!);
    out.push(`<p>${await inline(paragraph.join("\n"), context, budget, true, false, depth + 1)}</p>`);
  }
  return budget.output(out.join(""));
}

type Node = { tag: string; attrs: Record<string, string>; children: (Node | string)[] };
function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, name: string) => {
    if (name[0] === "#") { const n = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "\ufffd"; }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" } as Record<string, string>)[name.toLowerCase()] ?? all;
  });
}
function parseHtml(html: string, budget: Budget): Node {
  const emptyAttrs = () => Object.create(null) as Record<string, string>;
  const root: Node = { tag: "root", attrs: emptyAttrs(), children: [] }; const stack = [root];
  let tokens = 0;
  for (let i = 0; i < html.length;) {
    budget.take(); if (++tokens > 16_000) conversionLimit();
    let token: string;
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4); i = end < 0 ? html.length : end + 3; continue;
    }
    if (html[i] !== "<") {
      const next = html.indexOf("<", i); const end = next < 0 ? html.length : next;
      stack.at(-1)!.children.push(decode(html.slice(i, end))); i = end; continue;
    }
    if (!/^<\/?[a-z]/i.test(html.slice(i, i + 3))) { stack.at(-1)!.children.push("<"); i++; continue; }
    let quote = "", end = i + 1;
    for (; end < html.length; end++) {
      budget.take(); const char = html[end]!;
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">" || char === "<") break;
    }
    if (html[end] !== ">") {
      stack.at(-1)!.children.push(decode(html.slice(i, end))); i = end; continue;
    }
    token = html.slice(i, end + 1); i = end + 1;
    const closing = /^<\/([\w-]+)/.exec(token);
    if (closing) { const index = stack.map((n) => n.tag).lastIndexOf(closing[1]!.toLowerCase()); if (index > 0) stack.length = index; continue; }
    const start = /^<([\w-]+)/.exec(token)!;
    const node: Node = { tag: start[1]!.toLowerCase(), attrs: emptyAttrs(), children: [] };
    // Scan attributes once; a global unanchored attribute regex rescans long invalid names.
    for (let cursor = start[0].length; cursor < token.length;) {
      while (/\s/.test(token[cursor] ?? "")) cursor++;
      const name = /^[\w:-]+/.exec(token.slice(cursor))?.[0];
      if (!name) { cursor++; continue; }
      cursor += name.length; while (/\s/.test(token[cursor] ?? "")) cursor++;
      if (token[cursor] !== "=") continue;
      cursor++; while (/\s/.test(token[cursor] ?? "")) cursor++;
      let value: string;
      if (token[cursor] === '"' || token[cursor] === "'") {
        const delimiter = token[cursor++]!; const last = token.indexOf(delimiter, cursor);
        if (last < 0) break;
        value = token.slice(cursor, last); cursor = last + 1;
      } else {
        const valueStart = cursor; while (cursor < token.length && !/[\s<>"']/.test(token[cursor]!)) cursor++;
        value = token.slice(valueStart, cursor);
      }
      node.attrs[name.toLowerCase()] = decode(value);
    }
    stack.at(-1)!.children.push(node);
    if (!/[\/]\s*>$/.test(token) && !["br", "img", "hr", "input", "meta", "link"].includes(node.tag)) {
      budget.depth(stack.length); stack.push(node);
    }
  }
  return root;
}
const rawText = (node: Node): string => node.children.map((child) => typeof child === "string" ? child : rawText(child)).join("");

/** HTML text is data, not fresh Markdown syntax. Only structured mentions/links emit actions. */
function markdownText(value: string): string {
  const escaped = value.replace(/[\\`*[\]<>]|_/g, (char, index: number) => char === "_" && /\w/.test(value[index - 1] ?? "") && /\w/.test(value[index + 1] ?? "") ? char : "\\" + char)
    .replace(/&(?=(?:#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);)/gi, "&amp;")
    .replace(/^(\s*)(#{1,6}|>|[-+])(?=\s)/gm, "$1\\$2")
    .replace(/^(\s*)([0-9]+)([.)])(?=\s)/gm, "$1$2\\$3");
  // A lone @ must stay opaque too: adjacent HTML nodes can otherwise assemble a mention.
  return escaped.replace(/@(?:[A-Za-z0-9][A-Za-z0-9_/-]*)?/g, (mention, index: number) =>
    /\w/.test(escaped[index - 1] ?? "") ? mention : "`" + mention + "`");
}
const markdownDestination = (url: string) => url.replace(/[()[\]<>"'\\\s]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
const markdownLabel = (text: string) => text.replace(/\\/g, "\\\\").replace(/[\][`*<>]/g, (char) => "\\" + char).replace(/[\r\n]+/g, " ");
const markdownTitle = (text: string) => text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Plane HTML as GitHub Markdown; links, images, table cells and code content survive. */
export async function htmlToText(html: string, context?: TextContext): Promise<string> {
  const budget = new Budget(html);
  context = cachedContext(context);
  const render = async (node: Node | string): Promise<string> => {
    budget.take();
    if (typeof node === "string") return markdownText(node);
    if (["script", "style", "iframe", "object", "embed"].includes(node.tag)) return "";
    if (node.tag === "pre") {
      const body = rawText(node); const fence = backticks(body, 3); const code = node.children.find((n): n is Node => typeof n !== "string" && n.tag === "code");
      const language = (node.attrs.language ?? code?.attrs.language ?? code?.attrs.class?.match(/\blanguage-([\w+-]+)/)?.[1] ?? "").replace(/[^\w+-]/g, "");
      return `${fence}${language}\n${body}${body.endsWith("\n") || !body ? "" : "\n"}${fence}\n\n`;
    }
    if (node.tag === "code") {
      const body = rawText(node); if (!body) return "";
      const ticks = backticks(body);
      const pad = body.startsWith("`") || body.endsWith("`") || (body.startsWith(" ") && body.endsWith(" ") && !!body.trim()) ? " " : "";
      return `${ticks}${pad}${body}${pad}${ticks}`;
    }
    if (node.tag === "mention-component" && node.attrs.entity_name === "user_mention") {
      const user = await context?.githubUserForPlaneId?.(node.attrs.entity_identifier ?? "") ?? null;
      return user?.login && loginPattern.test(user.login) ? `@${user.login}` : markdownText(user?.displayName ?? (rawText(node) || "Unknown user"));
    }
    if (node.tag === "br") return "\n";
    if (["img", "image-component"].includes(node.tag)) {
      const url = safeUrl(node.attrs.src); const alt = node.attrs.alt ?? node.attrs["data-name"] ?? "";
      return url ? `![${markdownLabel(alt)}](${markdownDestination(url)}${node.attrs.title ? ` "${markdownTitle(node.attrs.title)}"` : ""})` : markdownText(alt);
    }
    if (node.tag === "table") {
      const rows: Node[] = [];
      const visit = (n: Node) => { if (n.tag === "tr") rows.push(n); else for (const child of n.children) if (typeof child !== "string") visit(child); };
      visit(node); if (!rows.length) return "";
      const output: string[] = [];
      for (const row of rows) output.push(`| ${(await Promise.all(row.children.filter((c): c is Node => typeof c !== "string" && ["th", "td"].includes(c.tag)).map(async (cell) =>
        tablePipes((await renderChildren(cell)).trim()).replace(/\n/g, "<br>")))).join(" | ")} |`);
      const first = rows[0]!.children.filter((n): n is Node => typeof n !== "string" && ["th", "td"].includes(n.tag));
      output.splice(1, 0, `| ${first.map((n) => /text-align:\s*center/.test(n.attrs.style ?? "") ? ":---:" : /text-align:\s*right/.test(n.attrs.style ?? "") ? "---:" : /text-align:\s*left/.test(n.attrs.style ?? "") ? ":---" : "---").join(" | ")} |`);
      return output.join("\n") + "\n\n";
    }
    const body = await renderChildren(node);
    if (node.tag === "a") {
      const url = safeUrl(node.attrs.href); if (!url) return body;
      const ref = reference(url, context);
      const plain = node.children.every((child) => typeof child === "string") ? rawText(node) : null;
      if (ref && plain === ref.label) return ref.label;
      if (plain && url === safeUrl(plain) && !/[()[\]<>"'\\`]/.test(plain)) return plain;
      if (plain?.startsWith("@") && loginPattern.test(plain.slice(1)) && origin(context)
        && url === `${origin(context)}/${encodeURIComponent(plain.slice(1))}`) return plain;
      return `[${body}](${markdownDestination(url)}${node.attrs.title ? ` "${markdownTitle(node.attrs.title)}"` : ""})`;
    }
    if (["strong", "b"].includes(node.tag)) return `**${body}**`;
    if (["em", "i"].includes(node.tag)) return `*${body}*`;
    if (["del", "s", "strike"].includes(node.tag)) return `~~${body}~~`;
    if (/^h[1-6]$/.test(node.tag)) return `${"#".repeat(Number(node.tag[1]))} ${body.trim()}\n\n`;
    if (node.tag === "blockquote") return body.trim().split("\n").map((line) => `> ${line}`).join("\n") + "\n\n";
    if (node.tag === "li") return body.trim() + "\n";
    if (node.tag === "ul" || node.tag === "ol") {
      const items = node.children.filter((c): c is Node => typeof c !== "string" && c.tag === "li");
      return (await Promise.all(items.map(async (item, i) => `${node.tag === "ol" ? `${Number(node.attrs.start ?? 1) + i}.` : "-"} ${(await renderChildren(item)).trim()}`))).join("\n") + "\n\n";
    }
    if (["p", "div"].includes(node.tag)) return body + "\n\n";
    if (node.tag === "hr") return "---\n\n";
    return body;
  };
  const renderChildren = async (node: Node): Promise<string> => {
    const parts = await Promise.all(node.children.map(render));
    const out: string[] = []; let previous = "";
    for (const part of parts) {
      if (!part) continue;
      // A closing run and the next opening run must not merge into a different delimiter.
      if (previous.endsWith("`") && !escapedAt(previous, previous.length - 1) && part.startsWith("`")) out.push(" ");
      out.push(part); previous = part;
    }
    return out.join("");
  };
  return budget.output((await render(parseHtml(html, budget))).trim());
}
