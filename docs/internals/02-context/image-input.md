# Images are session snapshots, not temporary paths

English | [简体中文](image-input.zh-CN.md)

Both user uploads and images read out by read_file pass through the session snapshot boundary. What the model adapter receives is the processed bytes; it never reopens the original workspace image at a later point.

~~~mermaid
flowchart LR
    SRC["Local images / uploads references / read_file"] --> PROC["Decode - orientation fix - scale"]
    PROC --> SNAP[("Session attachments snapshot")]
    SNAP --> REF["Attachment references in messages"]
    REF --> LOAD["Read the snapshot before the request"]
    LOAD --> ADAPTER["Provider image block"]
~~~

PNG, JPEG, WebP, GIF, and BMP are supported; animated images use the first frame. Source files are at most 20 MiB and 40 million pixels; after processing, the longest edge is 2,000 pixels and the output does not exceed 3 MiB. One model request allows at most 8 images and at most 16 MiB in total after encoding. Models that explicitly do not support images are not sent any and get a notice; when the capability is unknown, the system gives a notice and then tries, and an unknown capability must never be recorded as support.

Attachments are persisted along with messages and tool results, and a fork copies the relevant snapshots. After compaction, old images are not automatically attached to model requests again; the handoff saves references for later inspection with read_file. Image I/O runs on a thread, and cancellation must wait for started Pillow operations to finish; trace masks the image bytes.

Code entry points: [image processing](../../../agent/infrastructure/images.py), [request preparation](../../../agent/application/images.py), [attachment storage](../../../agent/infrastructure/persistence/image_attachments.py). Verification: [image attachments](../../../test/test_image_attachments.py), [request serialization](../../../test/test_image_requests.py).

[Back to the series map](../README.md)
