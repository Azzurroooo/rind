import { Goal, ListTodo } from "lucide-react";
import { GoalPanel } from "../GoalPanel.jsx";
import { PlanSection, planSteps } from "./PlanSection.jsx";
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
  enabled,
}) {
  const hasContent = Boolean(planSteps(plan).length || goal?.objective);
  const watchTasks = taskService || background;
  const renderEmpty = hasContent ? undefined : ({ loading = false } = {}) => <ActivityEmpty hasSession={Boolean(sessionId)} loading={loading} />;
  return (
    <div className="inspector-body activity-tab">
      <PlanSection plan={plan} />
      {watchTasks ? <RunningTasks key={sessionId} sessionId={sessionId} request={request} waitingCount={waitingCount} enabled={enabled} legacy={!taskService} renderEmpty={renderEmpty} /> : renderEmpty?.()}
      {goal?.objective && <section className="inspector-section goal-section" aria-label="Goal">
        <div className="inspector-section-head">
          <h3 className="inspector-section-title"><Goal size={14} aria-hidden="true" /> Goal</h3>
        </div>
        <GoalPanel key={sessionId} goal={goal} onAction={onGoalAction} disabled={goalDisabled} />
      </section>}
    </div>
  );
}

function ActivityEmpty({ hasSession, loading }) {
  return <div className="activity-empty">
    <ListTodo className="activity-empty-icon" size={28} aria-hidden="true" />
    <h3>{loading ? "Loading activity" : hasSession ? "No active work" : "No activity yet"}</h3>
    <p>{loading ? "Checking this session for running tasks." : hasSession
      ? "Plans and running tasks appear here. Completed output stays in the conversation."
      : "Start a conversation to see its plan and running tasks here."}</p>
    <p className="activity-empty-hint">Set a goal with <code>/goal &lt;objective&gt;</code></p>
  </div>;
}
