import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useHighScore } from "../hooks/useHighScore";

describe("useHighScore", () => {
  beforeEach(() => localStorage.clear());

  it("keeps the best when a stale callback is called with a lower value", () => {
    const { result } = renderHook(() => useHighScore("k"));
    const firstUpdate = result.current[1]; // what the RAF loop captures on mount
    act(() => firstUpdate(5));
    act(() => firstUpdate(3));
    expect(result.current[0]).toBe(5);
    expect(localStorage.getItem("k")).toBe("5");
  });
});
