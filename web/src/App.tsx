import { useEffect, useRef, useState, useCallback } from "react";
import {
  GameShell,
  GameTopbar,
  GameAuth,
  GameButton,
  useGameSounds,
} from "@freegamestore/games";
import { useHighScore } from "./hooks/useHighScore";

// ─── Table constants (logical pixels — canvas scales via CSS) ───────
const TABLE_W = 720;
const TABLE_H = 360;
const CUSHION = 24;          // padding between outer edge and play area
const BALL_R = 9;
const POCKET_R = 16;

const FRICTION_PER_MS = 0.9985;
const MIN_VEL = 0.04;        // below this, set ball velocity to 0
const MAX_POWER = 1.4;       // px/ms — sane max so we don't tunnel
const CHARGE_RATE_PER_MS = 0.0014;  // 0..1 over ~715ms hold for full power
const MIN_FIRE_POWER = 0.08;        // releasing below this cancels (avoids accidental taps)
const CUSHION_RESTITUTION = 0.78;
const BALL_RESTITUTION = 0.96;

const SETTLE_FRAMES = 14;    // # of consecutive still frames before turn ends

// Pockets — 4 corners + 2 sides
const POCKETS = [
  { x: CUSHION,            y: CUSHION },
  { x: TABLE_W / 2,        y: CUSHION - 4 },
  { x: TABLE_W - CUSHION,  y: CUSHION },
  { x: CUSHION,            y: TABLE_H - CUSHION },
  { x: TABLE_W / 2,        y: TABLE_H - CUSHION + 4 },
  { x: TABLE_W - CUSHION,  y: TABLE_H - CUSHION },
];

// Standard 8-ball numbers: 1-7 solids, 8 black, 9-15 stripes
const BALL_COLORS: Record<number, string> = {
  0: "#f6f1e1",
  1: "#f5c518", 2: "#1d4ed8", 3: "#dc2626", 4: "#7c3aed",
  5: "#ea580c", 6: "#15803d", 7: "#7f1d1d",
  8: "#0b0b0b",
  9: "#f5c518", 10: "#1d4ed8", 11: "#dc2626", 12: "#7c3aed",
  13: "#ea580c", 14: "#15803d", 15: "#7f1d1d",
};

type BallGroup = "solids" | "stripes" | null;
type Player = 1 | 2;
type Phase =
  | "intro"
  | "aiming"        // player can drag to aim+set power
  | "shooting"     // balls in motion, waiting to settle
  | "ai-thinking"  // brief pause before AI shoots
  | "won"
  | "lost";

interface Ball {
  id: number;
  x: number; y: number;
  vx: number; vy: number;
  pocketed: boolean;
  sinkAge: number; // ms since pocketed, for shrink animation
}

interface ScorePopup {
  x: number; y: number;
  text: string; color: string;
  age: number;
}

interface GameState {
  balls: Ball[];
  phase: Phase;
  player: Player;
  p1Group: BallGroup;
  p2Group: BallGroup;
  p1Sunk: number;
  p2Sunk: number;
  message: string;
  // shot tracking
  firstHit: number;          // first ball hit by cue this shot, -1 if none
  shotSunk: number[];        // balls pocketed this shot
  settleTimer: number;
  // ball-in-hand after foul
  ballInHand: boolean;
  // input — archery-style: aim is set by pointer position; SHOOT button
  // (held) charges aimPower; release fires.
  aimAngle: number;
  aimPower: number;          // 0..1
  charging: boolean;
  chargeArmed: boolean;      // set on press, cleared on fire — guards against bogus releases
  // ui
  popups: ScorePopup[];
  pocketGlow: number[];      // per-pocket flash timer
  shake: number;
  aiDelay: number;
  // frame
  frame: number;
  time: number;
}

// ─── Helpers ────────────────────────────────────────────────────────

function ballKind(id: number): "cue" | "solids" | "stripes" | "eight" {
  if (id === 0) return "cue";
  if (id === 8) return "eight";
  return id <= 7 ? "solids" : "stripes";
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.hypot(dx, dy);
}

function rackBalls(): Ball[] {
  const balls: Ball[] = [];
  // Cue at the head spot (left quarter, vertical center)
  balls.push({ id: 0, x: TABLE_W * 0.22, y: TABLE_H / 2, vx: 0, vy: 0, pocketed: false, sinkAge: 0 });

  // Triangle at the foot spot (right 70%)
  const footX = TABLE_W * 0.72;
  const footY = TABLE_H / 2;
  const dx = BALL_R * Math.sqrt(3);
  const dy = BALL_R;
  // Standard 8-ball rack: 8 in the middle (row 2 col 1, 0-indexed),
  // corners must be opposite groups.
  const rackOrder = [
    [1],
    [9, 2],
    [10, 8, 3],
    [11, 4, 12, 5],
    [13, 6, 14, 7, 15],
  ];
  for (let row = 0; row < rackOrder.length; row++) {
    const cols = rackOrder[row]!;
    for (let col = 0; col < cols.length; col++) {
      const id = cols[col]!;
      const x = footX + row * dx;
      const y = footY + (col - row / 2) * dy * 2;
      balls.push({ id, x, y, vx: 0, vy: 0, pocketed: false, sinkAge: 0 });
    }
  }
  return balls;
}

