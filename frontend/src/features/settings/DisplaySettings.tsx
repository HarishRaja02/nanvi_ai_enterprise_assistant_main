import { FONT_SCALE_STEPS, type FontScale } from "../../hooks/useFontScale";

type Props = {
  fontScale: FontScale;
  onChange: (scale: FontScale) => void;
};

export function DisplaySettings({ fontScale, onChange }: Props) {
  const scaleIndex = FONT_SCALE_STEPS.indexOf(fontScale);

  return (
    <section className="display-settings" aria-labelledby="display-settings-title">
      <div>
        <h2 id="display-settings-title">Text size</h2>
        <p>Make text easier to read across Nanvi. Your choice is saved on this device.</p>
      </div>

      <div className="display-settings-control">
        <button
          type="button"
          className="account-secondary-action"
          onClick={() => onChange(FONT_SCALE_STEPS[Math.max(0, scaleIndex - 1)])}
          disabled={scaleIndex === 0}
          aria-label="Decrease text size"
        >
          A−
        </button>
        <output className="display-settings-value" aria-live="polite">
          {Math.round(fontScale * 100)}%
        </output>
        <button
          type="button"
          className="account-secondary-action"
          onClick={() => onChange(FONT_SCALE_STEPS[Math.min(FONT_SCALE_STEPS.length - 1, scaleIndex + 1)])}
          disabled={scaleIndex === FONT_SCALE_STEPS.length - 1}
          aria-label="Increase text size"
        >
          A+
        </button>
        <button
          type="button"
          className="account-secondary-action"
          onClick={() => onChange(1)}
          disabled={fontScale === 1}
        >
          Reset
        </button>
      </div>

      <div style={{ marginTop: "2.5rem", paddingTop: "1.5rem", borderTop: "1px solid var(--border, #334155)" }}>
        <h2 id="backend-connection-title" style={{ fontSize: "1.1rem", fontWeight: 600, margin: "0 0 0.5rem" }}>Enterprise Cloud Connection</h2>
        <p style={{ fontSize: "0.875rem", color: "var(--text-muted, #94a3b8)", margin: "0 0 1rem" }}>
          Nanvi AI Assistant connects to the enterprise cloud backend. Secrets, API keys, and environment variables are securely maintained on Vercel without storing credentials in the desktop installer.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", background: "var(--bg-sunken, rgba(255,255,255,0.03))", padding: "0.85rem 1.15rem", borderRadius: "0.75rem", border: "1px solid var(--border, #334155)" }}>
          <div style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#10b981", boxShadow: "0 0 8px #10b981" }} />
          <div style={{ flex: 1, fontSize: "0.875rem" }}>
            <span style={{ opacity: 0.8 }}>Active Cloud Server:</span>{" "}
            <code style={{ fontSize: "0.8rem", background: "rgba(255,255,255,0.08)", padding: "2px 6px", borderRadius: "4px" }}>https://nanviaienterpriseassistant.vercel.app/api</code>
          </div>
          <span style={{ fontSize: "0.75rem", color: "#10b981", fontWeight: 600, background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.25)", padding: "3px 8px", borderRadius: "9999px" }}>
            Vercel Live
          </span>
        </div>
      </div>
    </section>
  );
}
