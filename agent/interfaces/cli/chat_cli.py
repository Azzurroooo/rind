"""Command-line interface adapter."""

from __future__ import annotations

import asyncio
from pathlib import Path

from agent.domain.cancellation import CancellationTokenSource
from agent.domain.events import RuntimeEvent, UserQuestionRequestedEvent
from agent.version import __version__
from agent.interfaces.cli.commands.completer import SlashCommandCompleter
from agent.interfaces.cli.commands import SlashCommandContext, SlashCommandRouter
from agent.interfaces.cli.status import CliStatusRenderer
from agent.interfaces.cli.ui import (
    GitPromptStatusProvider,
    markdown_renderable,
    print_startup_header,
    prompt_continuation,
    prompt_message,
    prompt_toolbar,
    render_markdown,
    render_resume_preview,
    resume_visible_messages,
    StreamingRenderer,
)
from prompt_toolkit import PromptSession
from prompt_toolkit.application import run_in_terminal
from prompt_toolkit.auto_suggest import AutoSuggestFromHistory
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.key_binding import KeyBindings
from rich.console import Console

_TURN_CANCEL_GRACE_SECONDS = 1.0


class ChatCLI:
    """Interactive CLI that delegates core behavior to application runtime."""

    def __init__(self, runtime, session, debug: bool = False):
        self._runtime = runtime
        self._session = session
        self._debug = debug
        self._console = Console()
        self._streaming_renderer = StreamingRenderer(self._console)
        self._status_renderer = CliStatusRenderer(
            self._console,
            debug=debug,
            before_print=self._flush_assistant_for_status,
        )
        self._prompt_session: PromptSession | None = None
        self._input_history = InMemoryHistory()
        self._git_status_provider = GitPromptStatusProvider()
        self._event_loop: asyncio.AbstractEventLoop | None = None
        self._current_cancel_source: CancellationTokenSource | None = None
        self._last_input_draft_path: Path | None = None
        self._pending_input_prefill = ""
        self._latest_usage: dict[str, object] | None = None
        self._resume_visible_messages: list[dict[str, str]] = []
        self._resume_expanded_count = 0
        self._resume_session_id: str | None = None
        self._slash_router = SlashCommandRouter()
        self._slash_completer = SlashCommandCompleter(self._slash_router.command_infos())
        self._install_user_question_responder()

    def _install_user_question_responder(self) -> None:
        set_responder = getattr(self._runtime, "set_user_question_responder", None)
        if callable(set_responder):
            set_responder(self._answer_user_question)

    def start(self) -> None:
        self._render_banner()

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._event_loop = loop

        try:
            async def _init_session():
                try:
                    await self._session.initialize()
                except Exception as exc:
                    print(str(exc))
                    return False
                return True

            if not loop.run_until_complete(_init_session()):
                return

            loop.run_until_complete(self._load_latest_usage_async())
            self._render_loaded_messages()
            self._loop()
        finally:
            try:
                self._shutdown_loop(loop)
            finally:
                if not loop.is_closed():
                    loop.close()
                self._event_loop = None

    def _render_banner(self) -> None:
        print_startup_header(
            version=__version__,
            debug=self._debug,
            model=getattr(self._session, "model", None),
            cwd=Path.cwd(),
            git_status=self._git_status_provider.current(),
        )

    def _render_loaded_messages(self) -> None:
        messages = self._event_loop.run_until_complete(self._session.get_messages_slice())
        self._seed_input_history(messages)
        self._prepare_resume_history(messages, session_id=getattr(self._session, "session_id", None))
        preview = self._resume_preview_text()
        if not preview:
            return
        self._console.print()
        self._console.print(preview, style="dim", highlight=False, markup=False)

    def _prepare_resume_history(self, messages: list[dict], *, session_id: str | None = None) -> None:
        self._resume_visible_messages = resume_visible_messages(messages)
        self._resume_expanded_count = 0
        self._resume_session_id = session_id

    def _resume_preview_text(self) -> str:
        return render_resume_preview(self._resume_visible_messages, session_id=self._resume_session_id)

    def _render_next_resume_message(self) -> None:
        if not self._resume_visible_messages:
            self._console.print("\nNo resume history messages to show.", style="dim", highlight=False)
            return

        if self._resume_expanded_count >= len(self._resume_visible_messages):
            self._console.print("\nAll resume history messages are already shown.", style="dim", highlight=False)
            return

        self._resume_expanded_count += 1
        self._redraw_resume_history()

    def _redraw_resume_history(self) -> None:
        self._console.clear()
        preview = self._resume_preview_text()
        if preview:
            self._console.print(preview, style="dim", highlight=False, markup=False)

        expanded = self._resume_visible_messages[-self._resume_expanded_count :]
        if not expanded:
            return

        total = len(self._resume_visible_messages)
        first_position = total - len(expanded) + 1
        self._console.print()
        self._console.print(
            f"Expanded resume history: showing {len(expanded)} most recent message(s).",
            style="bold cyan",
            highlight=False,
        )
        for offset, message in enumerate(expanded):
            self._render_resume_history_message(message, position=first_position + offset, total=total)

    def _render_resume_history_message(self, message: dict[str, str], *, position: int, total: int) -> None:
        role = message["role"]
        content = message["content"]

        self._console.print()
        self._console.print(
            f"History {position}/{total} - {role}",
            style="bold cyan",
            highlight=False,
        )
        if role == "assistant":
            self._console.print(markdown_renderable(content))
        else:
            self._console.print(content, markup=False, highlight=False)

    def _loop(self) -> None:
        if hasattr(self._runtime, "set_retry_callback"):
            self._runtime.set_retry_callback(self._on_retry)

        while True:
            try:
                user_input = self._read_user_input()
            except (KeyboardInterrupt, EOFError):
                self._render_saved_draft_notice()
                print("\n再见！👋")
                break

            if user_input.lower() in {"quit", "exit", "q"}:
                print("再见！👋")
                break
            if not user_input:
                continue
            if self._is_slash_command(user_input):
                try:
                    should_exit = self._run_slash_command_blocking(user_input)
                    if should_exit:
                        break
                except KeyboardInterrupt:
                    print("\n[User Interrupted: Command cancelled.]")
                continue

            print("\nAgent:")
            self._streaming_renderer = StreamingRenderer(self._console)
            self._status_renderer = CliStatusRenderer(
                self._console,
                debug=self._debug,
                before_print=self._flush_assistant_for_status,
            )

            try:
                self._run_turn_blocking(user_input)
                self._streaming_renderer.flush()
                print()
            except KeyboardInterrupt:
                self._streaming_renderer.flush()
                print("\n[User Interrupted: Session state preserved. You can resume later.]")
            except Exception as exc:
                self._streaming_renderer.flush()
                print(f"\nError: {exc}")

    def _read_user_input(self) -> str:
        if self._prompt_session is None:
            self._prompt_session = PromptSession(
                key_bindings=self._build_input_key_bindings(),
                multiline=True,
                completer=self._slash_completer,
                complete_while_typing=True,
                history=self._input_history,
                auto_suggest=AutoSuggestFromHistory(),
                prompt_continuation=prompt_continuation,
                bottom_toolbar=lambda: prompt_toolbar(
                    self._session,
                    debug=self._debug,
                    usage=self._latest_usage,
                    git_status=self._git_status_provider.current(),
                ),
            )
        prefill = self._pending_input_prefill
        self._pending_input_prefill = ""
        return self._prompt_session.prompt(prompt_message(), default=prefill).strip()

    async def _answer_user_question(self, event: UserQuestionRequestedEvent) -> str:
        self._flush_assistant_for_status()
        self._render_user_question(event)
        prompt = PromptSession(history=InMemoryHistory())
        answer = (await prompt.prompt_async("Answer > ")).strip()
        return self._resolve_user_question_answer(answer, event.options)

    def _read_user_question_answer(self, event: UserQuestionRequestedEvent) -> str:
        self._flush_assistant_for_status()
        self._render_user_question(event)
        prompt = PromptSession(history=InMemoryHistory())
        answer = prompt.prompt("Answer > ").strip()
        return self._resolve_user_question_answer(answer, event.options)

    def _render_user_question(self, event: UserQuestionRequestedEvent) -> None:
        self._console.print()
        self._console.print(event.question, style="bold cyan", highlight=False, markup=False)
        options = event.options or []
        if not options:
            return
        recommended = (event.recommended or "").strip()
        for index, option in enumerate(options, start=1):
            suffix = " (recommended)" if recommended and option == recommended else ""
            self._console.print(f"{index}. {option}{suffix}", highlight=False, markup=False)

    def _resolve_user_question_answer(self, answer: str, options: list[str] | None) -> str:
        text = str(answer or "").strip()
        if not text:
            return ""
        if options and text.isdecimal():
            index = int(text)
            if 1 <= index <= len(options):
                return options[index - 1]
        return text

    def _seed_input_history(self, messages: list[dict]) -> None:
        seen = set()
        for message in messages[-40:]:
            if not isinstance(message, dict) or message.get("role") != "user":
                continue
            content = str(message.get("content") or "").strip()
            if not content or content in seen:
                continue
            self._input_history.append_string(content)
            seen.add(content)

    def _build_input_key_bindings(self) -> KeyBindings:
        bindings = KeyBindings()

        @bindings.add("c-m")
        def _(event):
            event.app.exit(result=event.app.current_buffer.text)

        @bindings.add("c-j")
        def _(event):
            event.app.current_buffer.insert_text("\n")

        @bindings.add("c-l")
        def _(event):
            self._clear_prompt_screen()

        @bindings.add("c-o")
        def _(event):
            run_in_terminal(self._render_next_resume_message)

        @bindings.add("c-c")
        def _(event):
            self._save_input_draft(event.app.current_buffer.text)
            event.app.exit(exception=KeyboardInterrupt)

        @bindings.add("c-d")
        def _(event):
            self._save_input_draft(event.app.current_buffer.text)
            event.app.exit(exception=EOFError)

        for sequence in (
            ("escape", "c-m"),
            ("escape", "c-j"),
            ("escape", "[", "1", "3", ";", "2", "u"),
            ("escape", "[", "1", "3", ";", "2", "~"),
        ):
            @bindings.add(*sequence)
            def _(event):
                event.app.current_buffer.insert_text("\n")

        return bindings

    def _clear_prompt_screen(self) -> None:
        self._console.clear()

    def _save_input_draft(self, text: str) -> Path | None:
        draft = str(text or "").strip()
        if not draft:
            return None
        base = self._session_base_path()
        if base is None:
            return None
        try:
            base.mkdir(parents=True, exist_ok=True)
            path = base / "input_draft.txt"
            path.write_text(draft, encoding="utf-8")
            self._last_input_draft_path = path
            return path
        except Exception:
            return None

    def _render_saved_draft_notice(self) -> None:
        if self._last_input_draft_path is None:
            return
        self._console.print(f"Draft saved: {self._last_input_draft_path}", style="dim", highlight=False)
        self._last_input_draft_path = None

    def _session_base_path(self) -> Path | None:
        paths = getattr(self._session, "_session_paths", None)
        if isinstance(paths, dict) and paths.get("base"):
            return Path(str(paths["base"]))
        root = getattr(self._session, "_session_root", None)
        session_id = getattr(self._session, "session_id", None)
        if root and session_id:
            return Path(str(root)) / str(session_id)
        return None

    async def _run_turn_async(
        self,
        user_input: str,
        transient_system_messages: list[dict] | None = None,
    ) -> None:
        cancel_source = CancellationTokenSource()
        self._current_cancel_source = cancel_source
        if transient_system_messages:
            event_stream = self._runtime.run_turn(
                query=user_input,
                cancellation_token=cancel_source.token,
                transient_system_messages=transient_system_messages,
            )
        else:
            event_stream = self._runtime.run_turn(query=user_input, cancellation_token=cancel_source.token)
        try:
            async for event in event_stream:
                self._on_event(event)
        finally:
            self._current_cancel_source = None
            cancel_source.dispose()
            if not getattr(event_stream, "ag_running", False):
                aclose = getattr(event_stream, "aclose", None)
                if callable(aclose):
                    await aclose()

    def _run_turn_blocking(self, user_input: str) -> None:
        if self._event_loop is None:
            raise RuntimeError("Event loop is not initialized.")
        task = self._event_loop.create_task(self._run_turn_async(user_input))
        try:
            self._event_loop.run_until_complete(task)
        except KeyboardInterrupt:
            self._cancel_current_turn("User interrupted")
            self._settle_interrupted_turn(task)
            raise

    def _cancel_current_turn(self, reason: str) -> None:
        source = self._current_cancel_source
        if source and not source.token.is_cancelled:
            source.cancel(reason)

    def _settle_interrupted_turn(self, task: asyncio.Task) -> None:
        if self._event_loop is None or self._event_loop.is_closed() or task.done():
            return
        try:
            self._event_loop.run_until_complete(
                asyncio.wait_for(asyncio.shield(task), timeout=_TURN_CANCEL_GRACE_SECONDS)
            )
        except TimeoutError:
            task.cancel()
            self._event_loop.run_until_complete(asyncio.gather(task, return_exceptions=True))
        except (asyncio.CancelledError, Exception):
            pass

    def _is_slash_command(self, text: str) -> bool:
        return text.lstrip().startswith("/")

    async def _run_slash_command_async(
        self,
        user_input: str,
        cancellation_token=None,
    ) -> bool:
        result = await self._slash_router.execute(
            user_input,
            SlashCommandContext(
                runtime=self._runtime,
                session=self._session,
                debug=self._debug,
                cancellation_token=cancellation_token,
            ),
        )
        if result.clear_screen:
            self._console.clear()
        if result.input_prefill:
            self._pending_input_prefill = result.input_prefill
        if result.text:
            render_markdown(result.text)
        if result.run_turn_input:
            print("\nAgent:")
            self._streaming_renderer = StreamingRenderer(self._console)
            self._status_renderer = CliStatusRenderer(
                self._console,
                debug=self._debug,
                before_print=self._flush_assistant_for_status,
            )
            await self._run_turn_async(
                result.run_turn_input,
                transient_system_messages=result.transient_system_messages,
            )
            self._streaming_renderer.flush()
            print()
        return result.should_exit

    def _run_slash_command_blocking(self, user_input: str) -> bool:
        if self._event_loop is None:
            raise RuntimeError("Event loop is not initialized.")
        cancel_source = CancellationTokenSource()
        self._current_cancel_source = cancel_source
        task = self._event_loop.create_task(
            self._run_slash_command_async(user_input, cancellation_token=cancel_source.token)
        )
        try:
            return self._event_loop.run_until_complete(task)
        except KeyboardInterrupt:
            self._cancel_current_turn("User interrupted")
            self._settle_interrupted_turn(task)
            raise
        finally:
            self._current_cancel_source = None
            cancel_source.dispose()

    async def _load_latest_usage_async(self) -> None:
        usage = await self._preferred_sampling_usage()
        self._latest_usage = dict(usage) if isinstance(usage, dict) else None

    async def _preferred_sampling_usage(self) -> dict | None:
        for name in ("get_latest_assistant_sampling_usage", "get_latest_sampling_usage"):
            get_usage = getattr(self._session, name, None)
            if not callable(get_usage):
                continue
            try:
                usage = await get_usage()
            except Exception:
                continue
            if isinstance(usage, dict):
                return dict(usage)
        return None

    def _shutdown_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        if loop.is_closed():
            return
        pending = [task for task in asyncio.all_tasks(loop) if not task.done()]
        for task in pending:
            task.cancel()
        if pending:
            loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        loop.run_until_complete(loop.shutdown_asyncgens())
        loop.run_until_complete(loop.shutdown_default_executor())
        loop.close()

    def _flush_assistant_for_status(self) -> None:
        self._streaming_renderer.finish_message()

    def _on_event(self, event: RuntimeEvent) -> None:
        from agent.domain.events import (
            AssistantDeltaEvent,
            AssistantMessageCompletedEvent,
            TokenStatsUpdatedEvent,
        )

        if isinstance(event, AssistantDeltaEvent):
            self._streaming_renderer.append(event.text)
        elif isinstance(event, AssistantMessageCompletedEvent):
            self._streaming_renderer.finish_message()
        elif isinstance(event, TokenStatsUpdatedEvent):
            self._latest_usage = dict(event.stats) if isinstance(event.stats, dict) else None
            self._status_renderer.handle(event)
        else:
            self._status_renderer.handle(event)

    def _on_retry(self, attempt: int, exception: Exception) -> None:
        self._streaming_renderer.show_retry(attempt, exception)
