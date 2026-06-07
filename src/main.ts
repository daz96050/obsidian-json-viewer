import {
  Notice,
  Plugin,
  TFile,
  TextFileView,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";

const VIEW_TYPE_JSON_VIEWER = "json-viewer";
const JSON_EXTENSIONS = ["json", "jsonl", "ndjson"];
const OUTLINE_MAX_DEPTH = 4;
const JSONL_RENDER_LIMIT = 1000;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface OutlineItem {
  label: string;
  path: string;
  depth: number;
  type: "object" | "array" | "jsonl";
  count: number;
}

interface JsonParseError {
  label: string;
  message: string;
  line?: number;
  column?: number;
}

interface JsonlRecord {
  line: number;
  value: JsonValue;
}

interface JsonDocument {
  mode: "json" | "jsonl";
  roots: Array<{ label: string; path: string; value: JsonValue }>;
  errors: JsonParseError[];
  skippedRecords: number;
}

export default class JsonViewerPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(
      VIEW_TYPE_JSON_VIEWER,
      (leaf) => new JsonViewerView(leaf),
    );
    this.registerExtensions(JSON_EXTENSIONS, VIEW_TYPE_JSON_VIEWER);

    this.addCommand({
      id: "open-current-json-in-viewer",
      name: "Open current JSON file in viewer",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isJsonFile(file)) return false;

        if (!checking) {
          void this.openJsonFile(file);
        }
        return true;
      },
    });
  }

  async openJsonFile(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_JSON_VIEWER,
      state: { file: file.path },
      active: true,
    });
  }
}

class JsonViewerView extends TextFileView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_JSON_VIEWER;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "JSON viewer";
  }

  getIcon(): string {
    return "braces";
  }

  setViewData(data: string): void {
    this.data = data;
    this.render();
  }

  getViewData(): string {
    return this.data;
  }

  clear(): void {
    this.data = "";
    this.contentEl.empty();
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("json-viewer");

    const header = container.createDiv({ cls: "json-viewer__header" });
    const title = header.createDiv({ cls: "json-viewer__title" });
    title.createDiv({
      cls: "json-viewer__filename",
      text: this.file?.name ?? "JSON file",
    });
    title.createDiv({
      cls: "json-viewer__path",
      text: this.file?.path ?? "",
    });

    const toolbar = header.createDiv({ cls: "json-viewer__toolbar" });
    const searchWrap = toolbar.createDiv({ cls: "json-viewer__search" });
    setIcon(searchWrap.createSpan({ cls: "json-viewer__search-icon" }), "search");
    const searchInput = searchWrap.createEl("input", {
      attr: {
        "aria-label": "Filter JSON tree",
        placeholder: "Filter",
        spellcheck: "false",
        type: "search",
      },
    });
    const expandButton = createButton(toolbar, "chevrons-down", "Expand all");
    const collapseButton = createButton(toolbar, "chevrons-up", "Collapse all");
    const rawButton = createButton(toolbar, "file-code-2", "Copy raw JSON");

    rawButton.addEventListener("click", () => {
      void copyToClipboard(this.data, "JSON copied");
    });

    const document = parseJsonDocument(this.data, this.file?.extension ?? "json");
    if (document.errors.length > 0) {
      renderParseErrors(container, document.errors);
    }

    const body = container.createDiv({ cls: "json-viewer__body" });
    const main = body.createDiv({ cls: "json-viewer__main" });

    if (document.mode === "jsonl") {
      renderJsonlSummary(main, document);
    }

    const tree = main.createDiv({ cls: "json-viewer__tree" });
    const outlineItems: OutlineItem[] = [];

    if (document.roots.length === 0) {
      tree.createDiv({
        cls: "json-viewer__empty",
        text: "This JSON file is empty.",
      });
    } else {
      document.roots.forEach((root) => {
        outlineItems.push(...collectOutline(root.value, root.path, root.label, 0, document.mode));
        renderNode(tree, root.value, root.path, root.label);
      });
    }

    renderOutline(body, tree, outlineItems);

    searchInput.addEventListener("input", () => {
      applyFilter(tree, outlineItems, searchInput.value);
    });

    expandButton.addEventListener("click", () => {
      tree.querySelectorAll("details").forEach((detail) => {
        detail.setAttribute("open", "");
      });
    });

    collapseButton.addEventListener("click", () => {
      tree.querySelectorAll("details").forEach((detail) => {
        detail.removeAttribute("open");
      });
    });

    renderRaw(main, this.data, document.mode);
  }
}

function parseJsonDocument(data: string, extension: string): JsonDocument {
  if (extension === "jsonl" || extension === "ndjson") {
    return parseJsonl(data);
  }
  return parseJson(data);
}

