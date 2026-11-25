import { FONT_SCALE_STEPS, type FontScale } from "../../hooks/useFontScale";
import { Check, Minus, Plus, RotateCcw, Sparkles, Type } from "lucide-react";
import "./TextSizePage.css";

type Props = {
  fontScale: FontScale;
  onFontScaleChange: (scale: FontScale) => void;
  onReturn?: () => void;
};

const PRESETS: { scale: FontScale; label: string; desc: string }[] = [
  { scale: 0.9, label: "Compact", desc: "90%" },
  { scale: 1, label: "Default", desc: "100%" },
  { scale: 1.1, label: "Medium", desc: "110%" },
  { scale: 1.2, label: "Comfortable", desc: "120%" },
  { scale: 1.3, label: "Large", desc: "130%" },
  { scale: 1.4, label: "Extra Large", desc: "140%" },
  { scale: 1.5, label: "Maximum", desc: "150%" },
];

export function TextSizePage({ fontScale, onFontScaleChange }: Props) {
  const scaleIndex = FONT_SCALE_STEPS.indexOf(fontScale);
  const currentPercent = Math.round(fontScale * 100);

  const handleDecrease = () => {
    if (scaleIndex > 0) {
      onFontScaleChange(FONT_SCALE_STEPS[scaleIndex - 1]);
    }
  };

  const handleIncrease = () => {
    if (scaleIndex < FONT_SCALE_STEPS.length - 1) {
      onFontScaleChange(FONT_SCALE_STEPS[scaleIndex + 1]);
    }
  };

  const handleReset = () => {
    onFontScaleChange(1);
  };

  return (
    <div className="text-size-page" data-testid="text-size-page">
      {/* 1. Header Banner */}
      <section className="text-size-hero" aria-label="Text Size Overview">
        <div className="text-size-hero-top">
          <h1 className="text-size-hero-title">
            <Type size={24} className="text-size-hero-icon" aria-hidden="true" />
            Text Size
          </h1>
          <span className="text-size-badge">
            <Sparkles size={13} aria-hidden="true" />
            Display Preference
          </span>
        </div>
        <p className="text-size-hero-subtitle">
          Adjust the reading scale for messages, documents, and navigation across your workspace.
        </p>
      </section>

      {/* 2. Main Controls Card */}
      <section className="text-size-card" aria-label="Text Size Controls">
        <div className="text-size-card-header">
          <div>
            <h2 className="text-size-card-title">Font Scaling</h2>
            <p className="text-size-card-desc">Choose a comfortable reading preset or fine-tune using the stepper.</p>
          </div>
          <div className="text-size-current-pill" aria-live="polite">
            <span className="text-size-current-val">{currentPercent}%</span>
            <span className="text-size-current-label">Current Scale</span>
          </div>
        </div>

        {/* Preset Selection Buttons */}
        <div className="text-size-presets-grid" role="radiogroup" aria-label="Text size presets">
          {PRESETS.map((preset) => {
            const isSelected = Math.abs(preset.scale - fontScale) < 0.001;
            return (
              <button
                key={preset.scale}
                type="button"
                role="radio"
                aria-checked={isSelected}
                className={`text-size-preset-btn${isSelected ? " is-active" : ""}`}
                onClick={() => onFontScaleChange(preset.scale)}
              >
                <div className="text-size-preset-top">
                  <span className="text-size-preset-label">{preset.label}</span>
                  {isSelected && <Check size={14} className="text-size-preset-check" aria-hidden="true" />}
                </div>
                <span className="text-size-preset-pct">{preset.desc}</span>
              </button>
            );
          })}
        </div>

        {/* Stepper Fine-tuning */}
        <div className="text-size-stepper-wrap">
          <div className="text-size-stepper-group">
            <button
              type="button"
              className="text-size-step-btn"
              onClick={handleDecrease}
              disabled={scaleIndex === 0}
              aria-label="Decrease text size"
              title="Decrease text size"
            >
              <Minus size={16} aria-hidden="true" />
              <span>A−</span>
            </button>

            <div className="text-size-stepper-display">
              <span className="text-size-stepper-num">{currentPercent}%</span>
            </div>

            <button
              type="button"
              className="text-size-step-btn"
              onClick={handleIncrease}
              disabled={scaleIndex === FONT_SCALE_STEPS.length - 1}
              aria-label="Increase text size"
              title="Increase text size"
            >
              <Plus size={16} aria-hidden="true" />
              <span>A+</span>
            </button>
          </div>

          <button
            type="button"
            className="text-size-reset-btn"
            onClick={handleReset}
            disabled={fontScale === 1}
            title="Reset text size to default (100%)"
          >
            <RotateCcw size={14} aria-hidden="true" />
            <span>Reset to default</span>
          </button>
        </div>
      </section>

      {/* 3. Live Interactive Reading Preview */}
      <section className="text-size-preview-card" aria-label="Reading Preview">
        <div className="text-size-preview-header">
          <h2 className="text-size-preview-title">Live Preview</h2>
          <span className="text-size-preview-tag">Instant feedback</span>
        </div>

        <div className="text-size-preview-content">
          <div className="text-size-preview-bubble text-size-preview-user">
            <span className="text-size-preview-bubble-label">You</span>
            <p className="text-size-preview-text">
              What is the current status and quarterly budget for Project Phoenix?
            </p>
          </div>

          <div className="text-size-preview-bubble text-size-preview-assistant">
            <span className="text-size-preview-bubble-label">Nanvi Assistant</span>
            <p className="text-size-preview-text">
              <strong>Project Phoenix</strong> is actively on track for <strong>Q3 2026</strong> deliverables.
              All cloud infrastructure milestones have been met, and the allocated departmental budget is currently at <strong>84% utilization</strong>.
            </p>
            <div className="text-size-preview-meta">
              <span className="text-size-preview-chip">Architecture Review</span>
              <span className="text-size-preview-chip">Budget: $420,000</span>
              <span className="text-size-preview-chip">Status: Normal</span>
            </div>
          </div>
        </div>
      </section>

      {/* 4. Footer Status Note */}
      <div className="text-size-footer-note">
        <span className="text-size-status-dot" aria-hidden="true" />
        <span>Your text size choice is saved automatically and applies across your entire workspace.</span>
      </div>
    </div>
  );
}

