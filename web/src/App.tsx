import { useRef, useEffect, useState, useCallback } from "react";
import { GameShell, GameTopbar, GameAuth, useGameSounds } from "@freegamestore/games";

// ── Constants ────────────────────────────────────────────────────

const TABLE_W = 800;
const TABLE_H = 400;
const CUSHION = 30;
const POCKET_R = 18;
const BALL_R = 10;
const FRICTION = 0.985;
const MIN_VEL = 0.15;
const MAX_POWER = 22;

// Pocket positions (6 pockets)
const POCKETS = [
  { x: CUSHION, y: CUSHION },
  { x: TABLE_W / 2, y: CUSHION - 4 },
  { x: TABLE_W - CUSHION, y: CUSHION },
  { x: CUSHION, y: TABLE_H - CUSHION },
  { x: TABLE_W / 2, y: TABLE_H - CUSHION + 4 },
  { x: TABLE_W - CUSHION, y: TABLE_H - CUSHION },
];

// Ball colors: 1-7 solids, 8 black, 9-15 stripes
const BALL_COLORS: Record<number, string> = {
  0: "#f5f5f0", // cue
  1: "#ffd700", 2: "#0055cc", 3: "#dd2200", 4: "#6622aa",
  5: "#ff6600", 6: "#117733", 7: "#882222",
  8: "#111111",
  9: "#ffd700", 10: "#0055cc", 11: "#dd2200", 12: "#6622aa",
  13: "#ff6600", 14: "#117733", 15: "#882222",
};

type BallGroup = "solids" | "stripes" | null;
type Player = 1 | 2;

interface Ball {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pocketed: boolean;
}

interface GameState {
  balls: Ball[];
  currentPlayer: Player;
  p1Group: BallGroup;
  p2Group: BallGroup;
  p1Pocketed: number;
  p2Pocketed: number;
  aiming: boolean;
  shooting: boolean;
  gameOver: boolean;
  winner: Player | null;
  message: string;
  foul: boolean;
}

function rackBalls(): Ball[] {
  const balls: Ball[] = [];
  // Cue ball
  balls.push({ id: 0, x: TABLE_W * 0.25, y: TABLE_H / 2, vx: 0, vy: 0, pocketed: false });

  // Triangle rack at ~72% of table width
  const startX = TABLE_W * 0.72;
  const startY = TABLE_H / 2;
  const spacing = BALL_R * 2.05;

  // Standard 8-ball rack: 8 in center, rest mixed
  const rackOrder = [1, 9, 2, 10, 8, 11, 3, 12, 4, 13, 5, 14, 6, 15, 7];
  let idx = 0;
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col <= row; col++) {
      const x = startX + row * spacing * Math.cos(Math.PI / 6);
      const y = startY + (col - row / 2) * spacing;
      const ballId = rackOrder[idx]!;
      balls.push({ id: ballId, x, y, vx: 0, vy: 0, pocketed: false });
      idx++;
    }
  }
  return balls;
}

function createInitState(): GameState {
  return {
    balls: rackBalls(),
    currentPlayer: 1,
    p1Group: null,
    p2Group: null,
    p1Pocketed: 0,
    p2Pocketed: 0,
    aiming: true,
    shooting: false,
    gameOver: false,
    winner: null,
    message: "Player 1 — Aim and shoot!",
    foul: false,
  };
}

function ballsMoving(balls: Ball[]): boolean {
  return balls.some(b => !b.pocketed && (Math.abs(b.vx) > MIN_VEL || Math.abs(b.vy) > MIN_VEL));
}

function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

function ballGroup(id: number): "solids" | "stripes" | "eight" | "cue" {
  if (id === 0) return "cue";
  if (id === 8) return "eight";
  if (id <= 7) return "solids";
  return "stripes";
}

// ── Physics step ─────────────────────────────────────────────────

