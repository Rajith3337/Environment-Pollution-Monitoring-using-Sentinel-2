import { useRef, useEffect, useState } from "react";
import { Icon } from "./Icons";
import { PIPELINE_STEPS } from "../data/mockData";

// ── Single step row ───────────────────────────────────────────────────────
function StepRow({ step, state, index, isLive }) {
  const done    = state === "done";
  const running = state === "running";
  const col     = done ? "var(--accent)" : running ? "var(--warn)" : "var(--muted2)";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "4px 8px", borderRadius: 6,
      background: running ? "rgba(251,191,36,0.05)" : done ? "rgba(0,240,168,0.02)" : "transparent",
      border: running ? "1px solid rgba(251,191,36,0.15)" : done ? "1px solid rgba(0,240,168,0.08)" : "1px solid transparent",
      transition: "background 0.4s, border-color 0.4s",
      animation: `step-row-enter 0.28s ${index * 0.04}s ease both`,
    }}>
      {/* circle indicator */}
      <div style={{
        width: 18, height: 18, borderRadius: "50%", flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: done ? "var(--accent)" : running ? "transparent" : "var(--surface)",
        border: done ? "none" : `1.5px solid ${col}`,
        boxShadow: done ? "0 0 6px rgba(0,240,168,0.35)" : running ? "0 0 8px rgba(251,191,36,0.4)" : "none",
        transition: "all 0.3s",
        animation: done ? "step-ping 0.5s ease-out" : "none",
      }}>
        {done    && <span style={{ color: "#000", display:"flex", animation: "tick-pop 0.35s cubic-bezier(0.34,1.56,0.64,1) both" }}><Icon.Check /></span>}
        {running && <span style={{ color: "var(--warn)", display:"flex" }}><Icon.Loader /></span>}
        {!done && !running && (
          <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted2)" }}>{index + 1}</span>
        )}
      </div>

      <span style={{
        fontFamily: "var(--mono)", fontSize: 10, flex: 1,
        color: done ? "var(--text)" : running ? "var(--warn)" : "var(--muted)",
        transition: "color 0.3s",
      }}>
        {step.label}
      </span>

      {running && (
        <div style={{ width: 40, height: 2, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
          <div style={{
            height: "100%",
            backgroundImage: "linear-gradient(90deg, transparent, var(--warn), transparent)",
            backgroundSize: "200% 100%",
            animation: "shimmer 1.2s ease infinite",
          }} />
        </div>
      )}
      {done && (
        <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--accent)", opacity: 0.5 }}>✓</span>
      )}
    </div>
  );
}

