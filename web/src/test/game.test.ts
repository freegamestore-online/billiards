import { describe, it, expect, vi } from "vitest";
import { freshState, resolveShot, type GameState } from "../game";

const sounds = () =>
  ({ playLevelUp: vi.fn(), playGameOver: vi.fn(), playScore: vi.fn(), playError: vi.fn() }) as unknown as Parameters<typeof resolveShot>[1];

function shot(s: GameState, firstHit: number, sunk: number[]) {
  s.firstHit = firstHit;
  s.shotSunk = sunk;
  for (const id of sunk) s.balls.find((b) => b.id === id)!.pocketed = true;
  resolveShot(s, sounds());
}

describe("resolveShot", () => {
  it("racks 16 balls", () => {
    expect(freshState().balls).toHaveLength(16);
  });

  it("assigns groups on the first legal pocket and keeps the turn", () => {
    const s = freshState();
    shot(s, 1, [1]);
    expect(s.p1Group).toBe("solids");
    expect(s.p2Group).toBe("stripes");
    expect(s.p1Sunk).toBe(1);
    expect(s.player).toBe(1);
    expect(s.phase).toBe("aiming");
  });

  it("passes the turn to the AI on a miss", () => {
    const s = freshState();
    shot(s, -1, []);
    expect(s.player).toBe(2);
    expect(s.phase).toBe("ai-thinking");
  });

  it("loses on an early 8-ball", () => {
    const s = freshState();
    shot(s, 8, [8]);
    expect(s.phase).toBe("lost");
  });
});