function parseJson(data: string): JsonDocument {
  const trimmed = data.trim();
  if (!trimmed) {
    return { mode: "json", roots: [], errors: [], skippedRecords: 0 };
  }

  try {
    return {
      mode: "json",
      roots: [{ label: "root", path: "", value: JSON.parse(data) as JsonValue }],
      errors: [],
      skippedRecords: 0,
    };
  } catch (error) {
    return {
      mode: "json",
      roots: [],
      errors: [formatJsonParseError(error, data, "JSON parse error")],
      skippedRecords: 0,
    };
  }
}

function parseJsonl(data: string): JsonDocument {
  const roots: Array<{ label: string; path: string; value: JsonValue }> = [];
  const errors: JsonParseError[] = [];
  const records: JsonlRecord[] = [];
  const lines = data.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (!line.trim()) return;

    try {
      records.push({
        line: index + 1,
        value: JSON.parse(line) as JsonValue,
      });
    } catch (error) {
      errors.push(formatJsonlParseError(error, line, index + 1));
    }
  });

  records.slice(0, JSONL_RENDER_LIMIT).forEach((record, index) => {
    roots.push({
      label: `line ${record.line}`,
      path: `/${index}`,
      value: record.value,
    });
  });

  return {
    mode: "jsonl",
    roots,
    errors,
    skippedRecords: Math.max(0, records.length - JSONL_RENDER_LIMIT),
  };
}

function renderNode(parent: HTMLElement, value: JsonValue, path: string, label: string): void {
  if (Array.isArray(value)) {
    const details = createBranch(parent, label, path, "array", `${value.length} items`);
    value.forEach((item, index) => {
      renderNode(details, item, `${path}/${index}`, `[${index}]`);
    });
    return;
  }

  if (isObject(value)) {
    const entries = Object.entries(value);
    const details = createBranch(parent, label, path, "object", `${entries.length} keys`);
    entries.forEach(([key, child]) => {
      renderNode(details, child, `${path}/${escapeJsonPointerSegment(key)}`, key);
    });
    return;
  }

  renderScalar(parent, label, value, path);
}

function createBranch(
  parent: HTMLElement,
  label: string,
  path: string,
  type: "array" | "object",
  meta: string,
): HTMLElement {
  const details = parent.createEl("details", {
    cls: `json-viewer__branch json-viewer__type-${type}`,
    attr: { open: "" },
  });
  details.dataset.path = path;

  const summary = details.createEl("summary", { cls: "json-viewer__row" });
  summary.createSpan({ cls: "json-viewer__key", text: label });
  summary.createSpan({ cls: "json-viewer__badge", text: type });
  summary.createSpan({ cls: "json-viewer__meta", text: meta });
  addCopyPathButton(summary, path);

  return details;
}

function renderScalar(parent: HTMLElement, label: string, value: JsonValue, path: string): void {
  const type = valueType(value);
  const row = parent.createDiv({ cls: "json-viewer__row json-viewer__leaf" });
  row.addClass(`json-viewer__type-${type}`);
  row.dataset.path = path;
  row.createSpan({ cls: "json-viewer__key", text: label });
  row.createSpan({ cls: "json-viewer__badge", text: type });
  row.createSpan({ cls: "json-viewer__value", text: formatValue(value) });
  addCopyPathButton(row, path);
}

function addCopyPathButton(parent: HTMLElement, path: string): void {
  const button = createButton(parent, "copy", "Copy JSON Pointer");
  button.addClass("json-viewer__copy");
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void copyToClipboard(path || "/", `Copied ${path || "/"}`);
  });
}

function renderParseErrors(parent: HTMLElement, errors: JsonParseError[]): void {
  const box = parent.createDiv({ cls: "json-viewer__errors" });
  box.createDiv({ cls: "json-viewer__errors-title", text: "Parse errors" });
  errors.forEach((error) => {
    const location = error.line
      ? ` (${error.label}, line ${error.line}${error.column ? `, column ${error.column}` : ""})`
      : ` (${error.label})`;
    box.createDiv({ cls: "json-viewer__error", text: `${error.message}${location}` });
  });
}

function renderJsonlSummary(parent: HTMLElement, document: JsonDocument): void {
  const summary = parent.createDiv({ cls: "json-viewer__jsonl-summary" });
  summary.createSpan({
    cls: "json-viewer__jsonl-pill",
    text: `${document.roots.length} rendered records`,
  });
  if (document.skippedRecords > 0) {
    summary.createSpan({
      cls: "json-viewer__jsonl-note",
      text: `${document.skippedRecords} additional records skipped for performance`,
    });
  }
}

