import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * InfoTooltip
 * ─────────────
 * Renders the popover in a React portal (document.body) so it is NEVER
 * clipped by parent overflow:hidden containers (e.g. index cards).
 *
 * Props:
 *   title    – bold heading
 *   body     – text or JSX content
 *   legend   – optional array of { color, label, desc }
 *   width    – popover width in px (default 280)
 *   position – "right"|"left"|"top"|"bottom" (default "right")
 */
export default function InfoTooltip({ title, body, legend, width = 280, position = "right" }) {
  const [open,  setOpen]  = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const btnRef = useRef(null);

  // Recompute popover position whenever it opens
  const updatePos = () => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const GAP = 10;
    let top, left;
    if (position === "right") {
      top  = r.top + window.scrollY - 8;
      left = r.right + window.scrollX + GAP;
    } else if (position === "left") {
      top  = r.top + window.scrollY - 8;
      left = r.left + window.scrollX - GAP - width;
    } else if (position === "top") {
      top  = r.top + window.scrollY - GAP - 10; // height unknown, shift up a fixed amount
      left = r.left + window.scrollX + r.width / 2 - width / 2;
    } else { // bottom
      top  = r.bottom + window.scrollY + GAP;
      left = r.left + window.scrollX + r.width / 2 - width / 2;
    }
    // Clamp horizontally so it never goes off-screen
    const maxLeft = window.innerWidth - width - 8;
    left = Math.max(8, Math.min(left, maxLeft));
    // Clamp vertically
    top = Math.max(8, top);
    setCoords({ top, left });
  };

  const handleOpen = () => {
    updatePos();
    setOpen(o => !o);
  };

  // Close on outside click / scroll
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener("mousedown", close);
    window.addEventListener("scroll",      close, true);
    window.addEventListener("resize",      close);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("scroll",      close, true);
      window.removeEventListener("resize",      close);
    };
  }, [open]);

  const popover = open && createPortal(
    <div
      onMouseDown={e => e.stopPropagation()}   // don't let click bubble to close handler
      style={{
        position: "fixed",
        top:      coords.top,
        left:     coords.left,
        width,
        zIndex:   99999,
        background: "var(--surface)",
        border: "1px solid var(--border2)",
        borderRadius: 10,
        padding: "13px 14px",
        boxShadow: "0 12px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,240,168,0.07)",
        animation: "fadeUp 0.16s ease",
        pointerEvents: "auto",
      }}
    >
      {/* Title row */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 8,
      }}>
        <span style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 12, color: "var(--accent2)" }}>
          {title}
        </span>
        <button
          onClick={() => setOpen(false)}
          style={{
            background: "none", border: "none", color: "var(--muted)",
            cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px",
          }}
        >×</button>
      </div>

      {/* Body */}
      {body && (
        <div style={{
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--text2)",
          lineHeight: 1.65, marginBottom: legend ? 10 : 0,
        }}>
          {body}
        </div>
      )}

      {/* Legend */}
      {legend && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: body ? 10 : 0 }}>
          <div style={{
            fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)",
            letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 2,
          }}>
            Colour Legend
          </div>
          {legend.map((l, i) => (
            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <div style={{
                width: 10, height: 10, borderRadius: 2,
                background: l.color, flexShrink: 0, marginTop: 1,
                boxShadow: `0 0 5px ${l.color}66`,
              }} />
              <div>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: l.color, fontWeight: 700 }}>
                  {l.label}
                </span>
                {l.desc && (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", marginLeft: 5 }}>
                    — {l.desc}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>,
    document.body
  );

  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        ref={btnRef}
        onClick={handleOpen}
        title={title}
        style={{
          width: 16, height: 16, borderRadius: "50%",
          border: "1px solid " + (open ? "var(--accent2)" : "var(--border2)"),
          background: open ? "rgba(14,165,233,0.18)" : "transparent",
          color: open ? "var(--accent2)" : "var(--muted)",
          fontFamily: "var(--mono)", fontSize: 9, fontWeight: 700,
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", transition: "all 0.15s", flexShrink: 0,
          lineHeight: 1,
        }}
      >
        i
      </button>
      {popover}
    </span>
  );
}
