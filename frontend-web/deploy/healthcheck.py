import asyncio

from websockets.asyncio.client import connect


async def check_worker() -> None:
    async with connect("ws://127.0.0.1:8765", open_timeout=2):
        return


asyncio.run(check_worker())