function freshState(): GameState {
  return {
    balls: rackBalls(),
    phase: "intro",
    player: 1,
    p1Group: null,
    p2Group: null,
    p1Sunk: 0,
    p2Sunk: 0,
    message: "Player 1 — drag from the cue ball to aim",
    firstHit: -1,
    shotSunk: [],
    settleTimer: 0,
    ballInHand: false,
    aimAngle: 0,
    aimPower: 0,
    charging: false,
    chargeArmed: false,
    popups: [],
    pocketGlow: [0, 0, 0, 0, 0, 0],
    shake: 0,
    aiDelay: 0,
    frame: 0,
    time: 0,
  };
}

function ballsStill(balls: Ball[]): boolean {
  for (const b of balls) {
    if (b.pocketed) continue;
    if (Math.abs(b.vx) > MIN_VEL || Math.abs(b.vy) > MIN_VEL) return false;
  }
  return true;
}

// Place cue ball at head spot, nudging if it overlaps anything.
function placeCueAtHeadSpot(s: GameState) {
  const cue = s.balls.find((b) => b.id === 0)!;
  cue.pocketed = false;
  cue.sinkAge = 0;
  cue.vx = 0;
  cue.vy = 0;
  cue.x = TABLE_W * 0.22;
  cue.y = TABLE_H / 2;
  for (let tries = 0; tries < 12; tries++) {
    let overlap = false;
    for (const b of s.balls) {
      if (b.id === 0 || b.pocketed) continue;
      if (distance(cue.x, cue.y, b.x, b.y) < BALL_R * 2.2) {
        overlap = true;
        cue.x -= 4;
        break;
      }
    }
    if (!overlap) break;
  }
  if (cue.x < CUSHION + BALL_R) cue.x = CUSHION + BALL_R + 2;
}

// ─── Physics ────────────────────────────────────────────────────────

function physicsStep(s: GameState, dt: number): { pocketed: number[] } {
  const pocketed: number[] = [];
  // 2 substeps per frame to avoid tunneling at high speed.
  const sub = 2;
  for (let step = 0; step < sub; step++) {
    // integrate
    for (const b of s.balls) {
      if (b.pocketed) continue;
      b.x += (b.vx * dt) / sub;
      b.y += (b.vy * dt) / sub;
    }
    // ball-ball
    const live = s.balls.filter((b) => !b.pocketed);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i]!;
        const b = live[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const minD = BALL_R * 2;
        if (d < minD && d > 0.0001) {
          const nx = dx / d;
          const ny = dy / d;
          // separate
          const overlap = (minD - d) / 2 + 0.05;
          a.x -= nx * overlap;
          a.y -= ny * overlap;
          b.x += nx * overlap;
          b.y += ny * overlap;
          // 1D elastic collision along normal
          const dvx = a.vx - b.vx;
          const dvy = a.vy - b.vy;
          const dvn = dvx * nx + dvy * ny;
          if (dvn > 0) {
            const j = dvn * BALL_RESTITUTION;
            a.vx -= j * nx;
            a.vy -= j * ny;
            b.vx += j * nx;
            b.vy += j * ny;
            // record first hit (cue ball into something)
            if (s.firstHit < 0) {
              if (a.id === 0) s.firstHit = b.id;
              else if (b.id === 0) s.firstHit = a.id;
            }
          }
        }
      }
    }
    // cushions
    const left = CUSHION + BALL_R;
    const right = TABLE_W - CUSHION - BALL_R;
    const top = CUSHION + BALL_R;
    const bottom = TABLE_H - CUSHION - BALL_R;
    for (const b of s.balls) {
      if (b.pocketed) continue;
      if (b.x < left)  { b.x = left;  b.vx = Math.abs(b.vx) * CUSHION_RESTITUTION; }
      if (b.x > right) { b.x = right; b.vx = -Math.abs(b.vx) * CUSHION_RESTITUTION; }
      if (b.y < top)   { b.y = top;   b.vy = Math.abs(b.vy) * CUSHION_RESTITUTION; }
      if (b.y > bottom){ b.y = bottom; b.vy = -Math.abs(b.vy) * CUSHION_RESTITUTION; }
    }
    // pockets
    for (const b of s.balls) {
      if (b.pocketed) continue;
      for (let pi = 0; pi < POCKETS.length; pi++) {
        const p = POCKETS[pi]!;
        if (distance(b.x, b.y, p.x, p.y) < POCKET_R + BALL_R * 0.4) {
          b.pocketed = true;
          b.vx = 0;
          b.vy = 0;
          b.sinkAge = 1;
          pocketed.push(b.id);
          s.pocketGlow[pi] = 360;
          break;
        }
      }
    }
  }
  // global friction + clamp
  const fr = Math.pow(FRICTION_PER_MS, dt);
  for (const b of s.balls) {
    if (b.pocketed) continue;
    b.vx *= fr;
    b.vy *= fr;
    if (Math.hypot(b.vx, b.vy) < MIN_VEL) { b.vx = 0; b.vy = 0; }
  }
  return { pocketed };
}

