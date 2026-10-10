# README media

The README leads with a 15-second CLI task recording, then shows the existing
native Agents Management capture and a Desktop / Web / App triptych.

The CLI simulation displays `GPT-6-Astra` via `cliInfo`; the separate client
collage retains its original model fixtures. This is a presentation label, not
a real-provider run or a claim about model availability.

The recording is framed as a terminal window: a `rind` tab, new-tab control,
and window buttons. There are no promotional headers or demo labels inside
the video; the README caption and capture metadata still identify it as a
simulation. Window width follows the actual terminal cell size with equal
side padding, rather than adding unused space on one side.

All conversations are fictional. CLI frames use the current output controller,
question menu, composer and xterm cells—not a hand-written terminal imitation.
The Desktop capture uses the website's built real-renderer preview. Web and App
mount their actual entry points with local ticket / WebSocket fixture responses,
including protocol tool events. No model, Worker, credentials or user workspace
is connected. The App image captures the mobile renderer in Chromium; it is not
an Android/iOS native-capability acceptance test.

The collage retains each client's native styling. Its paper background, neutral
image outlines, quiet window frames and restrained labels follow the website's
visual language. No client UI is drawn or altered for the collage.

## Reproduce

Install the existing dependencies in `frontend-cli`, `frontend-web`, `mobile`
and the neighboring `rind-web` project. Build the website's Desktop demo if
`rind-web/public/demos/desktop` is unavailable. Supply an installed FFmpeg binary;
FFmpeg is a development-only media tool, not an application dependency.

```powershell
node design/readme-media/capture-cli.mjs --browser-package=../rind-web/package.json --ffmpeg=/path/to/ffmpeg.exe
node design/readme-media/capture-clients.mjs --website=../rind-web
node --test design/readme-media/fixtures.test.mjs
node design/readme-media/verify.mjs --browser-package=../rind-web/package.json
```

Outputs are `assets/rind-cli-demo.mp4`, `assets/rind-cli-demo.gif` and
`assets/rind-clients.png`. Source revisions and representative CLI text frames
are recorded alongside these scripts. Disposable frames and component captures
live only under the ignored `.docs/readme-*` directories; remove those exact
owned directories after inspecting the results.

The MP4 is H.264/yuv420p with fast-start metadata. The GIF is the same 15-second
sequence, downscaled and palette-compressed for inline README compatibility.
The README links to the local MP4 rather than relying on an unsupported local
HTML video embed or creating an external GitHub attachment during local work.

## Sequence

| Time | Native CLI state |
| --- | --- |
| 0–1.8 s | Type the task |
| 2.1–3.3 s | Read the tokenizer |
| 3.5–6.9 s | Ask about scope; user moves to the second answer and confirms |
| 7.2–9.1 s | Edit the tests; show the diff |
| 9.5–11.3 s | Run `npm test`; show its output |
| 11.5–15 s | Stream the result; hold the finished response |

The fixture regression executes the small tokenizer assertions locally and
checks the Web reducer's tool preview contract. These checks do not constitute
a real-model task completion. No manual/live-provider acceptance is run.
