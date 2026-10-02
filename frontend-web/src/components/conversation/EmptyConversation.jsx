import { ArrowUpRight } from "lucide-react";

export const STARTERS = Object.freeze(["Explore this project", "Review recent changes", "Plan the next task"]);

// Welcome state (spec section 4): the mark, a one-line prompt and starter chips
// that fill the composer (they never send on their own).
export function EmptyConversation({ onSuggestion }) {
  return (
    <div className="empty-conversation">
      <img src="/rind.svg" alt="" className="welcome-mark" />
      <h2>What would you like to work on?</h2>
      <p>A little clarity. A useful change. Your next idea.</p>
      <div className="starter-chips">
        {STARTERS.map((text) => (
          <button key={text} type="button" className="starter-chip" onClick={() => onSuggestion?.(text)}>
            {text}
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}
