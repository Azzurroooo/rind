# File Tools: Read Consecutively, Mutate Serially

English | [简体中文](file-tools.zh-CN.md)

Reading must state "exactly how far was read"; mutation must guarantee "which file contents this replacement is based on". These two concerns are carried by the paging contract and the per-path write queue, respectively.

~~~mermaid
flowchart LR
    READ["read_file(path, offset, limit)"] --> PAGE["consecutive complete lines + next_offset"]
    EDIT["edit_file / write_file"] --> RESOLVE["resolve the absolute path"]
    RESOLVE --> LOCK["FileMutationQueue: queue by path"]
    LOCK --> CHECK["read and verify the current contents"]
    CHECK --> STAGE["temporary file in the same directory"]
    STAGE --> VERIFY["confirm no external modification since the read"]
    VERIFY --> REPLACE["os.replace"]
~~~

read_file reads from line 1 by default, and the raw read result also has a 50 KiB limit; the model projection is further bounded to 25 KiB. When even a single line will not fit, it returns LineTooLong rather than producing a fake cursor that skips half a line. glob and grep return bounded matches; grep prefers rg, with a local implementation path as an alternative.

edit_file requires old_str to appear exactly once in the current file, and even overlapping matches must not be ambiguous; write_file is a whole-file replacement. Both preserve the original permissions, stage in a temporary file, and check before replacement. The Worker shares FileMutationQueue, so modifications to the same path from different sessions and Team subtasks are serialized; different paths may proceed independently.

The queue only coordinates writes that go through the file tools inside this Worker. Editors, other Workers, Shell, and hard-link aliases are not uniformly controlled by it, and neither is the check-before-replace step an atomic file-system compare-and-swap. Cancelling a waiter writes nothing, and the lock cannot be released until the file thread that has already started finishes.

Code entry points: [file definitions and paths](../../../agent/infrastructure/tools/files/specs.py), [read tools](../../../agent/infrastructure/tools/files/queries.py), [mutations](../../../agent/infrastructure/tools/files/mutations.py), [write queue](../../../agent/infrastructure/tools/files/mutation_queue.py). Verification: [mutation regression](../../../test/test_file_mutation_tools.py), [queue regression](../../../test/test_file_mutation_queue.py).

[Back to the series map](../README.md)
