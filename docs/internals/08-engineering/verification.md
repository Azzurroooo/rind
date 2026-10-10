# Verification design: each kind of evidence proves only the layer it covers

English | [简体中文](verification.zh-CN.md)

The test links in the series articles are traceable entry points into the implementation; they do not mean that every test was run during this documentation pass. Deterministic regression verifies protocols and mechanisms, real-model acceptance verifies user goals and model behavior, and the two kinds of results must be reported separately.

~~~mermaid
flowchart TD
    U["Unit tests<br/>boundaries / pure functions / state transitions"] --> I["Module integration<br/>storage / cancellation / tool pairing"]
    I --> P["Local fake provider process tests<br/>real protocol and processes, simulated model"]
    P --> S["Surface tests<br/>virtual terminal / DOM / Electron bridge"]
    S -.-> A["Standalone manual acceptance<br/>real model / real devices / explicit scenarios"]
    G["Protocol golden fixture"] --> P
    G --> S
~~~

## Mechanisms must land on assertions that can fail

| Design claim | Appropriate evidence |
| --- | --- |
| Multiple Surfaces understand the same event | Python protocol tests and Node golden fixtures read the same message samples |
| Cancellation can break a wait on a full queue | A fake stream fills the queue and then cancels, verifying task exit and resource cleanup |
| Persisted tool results are not executed twice | Construct an unclosed call together with an existing result; after recovery, check the execution count and the message pairing |
| CLI refreshes preserve input and the cursor | Virtual-terminal tests check the final screen, cursor position, width, and input buffer |
| A real model can continue a complex task from a summary | A user scenario that explicitly triggers compaction and checks the outcome; a simulated summary is not a substitute |

## Deterministic regression entry points

Run from the repository root after installing the corresponding development dependencies; choosing files according to the scope of the change is enough:

~~~sh
python -m pip install -r requirements.txt
python -m pytest test/ -q
npm --prefix frontend-cli ci
npm --prefix frontend-cli test
npm --prefix frontend-web test
npm --prefix desktop run typecheck
npm --prefix desktop test
npm --prefix mobile test
~~~

Python and CLI tests live in test/ and frontend-cli/test/; Web and Mobile use Vitest, and Desktop's scripts tests run under Node. A fake provider still belongs to deterministic regression even when it starts real subprocesses; the presence of an API key on the machine is no reason to switch to a real service.

## Manual acceptance and documentation maintenance

Plans under test/manual are executed only when the user explicitly asks for specific scenarios or for manual acceptance. Record PASS / FAIL / BLOCKED / NOT RUN, keep the triggering conditions and the evidence, and clean up your own processes and temporary data afterwards. Do not add device connections or real provider calls to default CI or startup checks.

The documentation's own checks cover whether all 52 topics are present, whether source/test/cross-links exist, whether Mermaid parses and renders, and whether numbers and defaults have a basis in the source. Later code changes should update the corresponding mechanism article rather than create another legacy overview describing the same flow.

Basis: [test classification](../../../test/README.md), [manual acceptance directory](../../../test/manual/README.md), [protocol samples](../../../test/fixtures/runtime_protocol.golden.jsonl), [Python protocol tests](../../../test/test_runtime_server_protocol.py), [CLI protocol tests](../../../frontend-cli/test/runtime-protocol.test.js), [virtual terminal integration](../../../frontend-cli/test/tui-integration.test.js).

[Back to the series map](../README.md)