// ── Terminal-style log viewer ─────────────────────────────────────────────
function LogTerminal({ logs, active }) {
  const bottomRef = useRef(null);
  const containerRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll to bottom — use scrollTop directly to stay inside the terminal container
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  return (
    <div style={{ position: "relative" }}>
      {/* Terminal header bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "7px 10px",
        background: "var(--bg)", borderRadius: "7px 7px 0 0",
        borderBottom: "1px solid var(--border)",
      }}>
        {/* Traffic lights */}
        {["#f87171","#fbbf24","#34d399"].map(c => (
          <div key={c} style={{ width: 8, height: 8, borderRadius: "50%", background: c, opacity: 0.7 }} />
        ))}
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", marginLeft: 4, letterSpacing: 0.5 }}>
          BACKEND LOGS
        </span>
        {active && (
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "flex-end", gap: 3 }}>
            {[0.35, 0.6, 0.85, 1.0].map((h, i) => (
              <div key={i} style={{
                width: 3, borderRadius: "1px 1px 0 0",
                height: `${h * 11}px`,
                background: "var(--warn)",
                animation: `bar-bounce 0.85s ${i * 0.13}s ease-in-out infinite`,
                transformOrigin: "bottom",
              }} />
            ))}
            <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--warn)", letterSpacing: 1, marginLeft: 3 }}>LIVE</span>
          </div>
        )}
        {!active && logs.length > 0 && (
          <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted)" }}>
            {logs.length} lines
          </span>
        )}
        {active && logs.length > 0 && (
          <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted2)", marginLeft: 6 }}>
            {logs.length} lines
          </span>
        )}
      </div>

      {/* Log lines */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          height: 260,
          overflowY: "auto",
          background: "var(--bg)",
          borderRadius: "0 0 7px 7px",
          padding: "8px 10px",
          display: "flex", flexDirection: "column", gap: 1,
          border: "1px solid var(--border)", borderTop: "none",
          fontFamily: "var(--mono)", fontSize: 10,
        }}
      >
        {logs.length === 0 ? (
          <span style={{ color: "var(--muted2)", fontStyle: "italic" }}>
            Waiting for job start…
          </span>
        ) : (
          logs.map((l, i) => {
            const col = {
              error:   "#f87171",
              warn:    "#fbbf24",
              success: "#34d399",
              info:    "#a0b4cc",
            }[l.type] ?? "#a0b4cc";
            const stageColor = {
              STAC:    "#38bdf8",
              TILE:    "#fbbf24",
              TILES:   "#fbbf24",
              MOSAIC:  "#a78bfa",
              INDICES: "#34d399",
              RAQI:    "#f87171",
              CLUSTER: "#fb923c",
              WRITE:   "#22d3ee",
              HIST:    "#67e8f9",
              DATE:    "#94a3b8",
              CLOUD:   "#facc15",
              MASK:    "#c084fc",
              PRINT:   "#6b7280",    // grey — raw print() from child process
              ERR:     "#f87171",    // red  — stderr from child process
              CANCEL:  "#f87171",
              TRACEBACK: "#f87171",
            }[l.stage] ?? "var(--border2)";

            return (
              <div key={i} style={{
                display: "flex", gap: 8, lineHeight: 1.55,
                animation: i >= logs.length - 3 ? `log-line-in 0.18s ${Math.max(0, i - (logs.length - 3)) * 0.04}s ease both` : "none",
              }}>
                <span style={{ color: "var(--muted2)", flexShrink: 0, userSelect: "none" }}>
                  {l.time}
                </span>
                {l.stage && (
                  <span style={{
                    color: stageColor,
                    flexShrink: 0,
                    userSelect: "none",
                    border: `1px solid ${stageColor}`,
                    borderRadius: 4,
                    padding: "0 4px",
                    fontSize: 8,
                    letterSpacing: 0.5,
                    lineHeight: "16px",
                    height: 16,
                  }}>
                    {l.stage}
                  </span>
                )}
                <span style={{ color: "var(--muted)", flexShrink: 0, userSelect: "none" }}>›</span>
                <span style={{ color: col, wordBreak: "break-word" }}>{l.msg}</span>
              </div>
            );
          })
        )}
        {active && logs.length > 0 && (
          <span style={{ color: "var(--warn)", animation: "blink 1s infinite" }}>▊</span>
        )}
        <div ref={bottomRef} />
      </div>

      {/* "Jump to bottom" button when scrolled away */}
      {!autoScroll && (
        <button
          onClick={() => { setAutoScroll(true); if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight; }}
          style={{
            position: "absolute", bottom: 8, right: 8,
            padding: "3px 8px", borderRadius: 4, cursor: "pointer",
            background: "var(--panel)", border: "1px solid var(--border2)",
            fontFamily: "var(--mono)", fontSize: 9, color: "var(--accent)",
          }}
        >
          ↓ latest
        </button>
      )}
    </div>
  );
}

