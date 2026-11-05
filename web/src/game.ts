import type { useGameSounds } from "@freegamestore/games";

// ─── Table constants (logical pixels — canvas scales via CSS) ───────
export const TABLE_W = 720;
export const TABLE_H = 360;
export const CUSHION = 24;          // padding between outer edge and play area
export const BALL_R = 9;
export const POCKET_R = 16;

const FRICTION_PER_MS = 0.9985;
const MIN_VEL = 0.04;        // below this, set ball velocity to 0
const MAX_POWER = 1.4;       // px/ms — sane max so we don't tunnel
export const CHARGE_RATE_PER_MS = 0.0014;  // 0..1 over ~715ms hold for full power
export const MIN_FIRE_POWER = 0.08;        // releasing below this cancels (avoids accidental taps)
const CUSHION_RESTITUTION = 0.78;
const BALL_RESTITUTION = 0.96;

export const SETTLE_FRAMES = 14;    // # of consecutive still frames before turn ends

// Pockets — 4 corners + 2 sides
export const POCKETS = [
  { x: CUSHION,            y: CUSHION },
  { x: TABLE_W / 2,        y: CUSHION - 4 },
  { x: TABLE_W - CUSHION,  y: CUSHION },
  { x: CUSHION,            y: TABLE_H - CUSHION },
  { x: TABLE_W / 2,        y: TABLE_H - CUSHION + 4 },
  { x: TABLE_W - CUSHION,  y: TABLE_H - CUSHION },
];

// Standard 8-ball numbers: 1-7 solids, 8 black, 9-15 stripes
export const BALL_COLORS: Record<number, string> = {
  0: "#f6f1e1",
  1: "#f5c518", 2: "#1d4ed8", 3: "#dc2626", 4: "#7c3aed",
  5: "#ea580c", 6: "#15803d", 7: "#7f1d1d",
  8: "#0b0b0b",
  9: "#f5c518", 10: "#1d4ed8", 11: "#dc2626", 12: "#7c3aed",
  13: "#ea580c", 14: "#15803d", 15: "#7f1d1d",
};

type BallGroup = "solids" | "stripes" | null;
type Player = 1 | 2;
export type Phase =
  | "intro"
  | "aiming"        // player can drag to aim+set power
  | "shooting"     // balls in motion, waiting to settle
  | "ai-thinking"  // brief pause before AI shoots
  | "won"
  | "lost";

export interface Ball {
  id: number;
  x: number; y: number;
  vx: number; vy: number;
  pocketed: boolean;
  sinkAge: number; // ms since pocketed, for shrink animation
}

export interface ScorePopup {
  x: number; y: number;
  text: string; color: string;
  age: number;
}

export interface GameState {
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
  // sound throttle
  lastClackAt: number;
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

export function freshState(): GameState {
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
    lastClackAt: 0,
  };
}

export function ballsStill(balls: Ball[]): boolean {
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

export function physicsStep(
  s: GameState,
  dt: number,
  onCollide?: (dvn: number) => void,
): { pocketed: number[] } {
  const pocketed: number[] = [];
  // Adaptive substeps: a fast ball can otherwise overshoot a pocket between
  // checks. Cap movement per substep to roughly half a ball radius so a ball
  // that's straight-lining toward a pocket can't pass it without being seen.
  let maxV = 0;
  for (const b of s.balls) {
    if (b.pocketed) continue;
    const v = Math.hypot(b.vx, b.vy);
    if (v > maxV) maxV = v;
  }
  const maxStepPx = BALL_R * 0.55;
  const sub = Math.max(2, Math.min(8, Math.ceil((maxV * dt) / maxStepPx)));
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
            if (onCollide) onCollide(dvn);
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

export function chooseAiShot(s: GameState): { angle: number; power: number } {
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

  // Score every (ball × pocket) combo. The "best" shot is along the
  // cue→ghost→pocket segment with no blockers on either segment.
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
        // Easier (more direct) shots use less force; harder shots need a bit
        // more push. We mix cut quality + path length so the AI doesn't
        // pulverize every shot at max power and risk a scratch.
        const easeBoost = (1 - cutCos) * 0.25;             // wider cut = harder = bump power
        const distanceBoost = Math.min(0.45, totalLen / 1400);
        const power = Math.max(0.35, Math.min(0.95, 0.42 + distanceBoost + easeBoost));
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

export function resolveShot(s: GameState, sounds: ReturnType<typeof useGameSounds>) {
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
      // Pocketing the 8-ball while also scratching the cue is an automatic
      // loss in 8-ball, even if all of your group is already down.
      const alsoScratched = s.shotSunk.includes(0);
      const legalEight = mySunk >= 7 && myGroup && !foul && !alsoScratched;
      if (legalEight) {
        s.phase = s.player === 1 ? "won" : "lost";
        s.message = s.player === 1 ? "8-ball pocketed — you win!" : "AI sinks the 8 — you lose.";
        sounds.playLevelUp();
      } else {
        // Early 8-ball OR 8-and-scratch → other player wins.
        s.phase = s.player === 1 ? "lost" : "won";
        const reason = alsoScratched && mySunk >= 7 && myGroup ? "8 + scratch" : "Early 8";
        s.message = `${reason} — ${s.player === 1 ? "AI wins" : "you win"}`;
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
        s.popups.push({ x: ball.x, y: ball.y - BALL_R - 4, text: `+1`, color: "#94a3b8", age: 0 });
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

export function shootCue(s: GameState, angle: number, power: number) {
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
