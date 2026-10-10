# 文件工具：连续地读，串行地改

English | [简体中文](file-tools.md)

读取要说明“究竟读到了哪里”；修改要保证“本次替换基于哪个文件内容”。这两件事分别由分页契约和逐路径写队列承担。

~~~mermaid
flowchart LR
    READ["read_file(path, offset, limit)"] --> PAGE["连续完整行 + next_offset"]
    EDIT["edit_file / write_file"] --> RESOLVE["解析绝对路径"]
    RESOLVE --> LOCK["FileMutationQueue：按路径排队"]
    LOCK --> CHECK["读取并校验当前内容"]
    CHECK --> STAGE["同目录临时文件"]
    STAGE --> VERIFY["确认读取后未被外部修改"]
    VERIFY --> REPLACE["os.replace"]
~~~

read_file 默认从第 1 行读取，原始读取结果还有 50 KiB 上限；模型投影进一步受 25 KiB 约束。一整行都放不下时返回 LineTooLong，不能生成一个跳过半行的伪游标。glob 和 grep 返回有界匹配；grep 优先使用 rg，另有本地实现路径。

edit_file 要求 old_str 在当前文件中恰好出现一次，包括重叠匹配也不能歧义；write_file 是整文件替换。两者都保留原权限、临时暂存、替换前检查。Worker 共享 FileMutationQueue，使不同会话和 Team 子任务对同一路径的修改串行；不同路径可以独立进行。

队列只协调这个 Worker 内走文件工具的写入。编辑器、其他 Worker、Shell 和硬链接别名不受它统一控制；替换前检查也不是文件系统原子 compare-and-swap。取消等待者不会写入，已启动的文件线程必须结束后才能释放锁。

代码入口：[文件定义与路径](../../../agent/infrastructure/tools/files/specs.py)、[读工具](../../../agent/infrastructure/tools/files/queries.py)、[修改](../../../agent/infrastructure/tools/files/mutations.py)、[写队列](../../../agent/infrastructure/tools/files/mutation_queue.py)。验证：[修改回归](../../../test/test_file_mutation_tools.py)、[队列回归](../../../test/test_file_mutation_queue.py)。

[返回系列地图](../README.zh-CN.md)