// ── Main ProcessingPanel ──────────────────────────────────────────────────
export default function ProcessingPanel({ steps, liveStep, logs, status, dateProgress, onCancel, cancelling }) {
  const active     = status === "running";
  const doneCount  = Object.values(steps).filter(s => s === "done").length;
  const totalSteps = PIPELINE_STEPS.length;
  const pct        = totalSteps > 0 ? (doneCount / totalSteps) * 100 : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

      {/* ── Pipeline step tracker ── */}
      <div style={{
        background: "var(--panel)", border: "1px solid var(--border)",
        borderRadius: 12, padding: "12px 13px",
      }}>
        {/* Header — radar orb + counter */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          {/* Radar animation orb */}
          <div style={{ position: "relative", width: 22, height: 22, flexShrink: 0 }}>
            {/* Outer ring */}
            <div style={{
              position: "absolute", inset: 0, borderRadius: "50%",
              border: `1.5px solid ${active ? "rgba(251,191,36,0.4)" : "rgba(0,240,168,0.3)"}`,
              transition: "border-color 0.4s",
            }} />
            {/* Sweep line */}
            {active && (
              <div style={{
                position: "absolute", top: "50%", left: "50%",
                width: "50%", height: 1.5,
                background: "linear-gradient(90deg, transparent, var(--warn))",
                transformOrigin: "0 50%",
                marginTop: -0.75,
                animation: "radar-sweep 1.8s linear infinite",
                borderRadius: 1,
              }} />
            )}
            {/* Center dot */}
            <div style={{
              position: "absolute", top: "50%", left: "50%",
              width: 5, height: 5, borderRadius: "50%",
              background: active ? "var(--warn)" : "var(--accent)",
              transform: "translate(-50%,-50%)",
              boxShadow: active ? "0 0 6px var(--warn)" : "0 0 5px var(--accent)",
              transition: "background 0.4s",
            }} />
            {/* Ping ring when active */}
            {active && (
              <div style={{
                position: "absolute", inset: 2, borderRadius: "50%",
                border: "1px solid rgba(251,191,36,0.5)",
                animation: "radar-ping 1.8s ease-out infinite",
              }} />
            )}
          </div>

          <span style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 11, color: "var(--text2)", letterSpacing: 1, textTransform: "uppercase" }}>
            Pipeline
          </span>

          {/* Animated counter */}
          <div key={doneCount} style={{
            marginLeft: "auto",
            fontFamily: "var(--mono)", fontSize: 9,
            color: doneCount === totalSteps ? "var(--accent)" : active ? "var(--warn)" : "var(--muted)",
            animation: doneCount > 0 ? "digit-flip 0.25s ease" : "none",
            transition: "color 0.4s",
            overflow: "hidden",
          }}>
            {doneCount}/{totalSteps}
          </div>
        </div>

        {/* Multi-date progress badge */}
        {dateProgress && dateProgress.total > 1 && (
          <div key={dateProgress?.current} style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "5px 9px", borderRadius: 6, marginBottom: 8,
            background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.2)",
            animation: "warn-flash 0.6s ease",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--warn)", boxShadow: "0 0 5px var(--warn)", flexShrink: 0 }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--warn)" }}>
                DATE {dateProgress.current}/{dateProgress.total}
              </span>
            </div>
            {/* Mini date progress pips */}
            <div style={{ display: "flex", gap: 3 }}>
              {Array.from({ length: dateProgress.total }, (_, i) => (
                <div key={i} style={{
                  width: 14, height: 5, borderRadius: 3,
                  background: i < dateProgress.current ? "var(--accent)" : i === dateProgress.current - 1 ? "var(--warn)" : "var(--border)",
                  transition: "background 0.4s",
                }} />
              ))}
            </div>
          </div>
        )}

        {/* Overall progress bar */}
        <div style={{ height: 3, background: "var(--border)", borderRadius: 2, marginBottom: 10, overflow: "hidden" }}>
          <div style={{
            height: "100%", borderRadius: 2,
            background: active
              ? "linear-gradient(90deg, var(--warn), #fb923c)"
              : "linear-gradient(90deg, var(--accent), var(--accent2))",
            width: `${pct}%`,
            transition: "width 0.7s ease",
            boxShadow: active ? "0 0 8px rgba(251,191,36,0.5)" : "0 0 8px rgba(0,240,168,0.4)",
            animation: pct === 100 ? "bar-wipe 0.6s ease" : "none",
          }} />
        </div>

        {/* Steps list */}
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {PIPELINE_STEPS.map((step, i) => (
            <StepRow
              key={`${step.id}-${dateProgress?.current ?? 0}`}
              step={step}
              state={steps[step.id] ?? "pending"}
              index={i}
              isLive={liveStep === step.id}
            />
          ))}
        </div>
      </div>

      {/* ── Live terminal log ── */}
      <div style={{
        background: "var(--panel)", border: "1px solid var(--border)",
        borderRadius: 12, padding: "12px 13px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <div style={{ width: 3, height: 13, borderRadius: 2, background: "linear-gradient(180deg, var(--warn), var(--danger))" }} />
          <span style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 11, color: "var(--text2)", letterSpacing: 1, textTransform: "uppercase" }}>
            Live Output
          </span>
          {/* Cancel button — inline with header, only when running */}
          {active && onCancel && (
            <button
              onClick={onCancel}
              disabled={cancelling}
              style={{
                marginLeft: "auto",
                display: "flex", alignItems: "center", gap: 5,
                padding: "4px 10px", borderRadius: 6, cursor: cancelling ? "wait" : "pointer",
                border: "1px solid rgba(248,113,113,0.5)",
                background: cancelling ? "rgba(248,113,113,0.08)" : "transparent",
                color: cancelling ? "rgba(248,113,113,0.5)" : "#f87171",
                fontFamily: "var(--mono)", fontSize: 10,
                transition: "all 0.2s",
              }}
            >
              {cancelling ? (
                <>
                  <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⏳</span>
                  Cancelling…
                </>
              ) : (
                <>
                  <span style={{ fontSize: 9, fontWeight: 700 }}>✕</span>
                  Cancel Process
                </>
              )}
            </button>
          )}
        </div>
        <LogTerminal logs={logs} active={active} />
      </div>

    </div>
  );
}
