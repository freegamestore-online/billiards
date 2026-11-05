import { useCallback, useRef, useState } from "react";

/**
 * Persist a high score in localStorage.
 * Returns [highScore, updateIfHigher].
 */
export function useHighScore(key: string): [number, (score: number) => void] {
  const [highScore, setHighScore] = useState<number>(() => {
    const stored = localStorage.getItem(key);
    return stored ? parseInt(stored, 10) || 0 : 0;
  });

  // Ref so the callback stays stable and correct when captured by a long-lived closure (the RAF loop).
  const highRef = useRef(highScore);

  const update = useCallback(
    (score: number) => {
      if (score > highRef.current) {
        highRef.current = score;
        setHighScore(score);
        localStorage.setItem(key, String(score));
      }
    },
    [key],
  );

  return [highScore, update];
}
