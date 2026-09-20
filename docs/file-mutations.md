# File mutations

The model calls `edit_file(file_path, old_str, new_str)` for one targeted replacement or `write_file(file_path, content)` for a new file or complete rewrite. Neither requires a hash. `read_file` returns paginated text without scanning the whole file for a digest.

Each edit reads the current file and requires exactly one occurrence of `old_str`, including overlapping occurrences. Missing or ambiguous text is rejected without changing the file. A write replaces the entire file, including any earlier edits.

The existing tool processor executes ordinary batch calls in order. A worker-owned `FileMutationQueue`, injected through the composition root, also serializes edits and writes across active sessions and Team children. Its key is the resolved absolute path, normalized for the platform. Calls targeting other files can proceed independently; ordinary batch scheduling remains serial.

The queue owns the complete read/validate/stage/replace operation. Cancelled waiters do not write. Once a filesystem thread starts, cancellation waits for it to settle before releasing ownership; an already completed write is not rolled back. Exceptions release the queue, and unused queue entries are removed.

Writes retain same-directory temporary staging, permission preservation, and atomic replacement. Immediately before replacement, the tool checks that the file still matches what this operation read. This detects observed external changes but is not an atomic filesystem compare-and-swap: another process can still race between the check and replacement. The queue does not coordinate other workers, editors, shell commands, or hard-link aliases.

Existing session files are not migrated. Their historical hashes remain readable, and the registry's existing argument filtering discards obsolete hash arguments on execution. Previously recorded successful tool calls are reused during recovery rather than executed again. Old persisted prompts can still mention hashes; current tool descriptions explicitly state the new contract.

Automatic coverage lives in `test/test_file_mutation_tools.py` and `test/test_file_mutation_queue.py`: ordered mixed batches, dependent edits, aliases, cancellation, errors, external modifications, Team sharing, and persisted-call recovery. Real-model acceptance remains opt-in under `test/manual/`.