function physicsStep(balls: Ball[]): { pocketed: number[] } {
  const pocketed: number[] = [];

  // Move balls
  for (const b of balls) {
    if (b.pocketed) continue;
    b.x += b.vx;
    b.y += b.vy;
    b.vx *= FRICTION;
    b.vy *= FRICTION;
    if (Math.abs(b.vx) < MIN_VEL * 0.5) b.vx = 0;
    if (Math.abs(b.vy) < MIN_VEL * 0.5) b.vy = 0;
  }

  // Cushion bounces
  for (const b of balls) {
    if (b.pocketed) continue;
    const left = CUSHION + BALL_R;
    const right = TABLE_W - CUSHION - BALL_R;
    const top = CUSHION + BALL_R;
    const bottom = TABLE_H - CUSHION - BALL_R;

    if (b.x < left) { b.x = left; b.vx = Math.abs(b.vx) * 0.8; }
    if (b.x > right) { b.x = right; b.vx = -Math.abs(b.vx) * 0.8; }
    if (b.y < top) { b.y = top; b.vy = Math.abs(b.vy) * 0.8; }
    if (b.y > bottom) { b.y = bottom; b.vy = -Math.abs(b.vy) * 0.8; }
  }

  // Ball-to-ball collisions
  const active = balls.filter(b => !b.pocketed);
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!;
      const b = active[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const minDist = BALL_R * 2;
      if (d < minDist && d > 0) {
        const nx = dx / d;
        const ny = dy / d;
        const dvx = a.vx - b.vx;
        const dvy = a.vy - b.vy;
        const dvn = dvx * nx + dvy * ny;
        if (dvn > 0) {
          a.vx -= dvn * nx;
          a.vy -= dvn * ny;
          b.vx += dvn * nx;
          b.vy += dvn * ny;
        }
        const overlap = (minDist - d) / 2;
        a.x -= overlap * nx;
        a.y -= overlap * ny;
        b.x += overlap * nx;
        b.y += overlap * ny;
      }
    }
  }

  // Pocketing
  for (const b of balls) {
    if (b.pocketed) continue;
    for (const p of POCKETS) {
      if (dist(b.x, b.y, p.x, p.y) < POCKET_R + BALL_R * 0.5) {
        b.pocketed = true;
        b.vx = 0;
        b.vy = 0;
        pocketed.push(b.id);
        break;
      }
    }
  }

  return { pocketed };
}

// ── AI ───────────────────────────────────────────────────────────

function aiShoot(gs: GameState): { angle: number; power: number } {
  const cue = gs.balls.find(b => b.id === 0 && !b.pocketed);
  if (!cue) return { angle: 0, power: 8 };

  const aiGroup = gs.p2Group;
  const targets = gs.balls.filter(b => {
    if (b.pocketed || b.id === 0) return false;
    if (!aiGroup) return b.id !== 8;
    const g = ballGroup(b.id);
    if (g === "eight") return gs.p2Pocketed >= 7;
    return g === aiGroup;
  });

  if (targets.length === 0) {
    const eight = gs.balls.find(b => b.id === 8 && !b.pocketed);
    if (eight) {
      const angle = Math.atan2(eight.y - cue.y, eight.x - cue.x);
      return { angle, power: 8 + Math.random() * 6 };
    }
    return { angle: Math.random() * Math.PI * 2, power: 8 };
  }

  const target = targets[Math.floor(Math.random() * targets.length)]!;
  const angle = Math.atan2(target.y - cue.y, target.x - cue.x);
  const jitter = (Math.random() - 0.5) * 0.15;
  return { angle: angle + jitter, power: 8 + Math.random() * 8 };
}

// ── Drawing ──────────────────────────────────────────────────────

function drawTable(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const sx = w / TABLE_W;
  const sy = h / TABLE_H;
  ctx.save();
  ctx.scale(sx, sy);

  // Table border (wood)
  ctx.fillStyle = "#5c3317";
  ctx.fillRect(0, 0, TABLE_W, TABLE_H);

  // Felt
  ctx.fillStyle = "#1a7a3a";
  ctx.fillRect(CUSHION, CUSHION, TABLE_W - CUSHION * 2, TABLE_H - CUSHION * 2);

  // Head string line
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(TABLE_W * 0.25, CUSHION);
  ctx.lineTo(TABLE_W * 0.25, TABLE_H - CUSHION);
  ctx.stroke();

  // Pockets
  for (const p of POCKETS) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, POCKET_R, 0, Math.PI * 2);
    ctx.fillStyle = "#111";
    ctx.fill();
  }

  // Inner rail edge
  ctx.strokeStyle = "#2d8a4e";
  ctx.lineWidth = 2;
  ctx.strokeRect(CUSHION, CUSHION, TABLE_W - CUSHION * 2, TABLE_H - CUSHION * 2);

  ctx.restore();
}

