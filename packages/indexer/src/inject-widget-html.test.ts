import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { injectWidgetHtml, removeWidgetFromHtml, copyWidgetBundle } from "./inject-widget-html";

describe("injectWidgetHtml", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-inject-html-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): string {
    const p = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  }

  it("inserts the widget script + <cairn-widget> tag right before </body>, in a plain root index.html", () => {
    const html = write(
      "index.html",
      `<!doctype html>\n<html>\n<head><title>App</title></head>\n<body>\n  <div id="root"></div>\n</body>\n</html>\n`,
    );

    const result = injectWidgetHtml(tmpDir, { apiPort: 4000, voice: false, realtimePort: null, widgetScriptPath: "cairn-widget.js" });

    expect(result.injected).toBe(true);
    expect(result.filePath).toBe(html);
    const updated = fs.readFileSync(html, "utf8");
    expect(updated).toContain('<script src="cairn-widget.js"></script>');
    expect(updated).toContain('<cairn-widget endpoint="http://localhost:4000/api/copilot"></cairn-widget>');
    // real, still-parseable HTML — inserted before, not after, the closing tag
    expect(updated.indexOf("<cairn-widget")).toBeLessThan(updated.indexOf("</body>"));
    expect(updated).toContain("<div id=\"root\"></div>"); // the rest of the file is untouched
  });

  it("falls back to public/index.html when there's no root index.html (CRA convention)", () => {
    const html = write("public/index.html", `<html><body>\n</body></html>`);
    const result = injectWidgetHtml(tmpDir, { apiPort: 4000, voice: false, realtimePort: null, widgetScriptPath: "cairn-widget.js" });
    expect(result.injected).toBe(true);
    expect(result.filePath).toBe(html);
  });

  it("wires speak/transcribe/realtime attributes only when voice is on", () => {
    write("index.html", `<html><body>\n</body></html>`);
    const result = injectWidgetHtml(tmpDir, { apiPort: 4000, voice: true, realtimePort: 3010, widgetScriptPath: "cairn-widget.js" });
    const updated = fs.readFileSync(result.filePath!, "utf8");
    expect(updated).toContain('speak-endpoint="http://localhost:4000/api/copilot/speak"');
    expect(updated).toContain('transcribe-endpoint="http://localhost:4000/api/copilot/transcribe"');
    expect(updated).toContain('realtime-url="ws://localhost:3010"');
  });

  it("is idempotent — re-running against an already-injected file does nothing", () => {
    write("index.html", `<html><body>\n</body></html>`);
    const first = injectWidgetHtml(tmpDir, { apiPort: 4000, voice: false, realtimePort: null, widgetScriptPath: "cairn-widget.js" });
    const before = fs.readFileSync(first.filePath!, "utf8");
    const second = injectWidgetHtml(tmpDir, { apiPort: 4000, voice: false, realtimePort: null, widgetScriptPath: "cairn-widget.js" });
    expect(second.injected).toBe(false);
    expect(fs.readFileSync(first.filePath!, "utf8")).toBe(before);
  });

  it("reports (not guesses) when no HTML entry file can be found at all", () => {
    const result = injectWidgetHtml(tmpDir, { apiPort: 4000, voice: false, realtimePort: null, widgetScriptPath: "cairn-widget.js" });
    expect(result.injected).toBe(false);
    expect(result.reason).toMatch(/no index\.html/);
  });

  it("reports (not guesses) when the HTML file has no </body> tag", () => {
    write("index.html", `<html><div id="root"></div></html>`);
    const result = injectWidgetHtml(tmpDir, { apiPort: 4000, voice: false, realtimePort: null, widgetScriptPath: "cairn-widget.js" });
    expect(result.injected).toBe(false);
    expect(result.reason).toMatch(/body/);
  });
});

describe("removeWidgetFromHtml", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-remove-html-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes exactly the marked block, leaving the rest of the file byte-for-byte as it was", () => {
    const p = path.join(tmpDir, "index.html");
    fs.writeFileSync(p, `<!doctype html>\n<html>\n<body>\n  <div id="root"></div>\n</body>\n</html>\n`);
    injectWidgetHtml(tmpDir, { apiPort: 4000, voice: false, realtimePort: null, widgetScriptPath: "cairn-widget.js" });

    const result = removeWidgetFromHtml(p);
    expect(result.removed).toBe(true);
    const after = fs.readFileSync(p, "utf8");
    expect(after).not.toContain("cairn-widget");
    expect(after).toBe(`<!doctype html>\n<html>\n<body>\n  <div id="root"></div>\n</body>\n</html>\n`);
  });

  it("reports (not throws) when the file has no markers", () => {
    const p = path.join(tmpDir, "index.html");
    fs.writeFileSync(p, `<html><body></body></html>`);
    const result = removeWidgetFromHtml(p);
    expect(result.removed).toBe(false);
    expect(result.reason).toMatch(/markers/);
  });

  it("reports (not throws) when the file no longer exists", () => {
    const result = removeWidgetFromHtml(path.join(tmpDir, "gone.html"));
    expect(result.removed).toBe(false);
    expect(result.reason).toMatch(/no longer exists/);
  });
});

describe("copyWidgetBundle", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-copy-bundle-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("copies the built widget bundle next to the HTML file it was injected into", () => {
    const sdkDist = path.join(tmpDir, "node_modules", "@cairnvibe", "sdk", "dist");
    fs.mkdirSync(sdkDist, { recursive: true });
    fs.writeFileSync(path.join(sdkDist, "cairn-widget.js"), "/* built bundle */");
    const htmlPath = path.join(tmpDir, "index.html");
    fs.writeFileSync(htmlPath, "<html></html>");

    const dest = copyWidgetBundle(tmpDir, htmlPath);
    expect(dest).toBe(path.join(tmpDir, "cairn-widget.js"));
    expect(fs.readFileSync(dest!, "utf8")).toBe("/* built bundle */");
  });

  it("returns null (does nothing) when the built bundle isn't present yet", () => {
    const htmlPath = path.join(tmpDir, "index.html");
    fs.writeFileSync(htmlPath, "<html></html>");
    expect(copyWidgetBundle(tmpDir, htmlPath)).toBeNull();
  });
});