// ─── AI ─────────────────────────────────────────────────────────────

function chooseAiShot(s: GameState): { angle: number; power: number } {
  const cue = s.balls.find((b) => b.id === 0 && !b.pocketed)!;
  const myGroup = s.p2Group;
  const mySunk = s.p2Sunk;

  // Which balls can I legally hit first?
  const candidates = s.balls.filter((b) => {
    if (b.pocketed || b.id === 0) return false;
    if (b.id === 8) return mySunk >= 7;
    if (!myGroup) return true;
    return ballKind(b.id) === myGroup;
  });

  if (candidates.length === 0) {
    return { angle: Math.atan2(TABLE_H / 2 - cue.y, TABLE_W / 2 - cue.x), power: 0.7 };
  }

  // Score every (ball × pocket) combo. The "best" shot is straight-line
  // along the cue-ball-ghost-position-pocket axis with no blockers in either
  // edge (cue → ghost, ghost → pocket).
  let best = { angle: 0, power: 0.7, score: -Infinity };
  for (const ball of candidates) {
    for (const p of POCKETS) {
      // ghost position: contact point on the side of the ball opposite the pocket
      const dx = p.x - ball.x;
      const dy = p.y - ball.y;
      const dl = Math.hypot(dx, dy);
      if (dl < 1) continue;
      const ux = dx / dl;
      const uy = dy / dl;
      const ghostX = ball.x - ux * BALL_R * 2;
      const ghostY = ball.y - uy * BALL_R * 2;

      // angle from cue to ghost
      const acx = ghostX - cue.x;
      const acy = ghostY - cue.y;
      const acl = Math.hypot(acx, acy);
      if (acl < 1) continue;
      const angle = Math.atan2(acy, acx);

      // Cut angle: dot of (cue → ghost) and (ball → pocket). Closer to 1 = straight shot.
      const cutCos = (acx / acl) * ux + (acy / acl) * uy;
      if (cutCos < 0.05) continue; // would need backwards cut

      // Check line-of-sight: any other ball within ~BALL_R of either edge fails.
      const blockedCue = lineHasBlocker(s.balls, cue.x, cue.y, ghostX, ghostY, [0, ball.id]);
      const blockedBall = lineHasBlocker(s.balls, ball.x, ball.y, p.x, p.y, [0, ball.id]);
      if (blockedCue || blockedBall) continue;

      // Lower score = harder shot. Score combines straightness + total path length.
      const totalLen = acl + dl;
      const score = cutCos * 1000 - totalLen;
      if (score > best.score) {
        // Pick power based on distance — more distance, more power, capped.
        const power = Math.min(1, 0.55 + totalLen / 900);
        best = { angle, power, score };
      }
    }
  }

  if (best.score === -Infinity) {
    // No clear shot — pick any candidate, soft tap.
    const t = candidates[Math.floor(Math.random() * candidates.length)]!;
    return {
      angle: Math.atan2(t.y - cue.y, t.x - cue.x),
      power: 0.5,
    };
  }
  // Add small jitter so the AI isn't a perfect shark.
  best.angle += (Math.random() - 0.5) * 0.06;
  return best;
}

function lineHasBlocker(
  balls: Ball[],
  ax: number, ay: number,
  bx: number, by: number,
  ignoreIds: number[],
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1) return false;
  for (const b of balls) {
    if (b.pocketed) continue;
    if (ignoreIds.includes(b.id)) continue;
    let t = ((b.x - ax) * dx + (b.y - ay) * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    if (Math.hypot(b.x - cx, b.y - cy) < BALL_R * 1.95) return true;
  }
  return false;
}

// ─── Shot resolution ────────────────────────────────────────────────

