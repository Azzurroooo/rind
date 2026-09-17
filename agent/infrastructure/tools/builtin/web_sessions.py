"""Worker-owned HTTP sessions, leased exclusively to one tool call at a time."""

from contextlib import contextmanager
from threading import Lock


class WebSessions:
    def __init__(self):
        self._idle = []
        self._lock = Lock()
        self._closed = False

    @contextmanager
    def acquire(self):
        with self._lock:
            if self._closed:
                raise RuntimeError("Web sessions are closed.")
            session = self._idle.pop() if self._idle else self._create_session()
        try:
            yield session
        finally:
            with self._lock:
                if self._closed:
                    session.close()
                else:
                    self._idle.append(session)

    def close(self) -> None:
        with self._lock:
            self._closed = True
            sessions, self._idle = self._idle, []
        for session in sessions:
            session.close()

    @staticmethod
    def _create_session():
        try:
            from curl_cffi.requests import Session
        except ImportError:
            from requests import Session

            return Session()
        return Session(impersonate="chrome", use_thread_local_curl=False)
