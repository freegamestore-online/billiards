import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const WEB = resolve(__dirname, "../..");
const ROOT = resolve(WEB, "..");

const read = (rel: string) => readFileSync(resolve(WEB, rel), "utf-8");
const exists = (rel: string) => existsSync(resolve(WEB, rel));

describe("FreeGameStore compliance", () => {
  describe("SDK integration", () => {
    const appTsx = read("src/App.tsx");

    it("imports from @freegamestore/games", () => {
      expect(appTsx).toContain("@freegamestore/games");
    });

    it("uses GameShell", () => {
      expect(appTsx).toContain("GameShell");
    });

    it("uses GameTopbar", () => {
      expect(appTsx).toContain("GameTopbar");
    });

    it("uses GameAuth", () => {
      expect(appTsx).toContain("GameAuth");
    });

    it("does NOT import custom Shell", () => {
      expect(appTsx).not.toMatch(/from\s+["']\.\/components\/Shell/);
    });
  });

  describe("index.css", () => {
    const css = read("src/index.css");

    it("has brand CSS variables (--paper, --ink, --accent)", () => {
      expect(css).toContain("--paper");
      expect(css).toContain("--ink");
      expect(css).toContain("--accent");
    });

    it("has dark mode support", () => {
      expect(css).toMatch(/prefers-color-scheme|data-theme/);
    });

    it("has overflow hidden on html/body", () => {
      expect(css).toContain("overflow: hidden");
    });

    it("has user-select none", () => {
      expect(css).toContain("user-select: none");
    });

    it("references Manrope font", () => {
      expect(css).toContain("Manrope");
    });
  });

  describe("index.html", () => {
    const html = read("index.html");

    it("has viewport meta tag", () => {
      expect(html).toMatch(/<meta[^>]*name="viewport"/);
    });

    it("does NOT have old manifest.json link", () => {
      expect(html).not.toContain('href="/manifest.json"');
    });
  });

  describe("vite.config", () => {
    const config = read("vite.config.ts");

    it("has VitePWA plugin", () => {
      expect(config).toContain("VitePWA");
    });

    it("has autoUpdate register type", () => {
      expect(config).toContain("autoUpdate");
    });
  });

  describe("no banned content", () => {
    const appTsx = read("src/App.tsx");
    const css = read("src/index.css");

    it("no tracking SDKs", () => {
      const banned = ["google-analytics", "gtag", "amplitude", "mixpanel", "segment", "hotjar", "plausible", "posthog"];
      for (const b of banned) {
        expect(appTsx).not.toContain(b);
      }
    });

    it("no banned CSS frameworks", () => {
      const banned = ["bootstrap", "material-ui", "@mui", "chakra", "antd", "bulma"];
      const pkg = read("package.json");
      for (const b of banned) {
        expect(pkg).not.toContain(b);
      }
    });
  });

  describe("project structure", () => {
    it("has LICENSE at root", () => {
      expect(exists(resolve(ROOT, "LICENSE"))).toBe(true);
    });

    it("has CLAUDE.md at root", () => {
      expect(exists(resolve(ROOT, "CLAUDE.md"))).toBe(true);
    });

    it("has pnpm-workspace.yaml", () => {
      expect(exists(resolve(ROOT, "pnpm-workspace.yaml"))).toBe(true);
    });
  });
});