function resolveShot(s: GameState, sounds: ReturnType<typeof useGameSounds>) {
  let foul = false;
  let scoredOwn = false;

  // 1. Was a legal first ball hit?
  if (s.firstHit < 0) {
    foul = true;
  } else {
    const myGroup = s.player === 1 ? s.p1Group : s.p2Group;
    const mySunk = s.player === 1 ? s.p1Sunk : s.p2Sunk;
    const fk = ballKind(s.firstHit);
    if (myGroup && fk !== myGroup) {
      if (fk === "eight" && mySunk < 7) foul = true;
      else if (fk !== "eight") foul = true;
    }
  }

  // 2. Walk through pocketed balls, assign groups + tally + check eight-ball.
  for (const id of s.shotSunk) {
    if (id === 0) { foul = true; continue; }
    const k = ballKind(id);

    if (k === "eight") {
      const myGroup = s.player === 1 ? s.p1Group : s.p2Group;
      const mySunk = s.player === 1 ? s.p1Sunk : s.p2Sunk;
      if (mySunk >= 7 && myGroup && !foul) {
        s.phase = s.player === 1 ? "won" : "lost";
        s.message = s.player === 1 ? "8-ball pocketed — you win!" : "AI sinks the 8 — you lose.";
        sounds.playLevelUp();
      } else {
        // Early 8-ball: other player wins.
        s.phase = s.player === 1 ? "lost" : "won";
        s.message = `Early 8 — ${s.player === 1 ? "AI wins" : "you win"}`;
        sounds.playGameOver();
      }
      return;
    }

    // First legal pocket assigns groups (k is already narrowed to non-"eight" above; cue is the only thing left to exclude)
    if (!s.p1Group && k !== "cue") {
      if (s.player === 1) {
        s.p1Group = k as BallGroup;
        s.p2Group = (k === "solids" ? "stripes" : "solids") as BallGroup;
      } else {
        s.p2Group = k as BallGroup;
        s.p1Group = (k === "solids" ? "stripes" : "solids") as BallGroup;
      }
    }

    const myGroup = s.player === 1 ? s.p1Group : s.p2Group;
    if (k === myGroup) {
      if (s.player === 1) s.p1Sunk++;
      else s.p2Sunk++;
      scoredOwn = true;
      // small popup at sink position
      const ball = s.balls.find((bb) => bb.id === id);
      if (ball) {
        s.popups.push({ x: ball.x, y: ball.y - BALL_R - 4, text: `+1`, color: "#facc15", age: 0 });
      }
      sounds.playScore();
    } else if (k !== "cue") {
      // Sunk opponent's ball — counts for them.
      if (s.player === 1) s.p2Sunk++;
      else s.p1Sunk++;
      const ball = s.balls.find((bb) => bb.id === id);
      if (ball) {
        s.popups.push({ x: ball.x, y: ball.y - BALL_R - 4, text: `+1 OPP`, color: "#94a3b8", age: 0 });
      }
    }
  }

  // 3. Scratch (cue ball pocketed) → ball-in-hand for the OTHER player.
  const cue = s.balls.find((b) => b.id === 0);
  if (cue?.pocketed) {
    foul = true;
    placeCueAtHeadSpot(s);
    s.ballInHand = true;
    sounds.playError();
  }

  // 4. Turn handover unless we scored our own ball with no foul.
  if (foul || !scoredOwn) {
    s.player = s.player === 1 ? 2 : 1;
  }

  const tag = foul ? " · FOUL" : "";
  const grp = s.player === 1 ? s.p1Group : s.p2Group;
  const grpLabel = grp ?? "any";
  s.message = `${s.player === 1 ? "You" : "AI"} — ${grpLabel}${tag}`;

  if (s.player === 2) {
    s.phase = "ai-thinking";
    s.aiDelay = 650;
  } else {
    s.phase = "aiming";
  }
}

