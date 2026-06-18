# `backend/tools/shelltool/shell_manager.py` 精读(C 档·极详)

## 这个文件在干嘛

**后台 shell 进程管理器**:支持启动子进程、持续抽取其 stdout/stderr 到缓冲、按 id 取/释放/终止/等待结束。
`toolimpl.py` 的 `bash` / `bash.output` / `bash.kill` 工具都建立在它之上,从而实现"前台跑 + 后台跑 + 增量读
输出"。模块底部导出一个全局单例 `shell_manager`。

---

## `ManagedShell`:被管理的单个 shell

> **整块作用**:用 slots dataclass 表示一个进程及其输出缓冲、读取任务;提供 output/returncode/status 便捷属性。

```python
from __future__ import annotations
import asyncio, contextlib, os, shutil, uuid
from dataclasses import dataclass, field


@dataclass(slots=True)
class ManagedShell:
    shell_id: str                          # 唯一 id(bash-xxxxxxxx)
    cmd: str                               # 命令
    cwd: str | None                        # 工作目录
    process: asyncio.subprocess.Process    # 子进程对象
    output_chunks: list[str] = field(default_factory=list)   # 输出分片(stdout+stderr 都进这)
    read_tasks: list[asyncio.Task[None]] = field(default_factory=list)  # 两个抽流任务

    @property
    def output(self) -> str:
        return "".join(self.output_chunks)
        #   拼接所有分片 = 完整输出。

    @property
    def returncode(self) -> int | None:
        return self.process.returncode
        #   退出码(None=还在跑)。

    @property
    def status(self) -> str:
        return "running" if self.returncode is None else "exited"
        #   运行中/已退出。
```

---

## `ShellManager`:管理器

> **整块作用**:维护 id→ManagedShell;启动进程并起两个抽流任务;提供 get/release/terminate/wait_closed/收尾/抽流。

```python
class ShellManager:
    SHELL = shutil.which("bash") or shutil.which("sh") if os.name != "nt" else None
    #   选用的 shell 可执行:非 Windows 优先 bash,退 sh;Windows 为 None(用默认)。

    def __init__(self) -> None:
        self._shells: dict[str, ManagedShell] = {}
        #   id → shell。

    async def start(self, *, cmd: str, cwd: str | None) -> ManagedShell:
        process = await asyncio.create_subprocess_shell(
            cmd, cwd=cwd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            executable=self.SHELL,
        )
        #   以 shell 方式启动子进程,管道捕获 stdout/stderr。
        shell = ManagedShell(shell_id=f"bash-{uuid.uuid4().hex[:8]}", cmd=cmd, cwd=cwd, process=process)
        #   建管理对象(随机 id)。
        shell.read_tasks.extend([
            asyncio.create_task(self._drain_stream(shell, process.stdout)),
            asyncio.create_task(self._drain_stream(shell, process.stderr)),
        ])
        #   起两个后台任务持续把 stdout/stderr 读进 output_chunks(不读会把管道堵满导致进程卡住)。
        self._shells[shell.shell_id] = shell
        return shell

    def get(self, shell_id: str) -> ManagedShell:
        try:
            return self._shells[shell_id]
        except KeyError as exc:
            raise KeyError(f"unknown shell id: {shell_id}") from exc
            #   未知 id → 报错。

    def release(self, shell_id: str) -> ManagedShell | None:
        return self._shells.pop(shell_id, None)
        #   从表里移除(不终止)。

    async def terminate(self, shell_id: str) -> ManagedShell:
        shell = self.get(shell_id)
        if shell.returncode is not None:
            await self._finalize_shell(shell)
            return shell
            #   已退出 → 直接收尾。
        shell.process.terminate()
        #   发 SIGTERM(温和终止)。
        try:
            async with asyncio.timeout(3):
                await shell.process.wait()
                #   等 3 秒优雅退出。
        except TimeoutError:
            shell.process.kill()
            await shell.process.wait()
            #   超时仍未退 → SIGKILL 强杀。
        await self._finalize_shell(shell)
        return shell

    async def wait_closed(self, shell_id: str) -> ManagedShell:
        shell = self.get(shell_id)
        if shell.returncode is None:
            await shell.process.wait()
            #   还在跑 → 等它自然结束。
        await self._finalize_shell(shell)
        return shell

    async def _finalize_shell(self, shell: ManagedShell) -> None:
        for task in shell.read_tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
                #   等两个抽流任务读完剩余输出(确保 output 完整)。
        self._shells.pop(shell.shell_id, None)
        #   从表里移除。

    async def _drain_stream(self, shell: ManagedShell, stream: asyncio.StreamReader | None) -> None:
        if stream is None:
            return
        while chunk := await stream.read(4096):
            shell.output_chunks.append(chunk.decode("utf-8", errors="replace"))
            #   循环读 4KB 块,解码后追加到缓冲(errors="replace" 容忍非法字节);流结束(read 返回空)即停。


shell_manager = ShellManager()
#   全局单例(toolimpl 的 bash 系列共用)。
```

---

## 怎么和别的文件连起来

- `tools/toolimpl.py`:`bash`(start + wait_closed/terminate)、`bash.output`(读 output)、`bash.kill`(terminate)。

---

## 一句话总结

`shell_manager.py` 管理后台 shell:启动子进程并持续抽取输出到缓冲(防管道阻塞),按 id 提供查/终止
(SIGTERM→超时 SIGKILL)/等待结束/收尾。支撑前台+后台两种 bash 工具用法。
