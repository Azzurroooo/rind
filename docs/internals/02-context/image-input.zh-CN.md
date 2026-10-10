# 图片是会话快照，不是临时路径

English | [简体中文](image-input.md)

用户上传和 read_file 读出的图片都经过会话快照边界。模型适配器拿到的是经过处理的字节，不会在稍后重新打开工作区原图。

~~~mermaid
flowchart LR
    SRC["本地图片 / uploads 引用 / read_file"] --> PROC["解码 · 方向修正 · 缩放"]
    PROC --> SNAP[("会话 attachments 快照")]
    SNAP --> REF["消息中的附件引用"]
    REF --> LOAD["请求前读取快照"]
    LOAD --> ADAPTER["Provider 图片块"]
~~~

支持 PNG、JPEG、WebP、GIF、BMP；动画取首帧。源文件最多 20 MiB、4,000 万像素，处理后最长边 2,000 像素且输出不超过 3 MiB。一次模型请求最多 8 张、编码后总量最多 16 MiB。明确不支持图像的模型不发送图片并给出提示；能力未知时提示后尝试，不能把未知写成支持。

附件跟随消息和工具结果持久化；fork 会复制相关快照。压缩后旧图片不会自动再次附着到模型请求，handoff 保存引用供后续 read_file 查看。图片 I/O 在线程中进行，取消要等待已开始的 Pillow 操作收尾；trace 会遮盖图片字节。

代码入口：[图片处理](../../../agent/infrastructure/images.py)、[请求准备](../../../agent/application/images.py)、[附件存储](../../../agent/infrastructure/persistence/image_attachments.py)。验证：[图片附件](../../../test/test_image_attachments.py)、[请求序列化](../../../test/test_image_requests.py)。

[返回系列地图](../README.zh-CN.md)