// ─── React component ────────────────────────────────────────────────

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<GameState>(freshState());
  const lastTimeRef = useRef(0);
  const phaseRef = useRef<Phase>("intro");

  const [phase, setPhase] = useState<Phase>("intro");
  const [p1Sunk, setP1Sunk] = useState(0);
  const [p2Sunk, setP2Sunk] = useState(0);
  const [message, setMessage] = useState("Player 1 — drag from the cue ball to aim");
  const [, force] = useState(0);
  const [bestWins, updateBestWins] = useHighScore("billiards-wins");
  const sounds = useGameSounds();

  phaseRef.current = phase;

  const newGame = useCallback(() => {
    stateRef.current = freshState();
    stateRef.current.phase = "aiming";
    phaseRef.current = "aiming";
    lastTimeRef.current = 0;
    setPhase("aiming");
    setP1Sunk(0);
    setP2Sunk(0);
    setMessage("Player 1 — drag from the cue ball to aim");
    force((x) => x + 1);
  }, []);

  // Canvas sizing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const fit = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const maxW = parent.clientWidth;
      const maxH = parent.clientHeight;
      const scale = Math.min(maxW / TABLE_W, maxH / TABLE_H);
      const cssW = TABLE_W * scale;
      const cssH = TABLE_H * scale;
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.width = TABLE_W * dpr;
      canvas.height = TABLE_H * dpr;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    return () => ro.disconnect();
  }, []);

  // ── Aim: pointer on canvas sets aim direction (no firing) ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function canvasToTable(clientX: number, clientY: number) {
      const rect = canvas!.getBoundingClientRect();
      const rx = (clientX - rect.left) / rect.width;
      const ry = (clientY - rect.top) / rect.height;
      return { x: rx * TABLE_W, y: ry * TABLE_H };
    }

    function setAimToward(clientX: number, clientY: number) {
      const s = stateRef.current;
      const cue = s.balls.find((b) => b.id === 0 && !b.pocketed);
      if (!cue) return;
      const pt = canvasToTable(clientX, clientY);
      // Ball-in-hand mode: tap places the cue ball, doesn't aim.
      if (s.ballInHand) {
        let x = Math.max(CUSHION + BALL_R, Math.min(TABLE_W - CUSHION - BALL_R, pt.x));
        let y = Math.max(CUSHION + BALL_R, Math.min(TABLE_H - CUSHION - BALL_R, pt.y));
        // Don't drop the cue ball inside another ball — nudge it away until clear.
        for (let pass = 0; pass < 24; pass++) {
          let collided = false;
          for (const b of s.balls) {
            if (b.id === 0 || b.pocketed) continue;
            const d = Math.hypot(x - b.x, y - b.y);
            if (d < BALL_R * 2.05) {
              const nx = d > 0.001 ? (x - b.x) / d : 1;
              const ny = d > 0.001 ? (y - b.y) / d : 0;
              x += nx * (BALL_R * 2.1 - d);
              y += ny * (BALL_R * 2.1 - d);
              collided = true;
            }
          }
          x = Math.max(CUSHION + BALL_R, Math.min(TABLE_W - CUSHION - BALL_R, x));
          y = Math.max(CUSHION + BALL_R, Math.min(TABLE_H - CUSHION - BALL_R, y));
          if (!collided) break;
        }
        cue.x = x;
        cue.y = y;
        s.ballInHand = false;
        return;
      }
      const dx = pt.x - cue.x;
      const dy = pt.y - cue.y;
      if (Math.hypot(dx, dy) > BALL_R) s.aimAngle = Math.atan2(dy, dx);
    }

    function onDown(e: PointerEvent) { if (phaseRef.current === "aiming") setAimToward(e.clientX, e.clientY); }
    function onMove(e: PointerEvent) {
      // Only update if a pointer is actively over the canvas. We don't care
      // about hover-without-press for touch (no such thing); for mouse we
      // still update so the line follows the cursor when you're not charging.
      if (phaseRef.current === "aiming") setAimToward(e.clientX, e.clientY);
    }
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
    };
  }, []);

  // ── Charge & fire: SHOOT button (held) + Space key (held) ──
  const startCharge = useCallback(() => {
    const s = stateRef.current;
    if (phaseRef.current !== "aiming") return;
    if (s.ballInHand) return; // place the cue ball first
    s.charging = true;
    s.chargeArmed = true;
    s.aimPower = 0;
  }, []);

  const releaseCharge = useCallback(() => {
    const s = stateRef.current;
    if (!s.chargeArmed) return;
    s.chargeArmed = false;
    s.charging = false;
    if (phaseRef.current !== "aiming") {
      s.aimPower = 0;
      return;
    }
    if (s.aimPower < MIN_FIRE_POWER) {
      s.aimPower = 0;
      return; // tap-and-release with no power = no shot
    }
    shootCue(s, s.aimAngle, s.aimPower);
    s.phase = "shooting";
    phaseRef.current = "shooting";
    setPhase("shooting");
    sounds.playMove();
  }, [sounds]);

  // Keyboard: arrows fine-tune aim, Space hold = charge
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const s = stateRef.current;
      if (phaseRef.current !== "aiming") return;
      if (e.key === "ArrowLeft") { s.aimAngle -= 0.04; e.preventDefault(); }
      else if (e.key === "ArrowRight") { s.aimAngle += 0.04; e.preventDefault(); }
      else if ((e.key === " " || e.key === "Enter") && !e.repeat) {
        e.preventDefault();
        startCharge();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        releaseCharge();
      }
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [startCharge, releaseCharge]);

  // Animation loop — single source of physics + ai progression.
  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const dt = lastTimeRef.current === 0 ? 16 : Math.min(33, now - lastTimeRef.current);
      lastTimeRef.current = now;
      const s = stateRef.current;
      s.frame++;
      s.time += dt;
      s.shake = Math.max(0, s.shake - dt);

      // Age popups + pocket glow + sink animations
      const livePopups: ScorePopup[] = [];
      for (const p of s.popups) {
        p.age += dt;
        if (p.age < 1000) livePopups.push(p);
      }
      s.popups = livePopups;
      for (let i = 0; i < s.pocketGlow.length; i++) {
        s.pocketGlow[i] = Math.max(0, s.pocketGlow[i]! - dt);
      }
      for (const b of s.balls) {
        if (b.pocketed) b.sinkAge += dt;
      }

      // Tick power charge while the SHOOT button (or Space) is held
      if (phaseRef.current === "aiming" && s.charging) {
        s.aimPower = Math.min(1, s.aimPower + CHARGE_RATE_PER_MS * dt);
      }

      if (phaseRef.current === "shooting") {
        const result = physicsStep(s, dt);
        if (result.pocketed.length > 0) s.shotSunk.push(...result.pocketed);
        if (ballsStill(s.balls)) {
          s.settleTimer++;
          if (s.settleTimer >= SETTLE_FRAMES) {
            resolveShot(s, sounds);
            s.settleTimer = 0;
            s.firstHit = -1;
            s.shotSunk = [];
            phaseRef.current = s.phase;
            setPhase(s.phase);
            setMessage(s.message);
            setP1Sunk(s.p1Sunk);
            setP2Sunk(s.p2Sunk);
            if (s.phase === "won") {
              updateBestWins(bestWins + 1);
              s.shake = 250;
            } else if (s.phase === "lost") {
              s.shake = 320;
            }
          }
        } else {
          s.settleTimer = 0;
        }
      } else if (phaseRef.current === "ai-thinking") {
        s.aiDelay -= dt;
        if (s.aiDelay <= 0) {
          const shot = chooseAiShot(s);
          shootCue(s, shot.angle, shot.power);
          s.phase = "shooting";
          phaseRef.current = "shooting";
          setPhase("shooting");
          sounds.playMove();
        }
      }

      draw(s);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sounds]);

  function draw(s: GameState) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (s.shake > 0) {
      const k = (s.shake / 320) * 3;
      ctx.translate((Math.random() - 0.5) * k * 2, (Math.random() - 0.5) * k * 2);
    }

    // Wood frame
    ctx.fillStyle = "#5b2e0e";
    ctx.fillRect(0, 0, TABLE_W, TABLE_H);
    // Felt
    const felt = ctx.createLinearGradient(0, CUSHION, 0, TABLE_H - CUSHION);
    felt.addColorStop(0, "#1f8d4a");
    felt.addColorStop(1, "#16713a");
    ctx.fillStyle = felt;
    ctx.fillRect(CUSHION, CUSHION, TABLE_W - CUSHION * 2, TABLE_H - CUSHION * 2);
    // Head string line
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(TABLE_W * 0.25, CUSHION);
    ctx.lineTo(TABLE_W * 0.25, TABLE_H - CUSHION);
    ctx.stroke();
    // Foot spot
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    ctx.beginPath();
    ctx.arc(TABLE_W * 0.72, TABLE_H / 2, 1.5, 0, Math.PI * 2);
    ctx.fill();

    // Pockets (with glow)
    for (let i = 0; i < POCKETS.length; i++) {
      const p = POCKETS[i]!;
      if (s.pocketGlow[i]! > 0) {
        const g = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, POCKET_R + 16);
        g.addColorStop(0, `rgba(254, 243, 199, ${s.pocketGlow[i]! / 360 * 0.6})`);
        g.addColorStop(1, "rgba(254, 243, 199, 0)");
        ctx.fillStyle = g;
        ctx.fillRect(p.x - POCKET_R - 16, p.y - POCKET_R - 16, (POCKET_R + 16) * 2, (POCKET_R + 16) * 2);
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, POCKET_R, 0, Math.PI * 2);
      ctx.fillStyle = "#0a0a0a";
      ctx.fill();
    }

    // Aim trajectory (only while aiming, and only if cue is live)
    const cue = s.balls.find((b) => b.id === 0 && !b.pocketed);
    if (s.phase === "aiming" && cue && !s.ballInHand) {
      const cosA = Math.cos(s.aimAngle);
      const sinA = Math.sin(s.aimAngle);

      // Dotted aim line forward from cue ball
      const len = 220;
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = "rgba(255,255,255,0.32)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cue.x, cue.y);
      ctx.lineTo(cue.x + cosA * len, cue.y + sinA * len);
      ctx.stroke();
      ctx.setLineDash([]);

      // Cue stick BEHIND the cue ball, pulled back by power (archery draw).
      // Base gap so the tip is always *behind* the ball even at 0% power.
      const baseGap = BALL_R + 6;
      const pullback = s.aimPower * 36;
      const tipX = cue.x - cosA * (baseGap + pullback);
      const tipY = cue.y - sinA * (baseGap + pullback);
      const buttX = tipX - cosA * 100;
      const buttY = tipY - sinA * 100;
      // Stick shaft
      ctx.strokeStyle = "#d1a05f";
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(buttX, buttY);
      ctx.stroke();
      // Butt end (darker wood)
      ctx.strokeStyle = "#5b3413";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(buttX, buttY);
      ctx.lineTo(buttX - cosA * 28, buttY - sinA * 28);
      ctx.stroke();
      // Cue tip (blue chalk)
      ctx.fillStyle = "#3b82f6";
      ctx.beginPath();
      ctx.arc(tipX, tipY, 2.2, 0, Math.PI * 2);
      ctx.fill();

      // Power ring around the cue ball
      if (s.aimPower > 0) {
        ctx.strokeStyle = s.aimPower > 0.85 ? "#ef4444" : "#facc15";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cue.x, cue.y, BALL_R + 4 + s.aimPower * 6, 0, Math.PI * 2 * s.aimPower);
        ctx.stroke();
      }
    }

    // Balls — pocketed ones shrink + fade for ~400ms then vanish
    for (const b of s.balls) {
      if (b.pocketed) {
        if (b.sinkAge > 400) continue;
        const t = b.sinkAge / 400;
        const r = BALL_R * (1 - t * 0.9);
        const alpha = 1 - t;
        ctx.globalAlpha = alpha;
        drawBall(ctx, b, r);
        ctx.globalAlpha = 1;
      } else {
        drawBall(ctx, b, BALL_R);
      }
    }

    // Ball-in-hand cursor: outline at cue ball position
    if (s.ballInHand && cue) {
      ctx.strokeStyle = "rgba(250,204,21,0.7)";
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cue.x, cue.y, BALL_R + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Score popups
    for (const p of s.popups) drawPopup(ctx, p);
  }

  // ─── UI ────────────────────────────────────────────────────────
  return (
    <GameShell
      topbar={
        <GameTopbar
          title="Billiards"
          stats={[
            { label: "You", value: p1Sunk, accent: true },
            { label: "AI", value: p2Sunk },
            { label: "Wins", value: bestWins },
          ]}
          rules={
            <div>
              <h3 style={{ marginBottom: "0.5rem", fontWeight: 700 }}>8-Ball Pool</h3>
              <p>Sink your group (solids or stripes), then the 8-ball.</p>
              <h4 style={{ marginTop: "0.75rem", fontWeight: 600 }}>Controls</h4>
              <ul style={{ paddingLeft: "1.2rem", marginTop: "0.25rem" }}>
                <li>Drag from the cue ball in the direction you want to shoot</li>
                <li>Drag distance = power (further = harder)</li>
                <li>Release to take the shot</li>
                <li>After a scratch, tap anywhere to place the cue ball</li>
                <li>Desktop: ← → adjust angle, ↑ ↓ power, Space / Enter to shoot</li>
              </ul>
              <h4 style={{ marginTop: "0.75rem", fontWeight: 600 }}>Rules</h4>
              <ul style={{ paddingLeft: "1.2rem", marginTop: "0.25rem" }}>
                <li>Groups (solids/stripes) lock on the first legal pocket</li>
                <li>Scratch = cue ball pocketed → opponent gets ball-in-hand</li>
                <li>Pocketing the 8-ball early loses the game</li>
                <li>Sink the 8-ball after clearing your group to win</li>
              </ul>
            </div>
          }
          actions={<GameAuth />}
        />
      }
    >
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "0.5rem",
          gap: "0.4rem",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "relative",
            flex: 1,
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 0,
          }}
        >
          <div
            style={{
              position: "relative",
              maxWidth: "100%",
              maxHeight: "100%",
              padding: "6px",
              background: "linear-gradient(180deg, #422006 0%, #2c1404 100%)",
              border: "3px solid #facc15",
              borderRadius: "0.4rem",
              boxShadow: "0 0 0 1px #000 inset, 0 4px 24px rgba(0,0,0,0.5)",
              display: "flex",
            }}
          >
            <canvas
              ref={canvasRef}
              style={{
                imageRendering: "pixelated",
                background: "#1a7a3a",
                display: "block",
                maxWidth: "100%",
                maxHeight: "100%",
                touchAction: "none",
              }}
            />
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                inset: 6,
                pointerEvents: "none",
                background:
                  "repeating-linear-gradient(to bottom, rgba(0,0,0,0.08) 0 1px, transparent 1px 3px)",
                mixBlendMode: "multiply",
                borderRadius: "0.15rem",
              }}
            />
          </div>

          {(phase === "intro" || phase === "won" || phase === "lost") && (
            <Overlay>
              <div
                style={{
                  fontFamily: "Fraunces, serif",
                  fontWeight: 800,
                  fontSize: "1.5rem",
                  color: phase === "won" ? "#10b981" : phase === "lost" ? "#ef4444" : "#facc15",
                }}
              >
                {phase === "won" ? "YOU WIN" : phase === "lost" ? "YOU LOSE" : "BILLIARDS"}
              </div>
              <div style={{ color: "var(--paper)", fontSize: "0.85rem", maxWidth: "20rem", textAlign: "center" }}>
                {phase === "intro"
                  ? "Drag from the cue ball to aim and shoot. Sink your group, then the 8-ball."
                  : `${p1Sunk}–${p2Sunk}`}
              </div>
              <GameButton size="md" variant="primary" onClick={newGame}>
                {phase === "intro" ? "Start" : "New Game"}
              </GameButton>
            </Overlay>
          )}
        </div>

        {/* Status / FOUL indicator */}
        <div
          style={{
            fontFamily: "Fraunces, serif",
            fontWeight: 700,
            color: "var(--muted)",
            fontSize: "0.85rem",
            minHeight: "1.2em",
            textAlign: "center",
            padding: "0 1rem",
          }}
        >
          {phase === "aiming" || phase === "shooting" || phase === "ai-thinking" ? message : ""}
        </div>

        {/* SHOOT button: hold to charge, release to fire (archery-style) */}
        <ShootButton
          stateRef={stateRef}
          phaseRef={phaseRef}
          startCharge={startCharge}
          releaseCharge={releaseCharge}
        />

        <a
          href="https://freegamestore.online"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--muted)", fontSize: "0.7rem", textDecoration: "none" }}
        >
          Part of FreeGameStore — free forever
        </a>
      </div>
    </GameShell>
  );
}

