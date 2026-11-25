import type { ReactNode } from "react";
import type { PromptDef } from "../../lib/prompts";

interface Props {
  starters?: PromptDef[];
  onPick?: (query: string) => void;
  disabled?: boolean;
  composer?: ReactNode;
}

export function EmptyStateBento({ composer }: Props) {
  return (
    <section className="empty-workspace-view" aria-labelledby="empty-chat-title">
      <div className="hero-header-section">
        <h2 id="empty-chat-title" className="hero-greeting">How can I help you today?</h2>
      </div>

      {composer}
    </section>
  );
}
