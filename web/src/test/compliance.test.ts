import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const WEB = resolve(__dirname, "../..");
const ROOT = resolve(WEB, "..");

const read = (rel: string) => readFileSync(resolve(WEB, rel), "utf-8");

describe("FreeGameStore compliance", () => {
  describe("index.css", () => {
    const css = read("src/index.css");

    it("contains --paper CSS variable", () => {
      expect(css).toContain("--paper");
    });

    it("contains --ink CSS variable", () => {
      expect(css).toContain("--ink");
    });

    it("contains --accent CSS variable", () => {
      expect(css).toContain("--accent");
    });

    it("supports dark mode via prefers-color-scheme or data-theme", () => {
      const hasDarkMode =
        css.includes("prefers-color-scheme") || css.includes("data-theme");
      expect(hasDarkMode).toBe(true);
    });

    it("references Manrope font", () => {
      expect(css).toContain("Manrope");
    });
  });

  describe("index.html", () => {
    const html = read("index.html");

    it("contains FreeGameStore in title", () => {
      expect(html).toMatch(/<title[^>]*>.*FreeGameStore.*<\/title>/i);
    });

    it("has viewport meta tag", () => {
      expect(html).toMatch(/<meta[^>]*name="viewport"/);
    });

    it("has manifest link", () => {
      expect(html).toMatch(/<link[^>]*rel="manifest"/);
    });
  });

  describe("manifest.json", () => {
    it("exists and has name, display, start_url", () => {
      const manifestPath = resolve(WEB, "public/manifest.json");
      expect(existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      expect(manifest).toHaveProperty("name");
      expect(manifest).toHaveProperty("display");
      expect(manifest).toHaveProperty("start_url");
    });
  });

  describe("Shell.tsx", () => {
    const shell = read("src/components/Shell.tsx");

    it("contains freegamestore.online link", () => {
      expect(shell).toContain("freegamestore.online");
    });
  });

  describe("LICENSE", () => {
    it("exists at project root", () => {
      expect(existsSync(resolve(ROOT, "LICENSE"))).toBe(true);
    });
  });
});
