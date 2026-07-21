import unittest
import asyncio
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.cancellation import (
    CancellationToken,
    CancellationTokenSource,
    create_child_token
)


class TestCancellationToken(unittest.TestCase):
    def test_initial_state(self):
        token = CancellationToken()
        self.assertFalse(token.is_cancelled)
        self.assertIsNone(token.reason)

    def test_cancellation(self):
        source = CancellationTokenSource()
        self.assertFalse(source.token.is_cancelled)

        source.cancel("user_interrupt")
        self.assertTrue(source.token.is_cancelled)
        self.assertEqual(source.token.reason, "user_interrupt")

    def test_callbacks(self):
        source = CancellationTokenSource()
        called = False

        def on_cancel():
            nonlocal called
            called = True

        source.token.register_callback(on_cancel)
        self.assertFalse(called)

        source.cancel()
        self.assertTrue(called)
        self.assertEqual(source.token._callbacks, [])

    def test_callback_after_cancellation(self):
        source = CancellationTokenSource()
        source.cancel()

        called = False
        def on_cancel():
            nonlocal called
            called = True

        # Should be called immediately
        source.token.register_callback(on_cancel)
        self.assertTrue(called)
        self.assertEqual(source.token._callbacks, [])

    def test_callback_deregister_after_cancellation_is_noop(self):
        source = CancellationTokenSource()

        deregister = source.token.register_callback(lambda: None)
        source.cancel()
        deregister()

        self.assertEqual(source.token._callbacks, [])

    def test_child_token_propagation(self):
        parent_source = CancellationTokenSource()
        child_source = create_child_token(parent_source.token)

        self.assertFalse(parent_source.token.is_cancelled)
        self.assertFalse(child_source.token.is_cancelled)

        parent_source.cancel("parent_died")

        self.assertTrue(parent_source.token.is_cancelled)
        self.assertTrue(child_source.token.is_cancelled)
        self.assertEqual(child_source.token.reason, "parent_died")

    def test_child_token_isolation(self):
        parent_source = CancellationTokenSource()
        child_source = create_child_token(parent_source.token)

        child_source.cancel("child_died")

        self.assertTrue(child_source.token.is_cancelled)
        # Parent should NOT be cancelled
        self.assertFalse(parent_source.token.is_cancelled)

    def test_async_wait(self):
        async def run_test():
            source = CancellationTokenSource()

            # Start a task that waits for cancellation
            wait_task = asyncio.create_task(source.token.wait())

            # Should not be done yet
            await asyncio.sleep(0.01)
            self.assertFalse(wait_task.done())

            # Cancel the token
            source.cancel()

            # Should complete immediately
            await asyncio.wait_for(wait_task, timeout=0.1)
            self.assertTrue(wait_task.done())

        asyncio.run(run_test())


if __name__ == "__main__":
    unittest.main()