function ShootButton({
  stateRef,
  phaseRef,
  startCharge,
  releaseCharge,
}: {
  stateRef: React.MutableRefObject<GameState>;
  phaseRef: React.MutableRefObject<Phase>;
  startCharge: () => void;
  releaseCharge: () => void;
}) {
  // Re-render at ~60Hz while charging to show power fill — cheap.
  const [, force] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const s = stateRef.current;
      if (s.charging || s.aimPower > 0) force((x) => x + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stateRef]);

  const s = stateRef.current;
  const phase = phaseRef.current;
  const disabled = phase !== "aiming" || s.ballInHand;
  const power = s.aimPower;
  const label = s.ballInHand ? "TAP TABLE TO PLACE CUE" : power > 0 ? `${Math.round(power * 100)}%` : "HOLD TO CHARGE · RELEASE TO SHOOT";

  return (
    <button
      onPointerDown={(e) => {
        e.preventDefault();
        // Capture so leaving the button bounds (common on mobile) doesn't
        // trigger an accidental release. Pointer events keep flowing to the
        // button until pointerup or pointercancel.
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not supported */ }
        startCharge();
      }}
      onPointerUp={(e) => { e.preventDefault(); releaseCharge(); }}
      onPointerCancel={() => {
        // System aborted the gesture — drop charge without firing.
        const s = stateRef.current;
        s.charging = false;
        s.chargeArmed = false;
        s.aimPower = 0;
      }}
      disabled={disabled}
      aria-label="Shoot — hold to charge, release to fire"
      style={{
        position: "relative",
        width: "100%",
        maxWidth: "22rem",
        height: "3.4rem",
        border: "none",
        borderRadius: "0.75rem",
        background: disabled ? "rgba(120,120,120,0.25)" : "rgba(0,0,0,0.55)",
        color: "var(--paper)",
        fontFamily: "Fraunces, serif",
        fontWeight: 800,
        fontSize: "0.9rem",
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        overflow: "hidden",
        boxShadow: "0 4px 0 rgba(0,0,0,0.25)",
      }}
    >
      {/* Power fill overlay */}
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: `${power * 100}%`,
          background: power > 0.85 ? "#ef4444" : "#facc15",
          transition: "width 30ms linear",
          zIndex: 0,
        }}
      />
      <span style={{ position: "relative", zIndex: 1, mixBlendMode: "difference", color: "#fff" }}>
        {label}
      </span>
    </button>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.75rem",
        background: "rgba(0,0,0,0.86)",
        borderRadius: "0.25rem",
      }}
    >
      {children}
    </div>
  );
}

