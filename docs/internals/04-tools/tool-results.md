# Tool Results: One Fact, Different Reading Budgets

English | [简体中文](tool-results.zh-CN.md)

The model needs enough evidence for its next step; the terminal needs a scannable result; and large output also needs a file that can be consulted further. Rind generates different projections at the result boundary, so that the three do not drag on each other.

~~~mermaid
flowchart TB
    RAW["tool structured result"] --> N["ToolResultNormalizer"]
    N --> UI["terminal_content<br/>display budget"]
    N --> MODEL["model_content<br/>model budget"]
    N --> DISK[("write tool-output when needed<br/>return a file reference")]
    MODEL --> HISTORY[("save the model projection")]
    HISTORY --> NEXT["next model context"]
~~~

The unified payload uses ok, tool, data or error, and may carry error_type, meta, and attachments. The Normalizer defaults to a terminal budget of 8 KiB and a model preview of 25 KiB / 2,000 lines; limits are measured on the final UTF-8 JSON. Attachment references are preserved separately, so that an image is never lost to body truncation.

| Result type | Special rules |
| --- | --- |
| read_file | Only consecutive complete lines are kept, and next_offset points to the first line not displayed; head and tail must not be spliced together to pretend that the middle was read. |
| edit_file / write_file | The model gets locations and change statistics; the bounded diff stays in the tool record and on the display path, so that context is not consumed repeatedly. |
| Managed task | Status, task_id, output path, and paging notice are preserved together; after the preview is shortened, no misleading resume position is kept. |
| Generically oversized results | An output file may be written; the preview clearly marks the truncation and gives a path for continued reading. |

The saved model_content is the basis for replay; later changes to the display rules do not re-truncate old sessions. Complete output is not guaranteed indefinitely either: Shell has its own output quota and expiry cleanup, and when output is missing the reason must be reported.

Code entry points: [result normalization](../../../agent/application/tools/result_normalizer.py), [result contract](../../../agent/domain/tool_result.py), [output storage](../../../agent/infrastructure/persistence/tool_output_store.py). Verification: [normalization tests](../../../test/test_tool_result_normalizer.py), [file paging](../../../test/test_file_paging.py).

[Back to the series map](../README.md)