function renderRaw(parent: HTMLElement, data: string, mode: "json" | "jsonl"): void {
  const details = parent.createEl("details", { cls: "json-viewer__raw" });
  details.createEl("summary", { text: mode === "jsonl" ? "Raw JSONL" : "Raw JSON" });
  const pre = details.createEl("pre");
  renderHighlightedJson(pre, data);
}

function renderOutline(parent: HTMLElement, tree: HTMLElement, items: OutlineItem[]): void {
  const aside = parent.createEl("aside", { cls: "json-viewer__outline" });
  aside.createDiv({ cls: "json-viewer__outline-title", text: "Outline" });

  if (items.length === 0) {
    aside.createDiv({ cls: "json-viewer__outline-empty", text: "No structure" });
    return;
  }

  items.forEach((item) => {
    const button = aside.createEl("button", {
      cls: "json-viewer__outline-item",
      attr: {
        "aria-label": `Go to ${item.path || "/"}`,
        type: "button",
      },
    });
    button.dataset.path = item.path;
    button.style.setProperty("--json-viewer-outline-depth", String(item.depth));
    button.createSpan({ cls: "json-viewer__outline-label", text: item.label });
    button.createSpan({ cls: "json-viewer__outline-meta", text: `${item.count}` });
    button.addEventListener("click", () => {
      const target = findPathElement(tree, item.path);
      if (!target) return;
      openAncestors(target);
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.addClass("json-viewer__pulse");
      window.setTimeout(() => target.removeClass("json-viewer__pulse"), 900);
    });
  });
}

function collectOutline(
  value: JsonValue,
  path: string,
  label: string,
  depth: number,
  mode: "json" | "jsonl",
): OutlineItem[] {
  if (depth > OUTLINE_MAX_DEPTH) return [];

  const type = outlineType(value, mode, depth);
  if (!type) return [];

  const childCount = Array.isArray(value) ? value.length : isObject(value) ? Object.keys(value).length : 0;
  const items: OutlineItem[] = [{ label, path, depth, type, count: childCount }];

  if (depth === OUTLINE_MAX_DEPTH) return items;

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      items.push(...collectOutline(item, `${path}/${index}`, `[${index}]`, depth + 1, mode));
    });
  } else if (isObject(value)) {
    Object.entries(value).forEach(([key, child]) => {
      items.push(...collectOutline(child, `${path}/${escapeJsonPointerSegment(key)}`, key, depth + 1, mode));
    });
  }

  return items;
}

function applyFilter(tree: HTMLElement, outlineItems: OutlineItem[], query: string): void {
  const needle = query.trim().toLowerCase();
  const nodes = Array.from(tree.querySelectorAll<HTMLElement>("[data-path]"));
  const outline = tree.parentElement?.parentElement?.querySelector<HTMLElement>(".json-viewer__outline");
  const outlineButtons = Array.from(outline?.querySelectorAll<HTMLButtonElement>(".json-viewer__outline-item") ?? []);

  if (!needle) {
    nodes.forEach((node) => {
      node.removeClass("json-viewer__hidden");
      node.removeClass("json-viewer__match");
    });
    outlineButtons.forEach((button) => button.removeClass("json-viewer__hidden"));
    return;
  }

  const visiblePaths = new Set<string>();
  const matchingPaths = new Set<string>();

  nodes.forEach((node) => {
    const path = node.dataset.path ?? "";
    const haystack = `${path || "/"} ${node.textContent ?? ""}`.toLowerCase();
    if (!haystack.includes(needle)) return;
    matchingPaths.add(path);
    visiblePaths.add(path);
    addAncestorPaths(path, visiblePaths);
  });

  nodes.forEach((node) => {
    const path = node.dataset.path ?? "";
    node.toggleClass("json-viewer__hidden", !visiblePaths.has(path));
    node.toggleClass("json-viewer__match", matchingPaths.has(path));
    if (visiblePaths.has(path)) openAncestors(node);
  });

  outlineButtons.forEach((button) => {
    const path = button.dataset.path ?? "";
    const item = outlineItems.find((outlineItem) => outlineItem.path === path);
    const haystack = `${path || "/"} ${item?.label ?? ""}`.toLowerCase();
    button.toggleClass("json-viewer__hidden", !haystack.includes(needle));
  });
}

function addAncestorPaths(path: string, paths: Set<string>): void {
  let current = path;
  while (current !== "") {
    current = parentPointerPath(current);
    paths.add(current);
  }
}

function parentPointerPath(path: string): string {
  if (!path) return "";
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return "";
  return path.slice(0, slash);
}

function findPathElement(tree: HTMLElement, path: string): HTMLElement | undefined {
  return Array.from(tree.querySelectorAll<HTMLElement>("[data-path]")).find((element) => {
    return element.dataset.path === path;
  });
}