function shootCue(s: GameState, angle: number, power: number) {
  const cue = s.balls.find((b) => b.id === 0 && !b.pocketed);
  if (!cue) return;
  const v = power * MAX_POWER;
  cue.vx = Math.cos(angle) * v;
  cue.vy = Math.sin(angle) * v;
  s.firstHit = -1;
  s.shotSunk = [];
  s.settleTimer = 0;
  s.aimPower = 0;
}

function drawBall(ctx: CanvasRenderingContext2D, b: Ball, r: number) {
  const color = BALL_COLORS[b.id] ?? "#fff";
  const isStripe = b.id >= 9;

  // Shadow
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath();
  ctx.arc(b.x + 1.4, b.y + 1.6, r, 0, Math.PI * 2);
  ctx.fill();

  // Body
  if (isStripe) {
    // white base + colored stripe band
    ctx.fillStyle = "#fafaf8";
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.fillRect(b.x - r, b.y - r * 0.45, r * 2, r * 0.9);
    ctx.restore();
  } else {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Number disc
  if (b.id > 0) {
    ctx.fillStyle = "#fafaf8";
    ctx.beginPath();
    ctx.arc(b.x, b.y, r * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0a0a0a";
    ctx.font = `bold ${Math.max(6, r * 0.78)}px Manrope, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(b.id), b.x, b.y + 0.5);
  }

  // Highlight
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.beginPath();
  ctx.arc(b.x - r * 0.32, b.y - r * 0.32, r * 0.22, 0, Math.PI * 2);
  ctx.fill();

  // Outline
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
  ctx.stroke();
}

function drawPopup(ctx: CanvasRenderingContext2D, p: ScorePopup) {
  const t = p.age / 1000;
  const yOff = -18 * t;
  const alpha = Math.max(0, 1 - t);
  ctx.font = "bold 10px 'Fraunces', serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = `rgba(0,0,0,${alpha * 0.7})`;
  ctx.fillText(p.text, p.x + 1, p.y + yOff + 1);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = p.color;
  ctx.fillText(p.text, p.x, p.y + yOff);
  ctx.globalAlpha = 1;
}
