import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AssistantMessage, UserMessage, SystemNote } from "./MessageItem.jsx";
import { messageTime } from "../../lib/format.js";
import { emptyConversationState, reduceConversation } from "../../state/conversationReducer.js";

afterEach(cleanup);
const ts = "2026-09-29T06:34:10Z";
it("user, assistant and system actions expose semantic time with a full-date tooltip", () => {
  const { container } = render(<><UserMessage message={{ content: "Question", time: ts }} /><AssistantMessage message={{ content: "Answer", time: ts }} /><SystemNote message={{ content: "Notice", time: ts }} /></>);
  const times = container.querySelectorAll(".message-actions time");
  expect(times).toHaveLength(3);
  for (const time of times) {
    expect(time.dateTime).toBe("2026-09-29T06:34:10.000Z");
    expect(time.title).toContain("2026");
  }
});
it("normalizes seconds and milliseconds; does not invent a date for missing or invalid times", () => {
  expect(messageTime(Date.parse(ts))).toEqual(messageTime(Date.parse(ts) / 1000));
  for (const value of [undefined, "", "invalid", Infinity]) expect(messageTime(value)).toBeNull();
  const { container } = render(<UserMessage message={{ content: "Old" }} />);
  expect(container.querySelector("time")).toBeNull();
  expect(container.textContent).toContain("Time unavailable");
});
it("uses persisted and remote event timestamps, including delivered queue inputs", () => {
  let state = reduceConversation(emptyConversationState(), { kind: "history", messages: [{ id: "u", role: "user", content: "Past", ts }, { id: "old", role: "assistant", content: "No timestamp" }] });
  expect(state.entries[0].time).toBe(ts);
  expect(state.entries[1].time).toBeUndefined();
  const send = (type, data = {}) => { state = reduceConversation(state, { kind: "event", turn_id: "t", event: { type, ts, ...data } }); };
  send("turn_started", { input: "Remote", client_input_id: "remote" });
  send("assistant_delta", { text: "Answer" });
  send("assistant_message_completed", { content: "Answer" });
  send("queued_input_delivered", { input_id: "queued", input: "Follow up" });
  expect(state.entries.slice(2).map((entry) => entry.time)).toEqual([ts, ts, ts]);
});