function openAncestors(element: HTMLElement): void {
  let current: HTMLElement | null = element;
  while (current) {
    if (current.instanceOf(HTMLDetailsElement)) current.open = true;
    current = current.parentElement;
  }
}

function renderHighlightedJson(parent: HTMLElement, data: string): void {
  const lines = data.split("\n");
  lines.forEach((line, index) => {
    const lineEl = parent.createDiv({ cls: "json-viewer__source-line" });
    lineEl.createSpan({ cls: "json-viewer__line-number", text: String(index + 1) });
    const code = lineEl.createSpan({ cls: "json-viewer__source-code" });
    highlightJsonLine(code, line);
  });
}

function highlightJsonLine(parent: HTMLElement, line: string): void {
  const keyMatch = line.match(/^(\s*)"((?:[^"\\]|\\.)*)"\s*(:)(.*)$/);
  if (keyMatch) {
    parent.appendText(keyMatch[1]);
    parent.createSpan({ cls: "json-viewer__tok-key", text: `"${keyMatch[2]}"` });
    parent.createSpan({ cls: "json-viewer__tok-punctuation", text: keyMatch[3] });
    highlightJsonValue(parent, keyMatch[4]);
    return;
  }

  highlightJsonValue(parent, line);
}

function highlightJsonValue(parent: HTMLElement, value: string): void {
  let cursor = 0;

  while (cursor < value.length) {
    const token = nextJsonToken(value, cursor);
    if (!token) {
      parent.appendText(value[cursor]);
      cursor += 1;
      continue;
    }

    if (token.start > cursor) {
      parent.appendText(value.slice(cursor, token.start));
    }
    parent.createSpan({ cls: tokenClass(token.text), text: token.text });
    cursor = token.end;
  }
}

function nextJsonToken(value: string, start: number): { start: number; end: number; text: string } | null {
  let index = start;
  while (index < value.length && /\s/.test(value[index])) index += 1;
  if (index >= value.length) return null;

  const char = value[index];
  if (char === "\"") {
    let end = index + 1;
    while (end < value.length) {
      const current = value[end];
      if (current === "\"" && value[end - 1] !== "\\") break;
      end += 1;
    }
    return { start: index, end: Math.min(value.length, end + 1), text: value.slice(index, end + 1) };
  }

  if ("{}[]:,".includes(char)) {
    return { start: index, end: index + 1, text: char };
  }

  const rest = value.slice(index);
  const scalar = rest.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|^(?:true|false|null)\b/);
  if (!scalar) return null;
  return { start: index, end: index + scalar[0].length, text: scalar[0] };
}

function tokenClass(token: string): string {
  if (token.startsWith("\"")) return "json-viewer__tok-string";
  if (token === "true" || token === "false") return "json-viewer__tok-boolean";
  if (token === "null") return "json-viewer__tok-null";
  if (/^-?\d/.test(token)) return "json-viewer__tok-number";
  return "json-viewer__tok-punctuation";
}

function createButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
  const button = parent.createEl("button", {
    cls: "clickable-icon json-viewer__button",
    attr: { "aria-label": label, title: label },
  });
  setIcon(button, icon);
  return button;
}

async function copyToClipboard(text: string, notice: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  new Notice(notice);
}

function formatJsonParseError(error: unknown, data: string, label: string): JsonParseError {
  const message = getErrorMessage(error);
  const position = parseJsonErrorPosition(message);
  if (position === null) return { label, message };
  const location = lineColumnFromPosition(data, position);
  return { label, message, line: location.line, column: location.column };
}

function formatJsonlParseError(error: unknown, line: string, lineNumber: number): JsonParseError {
  const message = getErrorMessage(error);
  const position = parseJsonErrorPosition(message);
  const column = position === null ? undefined : Math.max(1, Math.min(line.length + 1, position + 1));
  return { label: `line ${lineNumber}`, message, line: lineNumber, column };
}

function parseJsonErrorPosition(message: string): number | null {
  const match = message.match(/position (\d+)/i);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function lineColumnFromPosition(data: string, position: number): { line: number; column: number } {
  const before = data.slice(0, position);
  const lines = before.split(/\r?\n/);
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

function outlineType(value: JsonValue, mode: "json" | "jsonl", depth: number): OutlineItem["type"] | null {
  if (mode === "jsonl" && depth === 0) return "jsonl";
  if (Array.isArray(value)) return "array";
  if (isObject(value)) return "object";
  return null;
}

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function formatValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isJsonFile(file: TFile | null): file is TFile {
  return file instanceof TFile && JSON_EXTENSIONS.includes(file.extension.toLowerCase());
}