function drawBalls(ctx: CanvasRenderingContext2D, balls: Ball[], w: number, h: number) {
  const sx = w / TABLE_W;
  const sy = h / TABLE_H;
  ctx.save();
  ctx.scale(sx, sy);

  for (const b of balls) {
    if (b.pocketed) continue;
    const color = BALL_COLORS[b.id] ?? "#fff";
    const isStripe = b.id >= 9;

    // Shadow
    ctx.beginPath();
    ctx.arc(b.x + 1.5, b.y + 1.5, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fill();

    // Ball body
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);

    if (isStripe) {
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = color;
      ctx.fillRect(b.x - BALL_R, b.y - BALL_R * 0.45, BALL_R * 2, BALL_R * 0.9);
      ctx.restore();
    } else {
      ctx.fillStyle = color;
      ctx.fill();
    }

    // Border
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,0,0,0.3)";
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Number circle
    if (b.id > 0) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, BALL_R * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.fillStyle = "#000";
      ctx.font = `bold ${BALL_R * 0.85}px Manrope, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(b.id), b.x, b.y + 0.5);
    }

    // Highlight
    ctx.beginPath();
    ctx.arc(b.x - BALL_R * 0.3, b.y - BALL_R * 0.3, BALL_R * 0.25, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fill();
  }

  ctx.restore();
}

function drawCue(
  ctx: CanvasRenderingContext2D,
  cue: Ball,
  angle: number,
  power: number,
  w: number,
  h: number,
) {
  const sx = w / TABLE_W;
  const sy = h / TABLE_H;
  ctx.save();
  ctx.scale(sx, sy);

  const gap = BALL_R + 4 + power * 2;
  const cueLen = 120;
  const startX = cue.x - Math.cos(angle) * gap;
  const startY = cue.y - Math.sin(angle) * gap;
  const endX = startX - Math.cos(angle) * cueLen;
  const endY = startY - Math.sin(angle) * cueLen;

  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(endX, endY);
  ctx.strokeStyle = "#c8a050";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.stroke();

  // Cue tip
  ctx.beginPath();
  ctx.arc(startX, startY, 2, 0, Math.PI * 2);
  ctx.fillStyle = "#4488ff";
  ctx.fill();

  // Aiming line (dotted)
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(cue.x, cue.y);
  ctx.lineTo(cue.x + Math.cos(angle) * 200, cue.y + Math.sin(angle) * 200);
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.restore();
}

function drawPowerBar(ctx: CanvasRenderingContext2D, power: number, w: number, h: number) {
  const barW = 12;
  const barH = h * 0.5;
  const x = w - 24;
  const y = (h - barH) / 2;

  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, barW, barH, 6);
  ctx.fill();
  ctx.stroke();

  const fillH = barH * (power / MAX_POWER);
  const t = power / MAX_POWER;
  const r = Math.round(50 + t * 200);
  const g = Math.round(200 - t * 170);
  ctx.fillStyle = `rgb(${r},${g},50)`;
  ctx.beginPath();
  ctx.roundRect(x, y + barH - fillH, barW, fillH, 6);
  ctx.fill();
}

// ── Main component ───────────────────────────────────────────────

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<GameState>(createInitState());
  const aimRef = useRef({ angle: 0, power: 0, dragging: false });
  const animRef = useRef<number>(0);
  const sounds = useGameSounds();

  const [p1Pocketed, setP1Pocketed] = useState(0);
  const [p2Pocketed, setP2Pocketed] = useState(0);
  const [message, setMessage] = useState("Player 1 — Aim and shoot!");
  const [gameOver, setGameOver] = useState(false);
  const [winner, setWinner] = useState<Player | null>(null);
  const [, setTick] = useState(0);

  const resetGame = useCallback(() => {
    stateRef.current = createInitState();
    aimRef.current = { angle: 0, power: 0, dragging: false };
    setP1Pocketed(0);
    setP2Pocketed(0);
    setMessage("Player 1 — Aim and shoot!");
    setGameOver(false);
    setWinner(null);
    setTick(t => t + 1);
  }, []);

  const syncUI = useCallback((gs: GameState) => {
    setP1Pocketed(gs.p1Pocketed);
    setP2Pocketed(gs.p2Pocketed);
    setMessage(gs.message);
    setGameOver(gs.gameOver);
    setWinner(gs.winner);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let settleTimer = 0;
    let aiTimer = 0;
    let firstHitId = -1;
    let shotPocketed: number[] = [];

    function resize() {
      const parent = canvas!.parentElement!;
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width = w + "px";
      canvas!.style.height = h + "px";
    }
    resize();
    window.addEventListener("resize", resize);

    function canvasToTable(cx: number, cy: number): { x: number; y: number } {
      const rect = canvas!.getBoundingClientRect();
      const rx = (cx - rect.left) / rect.width;
      const ry = (cy - rect.top) / rect.height;
      return { x: rx * TABLE_W, y: ry * TABLE_H };
    }

    function onPointerDown(e: PointerEvent) {
      const gs = stateRef.current;
      if (gs.gameOver || gs.shooting || gs.currentPlayer === 2) return;
      const cue = gs.balls.find(b => b.id === 0 && !b.pocketed);
      if (!cue) return;

      const pt = canvasToTable(e.clientX, e.clientY);
      if (dist(pt.x, pt.y, cue.x, cue.y) < BALL_R * 4) {
        aimRef.current.dragging = true;
      }
    }

    function onPointerMove(e: PointerEvent) {
      const gs = stateRef.current;
      if (gs.gameOver || gs.shooting || gs.currentPlayer === 2) return;
      const cue = gs.balls.find(b => b.id === 0 && !b.pocketed);
      if (!cue) return;

      const pt = canvasToTable(e.clientX, e.clientY);

      if (aimRef.current.dragging) {
        // Slingshot: drag AWAY from cue ball sets direction + power
        const dx = cue.x - pt.x;
        const dy = cue.y - pt.y;
        aimRef.current.angle = Math.atan2(dy, dx) + Math.PI;
        const d = Math.sqrt(dx * dx + dy * dy);
        aimRef.current.power = Math.min(MAX_POWER, d * 0.15);
      } else {
        aimRef.current.angle = Math.atan2(pt.y - cue.y, pt.x - cue.x);
      }
    }

    function onPointerUp() {
      if (!aimRef.current.dragging) return;
      aimRef.current.dragging = false;

      const gs = stateRef.current;
      if (gs.gameOver || gs.shooting || gs.currentPlayer === 2) return;

      const power = aimRef.current.power;
      if (power < 1) return;
      shoot(aimRef.current.angle, power);
    }

    function onKeyDown(e: KeyboardEvent) {
      const gs = stateRef.current;
      if (gs.gameOver || gs.shooting || gs.currentPlayer === 2) return;

      if (e.key === "ArrowLeft") {
        aimRef.current.angle -= 0.04;
      } else if (e.key === "ArrowRight") {
        aimRef.current.angle += 0.04;
      } else if (e.key === "ArrowUp") {
        aimRef.current.power = Math.min(MAX_POWER, aimRef.current.power + 1);
      } else if (e.key === "ArrowDown") {
        aimRef.current.power = Math.max(0, aimRef.current.power - 1);
      } else if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (aimRef.current.power > 0) {
          shoot(aimRef.current.angle, aimRef.current.power);
        }
      }
    }

    function shoot(angle: number, power: number) {
      const gs = stateRef.current;
      const cue = gs.balls.find(b => b.id === 0 && !b.pocketed);
      if (!cue) return;

      cue.vx = Math.cos(angle) * power;
      cue.vy = Math.sin(angle) * power;
      gs.shooting = true;
      gs.aiming = false;
      gs.foul = false;
      settleTimer = 0;
      firstHitId = -1;
      shotPocketed = [];
      sounds.playMove();
    }

    function checkFirstHit() {
      const gs = stateRef.current;
      if (firstHitId >= 0) return;
      const cue = gs.balls.find(b => b.id === 0);
      if (!cue || cue.pocketed) return;

      for (const b of gs.balls) {
        if (b.id === 0 || b.pocketed) continue;
        if (dist(cue.x, cue.y, b.x, b.y) < BALL_R * 2.2) {
          firstHitId = b.id;
          return;
        }
      }
    }

    function handleShotResult() {
      const gs = stateRef.current;
      let foul = false;
      let scored = false;

      if (firstHitId < 0) {
        foul = true;
      } else {
        const ownGroup = gs.currentPlayer === 1 ? gs.p1Group : gs.p2Group;
        if (ownGroup) {
          const hitG = ballGroup(firstHitId);
          if (hitG !== ownGroup && hitG !== "eight") foul = true;
          const ownPocketed = gs.currentPlayer === 1 ? gs.p1Pocketed : gs.p2Pocketed;
          if (hitG === "eight" && ownPocketed < 7) foul = true;
        }
      }

      for (const id of shotPocketed) {
        const g = ballGroup(id);

        if (id === 0) {
          foul = true;
          continue;
        }

        if (id === 8) {
          const ownGroup = gs.currentPlayer === 1 ? gs.p1Group : gs.p2Group;
          const ownPocketed = gs.currentPlayer === 1 ? gs.p1Pocketed : gs.p2Pocketed;
          if (ownPocketed >= 7 && ownGroup && !foul) {
            gs.gameOver = true;
            gs.winner = gs.currentPlayer;
            gs.message = `Player ${gs.currentPlayer} wins!`;
            sounds.playGameOver();
            syncUI(gs);
            return;
          } else {
            gs.gameOver = true;
            gs.winner = gs.currentPlayer === 1 ? 2 : 1;
            gs.message = `Player ${gs.currentPlayer === 1 ? 2 : 1} wins! (Early 8-ball)`;
            sounds.playGameOver();
            syncUI(gs);
            return;
          }
        }

        // Assign groups on first legal pocket
        if (!gs.p1Group && g !== "eight" && g !== "cue") {
          if (gs.currentPlayer === 1) {
            gs.p1Group = g;
            gs.p2Group = g === "solids" ? "stripes" : "solids";
          } else {
            gs.p2Group = g;
            gs.p1Group = g === "solids" ? "stripes" : "solids";
          }
        }

        const ownGroup = gs.currentPlayer === 1 ? gs.p1Group : gs.p2Group;
        if (g === ownGroup) {
          if (gs.currentPlayer === 1) gs.p1Pocketed++;
          else gs.p2Pocketed++;
          scored = true;
          sounds.playScore();
        } else if (g !== "cue" && g !== "eight") {
          if (gs.currentPlayer === 1) gs.p2Pocketed++;
          else gs.p1Pocketed++;
        }
      }

      if (foul) {
        gs.foul = true;
        sounds.playError();
        const cueBall = gs.balls.find(b => b.id === 0);
        if (cueBall && cueBall.pocketed) {
          cueBall.pocketed = false;
          cueBall.x = TABLE_W * 0.25;
          cueBall.y = TABLE_H / 2;
          cueBall.vx = 0;
          cueBall.vy = 0;
          for (const b of gs.balls) {
            if (b.id === 0 || b.pocketed) continue;
            if (dist(cueBall.x, cueBall.y, b.x, b.y) < BALL_R * 2.5) {
              cueBall.y += BALL_R * 3;
            }
          }
        }
      }

      if (!scored || foul) {
        gs.currentPlayer = gs.currentPlayer === 1 ? 2 : 1;
      }

      gs.shooting = false;
      gs.aiming = true;
      aimRef.current.power = 0;

      const foulStr = foul ? " (Foul!)" : "";
      const groupLabel = gs.currentPlayer === 1 ? (gs.p1Group ?? "any") : (gs.p2Group ?? "any");
      gs.message = `Player ${gs.currentPlayer} — ${groupLabel}${foulStr}`;

      if (gs.currentPlayer === 2 && !gs.gameOver) {
        aiTimer = 60;
      }

      syncUI(gs);
    }

    function gameLoop() {
      const gs = stateRef.current;

      resize();
      const w = canvas!.width;
      const h = canvas!.height;
      ctx!.clearRect(0, 0, w, h);

      drawTable(ctx!, w, h);
      drawBalls(ctx!, gs.balls, w, h);

      const cue = gs.balls.find(b => b.id === 0 && !b.pocketed);

      if (gs.shooting) {
        const result = physicsStep(gs.balls);
        if (result.pocketed.length > 0) {
          shotPocketed.push(...result.pocketed);
        }
        checkFirstHit();

        if (!ballsMoving(gs.balls)) {
          settleTimer++;
          if (settleTimer > 15) {
            handleShotResult();
          }
        } else {
          settleTimer = 0;
        }
      }

      if (gs.aiming && !gs.gameOver && cue && gs.currentPlayer === 1) {
        drawCue(ctx!, cue, aimRef.current.angle, aimRef.current.power, w, h);
        if (aimRef.current.power > 0) {
          drawPowerBar(ctx!, aimRef.current.power, w, h);
        }
      }

      if (gs.currentPlayer === 2 && gs.aiming && !gs.gameOver) {
        aiTimer--;
        if (aiTimer <= 0) {
          const shot = aiShoot(gs);
          aimRef.current.angle = shot.angle;
          aimRef.current.power = shot.power;
          if (cue) drawCue(ctx!, cue, shot.angle, shot.power, w, h);
          shoot(shot.angle, shot.power);
        } else if (cue) {
          const shot = aiShoot(gs);
          drawCue(ctx!, cue, shot.angle, shot.power * 0.5, w, h);
        }
      }

      animRef.current = requestAnimationFrame(gameLoop);
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown);

    animRef.current = requestAnimationFrame(gameLoop);

    return () => {
      cancelAnimationFrame(animRef.current);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", resize);
    };
  }, [syncUI, sounds]);

  return (
    <GameShell
      topbar={
        <GameTopbar
          title="Billiards"
          stats={[
            { label: "P1", value: p1Pocketed },
            { label: "P2", value: p2Pocketed },
          ]}
          onRestart={resetGame}
          actions={<GameAuth />}
          rules={
            <div>
              <h3 style={{ fontWeight: 700 }}>8-Ball Pool</h3>
              <h4 style={{ fontWeight: 600 }}>How to Play</h4>
              <ul>
                <li>Tap near the cue ball and drag away to aim (slingshot)</li>
                <li>Drag distance sets power</li>
                <li>Release to shoot</li>
                <li>Arrow keys + Space as alternative</li>
              </ul>
              <h4 style={{ fontWeight: 600 }}>Rules</h4>
              <ul>
                <li>Pocket all your balls (solids or stripes), then the 8-ball</li>
                <li>Groups assigned on first legal pocket</li>
                <li>Scratching (pocketing cue ball) is a foul</li>
                <li>Pocketing 8-ball early loses the game</li>
              </ul>
            </div>
          }
        />
      }
    >
      <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", userSelect: "none" }}>
        <canvas
          ref={canvasRef}
          style={{
            width: "100%",
            height: "100%",
            display: "block",
            touchAction: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: 12,
            left: "50%",
            transform: "translateX(-50%)",
            fontFamily: "Manrope, sans-serif",
            fontSize: 14,
            fontWeight: 600,
            color: "rgba(255,255,255,0.85)",
            textShadow: "0 1px 4px rgba(0,0,0,0.6)",
            padding: "4px 16px",
            borderRadius: 8,
            background: "rgba(0,0,0,0.4)",
            backdropFilter: "blur(4px)",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {message}
        </div>
        {gameOver && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 16,
              background: "rgba(0,0,0,0.55)",
            }}
          >
            <p
              style={{
                fontSize: 24,
                fontWeight: 700,
                color: winner === 1 ? "var(--success)" : "var(--error)",
                fontFamily: "Fraunces, serif",
              }}
            >
              {winner === 1 ? "You Win!" : "You Lose!"}
            </p>
            <button
              onClick={resetGame}
              style={{
                padding: "12px 24px",
                borderRadius: 12,
                fontWeight: 600,
                fontSize: 16,
                background: "var(--accent)",
                color: "#fff",
                border: "none",
                cursor: "pointer",
                minHeight: 44,
                minWidth: 44,
              }}
            >
              Play Again
            </button>
          </div>
        )}
      </div>
    </GameShell>
  );
}
