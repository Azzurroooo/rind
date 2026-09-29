import { Goal } from "lucide-react";
import { GoalPanel } from "../GoalPanel.jsx";
import { BackgroundList } from "./BackgroundList.jsx";
import { PlanSection } from "./PlanSection.jsx";
import { RunningTasks } from "./RunningTasks.jsx";

// The Activity tab: plan, yielded background tasks and the session goal in
// one scrollable column (after LobeHub's WorkingSidebar overview sections).
// It replaces the former Tasks and Goal tabs and the composer plan deck.
export function ActivityTab({
  plan,
  sessionId,
  request,
  taskService,
  background,
  waitingCount,
  goal,
  goalDisabled,
  onGoalAction,
}) {
  return (
    <div className="inspector-body activity-tab">
      <PlanSection plan={plan} />
      {taskService ? (
        <RunningTasks sessionId={sessionId} request={request} waitingCount={waitingCount} />
      ) : background ? (
        <BackgroundList sessionId={sessionId} request={request} />
      ) : null}
      <section className="inspector-section goal-section" aria-label="Goal">
        <div className="inspector-section-head">
          <h3 className="inspector-section-title"><Goal size={14} aria-hidden="true" /> Goal</h3>
        </div>
        <GoalPanel key={sessionId} goal={goal} onAction={onGoalAction} disabled={goalDisabled} bare />
      </section>
    </div>
  );
}
