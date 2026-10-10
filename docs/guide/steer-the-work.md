# Steer the work back on track

English | [简体中文](steer-the-work.zh-CN.md)

Goal: do not lose control during a turn - know when you can interject, when you should queue, and when you should interrupt.

The core fact: **a running turn never locks the input box**. You can type at any time; the only difference is when your input takes effect.

## When inputs take effect

| What you want | Action | When it takes effect |
| --- | --- | --- |
| Adjust the current task | Type and press Enter | Sent as steering before the next model sample; does not cancel a running command |
| Append the next piece of work | Type, then press **Tab** | After the current turn ends; automatically begins as a new user message |
| Recall pending input | **Alt+↑** (follow-up), **Alt+↓** (steering) | Brings the queued text back into the editor |
| Promote a queued item to an interjection | **Alt+→** | Converts a pending follow-up into steering, moved up to before the next sample |
| Stop the current turn | **Ctrl+C** | Interrupts the model stream, running tools, and subsequent steps; pending input returns to the editor. Press once more for a hard stop |

Steering is not preemption: commands already sent will run to completion, and your words are seen **before the next tool step**. So use Ctrl+C to "make it stop" and Enter to "make it change direction" - do not mix the two.

## Looking at the details

| Action | Effect |
| --- | --- |
| **Ctrl+O** | Expand/collapse all tool output (by default only a one-line summary and status) |
| **Ctrl+T** | Cycle the reasoning effort (low → medium → high → xhigh → max) |
| **↑ / ↓** | Page through the prompts you have sent |
| **Esc** | Close the current menu or monitor; the slash menu first, when one is open |
| **?** | Print the command list |

Shift+Enter or Ctrl+Enter inserts a newline, for writing multi-line prompts.

## Which one to use when

- The model is drifting further and further off, but the direction is still right: send a line with Enter as steering; it saves tokens compared to interrupting and starting over.
- What you want to do next is unrelated to the current task: queue it with Tab, and it automatically becomes the next turn after the current turn ends.
- A command is stuck or the model is way off: Ctrl+C. If the turn ended but the task did not, describe the remaining part and send it once more.

Related scenarios: [Let unfinished commands keep going](background.md), [Come back and keep working](resume.md).

[Back to the scenario index](README.md)
