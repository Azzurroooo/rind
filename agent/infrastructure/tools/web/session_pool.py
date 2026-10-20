"""Worker-owned HTTP sessions, leased exclusively to one tool call at a time."""

from contextlib import contextmanager
from threading import Condition


class WebSessions:
    MAX_IDLE_SESSIONS = 4
    CLOSE_TIMEOUT_SECONDS = 5.0

    def __init__(self):
        self._idle = []
        self._condition = Condition()
        self._active = 0
        self._closed = False

    @contextmanager
    def acquire(self):
        with self._condition:
            if self._closed:
                raise RuntimeError("Web sessions are closed.")
            session = self._idle.pop() if self._idle else self._create_session()
            self._active += 1
        try:
            yield session
        finally:
            with self._condition:
                try:
                    if self._closed or len(self._idle) >= self.MAX_IDLE_SESSIONS:
                        session.close()
                    else:
                        self._idle.append(session)
                finally:
                    self._active -= 1
                    self._condition.notify_all()

    def close(self) -> None:
        with self._condition:
            self._closed = True
            sessions, self._idle = self._idle, []
        for session in sessions:
            session.close()
        with self._condition:
            self._condition.wait_for(lambda: self._active == 0, timeout=self.CLOSE_TIMEOUT_SECONDS)

    @staticmethod
    def _create_session():
        try:
            from curl_cffi.requests import Session
        except ImportError:
            from requests import Session

            return Session()
        return Session(impersonate="chrome", use_thread_local_curl=False)
