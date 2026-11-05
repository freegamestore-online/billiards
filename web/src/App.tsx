import { useEffect, useRef, useState, useCallback } from "react";
import {
  GameShell,
  GameTopbar,
  GameAuth,
  GameButton,
  useGameSounds,
} from "@freegamestore/games";
import { useHighScore } from "./hooks/useHighScore";
import {
  BALL_COLORS,
  BALL_R,
  CHARGE_RATE_PER_MS,
  CUSHION,
  MIN_FIRE_POWER,
  POCKETS,
  POCKET_R,
  SETTLE_FRAMES,
  TABLE_H,
  TABLE_W,
  ballsStill,
  chooseAiShot,
  freshState,
  physicsStep,
  resolveShot,
  shootCue,
  type Ball,
  type GameState,
  type Phase,
  type ScorePopup,
} from "./game";

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
        const result = physicsStep(s, dt, (dvn) => {
          // Throttle clack sounds so a stack of collisions in one frame
          // doesn't smother the audio. Only emit for "solid" impacts.
          if (dvn < 0.35) return;
          if (s.time - s.lastClackAt < 70) return;
          s.lastClackAt = s.time;
          sounds.playTick();
        });
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
