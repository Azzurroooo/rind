"""Telegram adapter smoke tests against a mocked aiogram (渠道冒烟, §9).

A fake ``aiogram`` module is injected into ``sys.modules``; the real adapter
code (lazy import, polling loop, normalization, send) runs end to end over
it — no network, no SDK installed.  Covers: private-text inbound →
InboundMessage, choices → inline keyboard with "ans:<index>" callback data,
callback query → digit text, oversize attachment → ignored + one-line notice,
plus typing and stop/cleanup.  Async scenarios follow the repo convention:
sync tests driving ``asyncio.run``.
"""

import asyncio
import os
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway import Attachment, Channel, OutboundPayload, SendTarget  # noqa: E402
from gateway.channels import telegram  # noqa: E402
from gateway.config import ChannelConfig  # noqa: E402


# --- fake aiogram SDK -----------------------------------------------------------


class FakeInlineKeyboardButton:
    def __init__(self, text, callback_data):
        self.text = text
        self.callback_data = callback_data


class FakeInlineKeyboardMarkup:
    def __init__(self, inline_keyboard):
        self.inline_keyboard = inline_keyboard


class FakeFSInputFile:
    def __init__(self, path, name=None):
        self.path = str(path)
        self.name = name


class FakeSession:
    def __init__(self):
        self.closed = False

    async def close(self):
        self.closed = True


class FakeBot:
    def __init__(self, token, **kwargs):
        self.token = token
        self.session = FakeSession()
        self.webhooks_dropped = 0
        self.updates = []
        self.sent = []
        self.media = []
        self.chat_actions = []
        self.downloads = []

    async def delete_webhook(self, drop_pending_updates=False):
        self.webhooks_dropped += 1
        self.drop_pending = drop_pending_updates

    async def get_updates(self, offset=0, timeout=0, **kwargs):
        await asyncio.sleep(0.005)
        batch, self.updates = self.updates[:], []
        return batch

    async def send_message(self, chat_id, text, parse_mode=None, reply_markup=None, message_thread_id=None, **kwargs):
        self.sent.append(SimpleNamespace(chat_id=chat_id, text=text, parse_mode=parse_mode,
                                         reply_markup=reply_markup, message_thread_id=message_thread_id))
        return SimpleNamespace(message_id=100 + len(self.sent))

    async def send_photo(self, chat_id, photo=None, **kwargs):
        self.media.append(("photo", chat_id, photo))

    async def send_document(self, chat_id, document=None, **kwargs):
        self.media.append(("document", chat_id, document))

    async def send_chat_action(self, chat_id, action, **kwargs):
        self.chat_actions.append((chat_id, action))

    async def download(self, file, destination=None):
        self.downloads.append(file)
        Path(destination).write_bytes(b"attachment-bytes")
        return destination


def make_fake_aiogram() -> types.ModuleType:
    module = types.ModuleType("aiogram")
    module.Bot = FakeBot
    module.InlineKeyboardButton = FakeInlineKeyboardButton
    module.InlineKeyboardMarkup = FakeInlineKeyboardMarkup
    module.FSInputFile = FakeFSInputFile
    return module


@pytest.fixture
def fake_aiogram(monkeypatch):
    module = make_fake_aiogram()
    monkeypatch.setitem(sys.modules, "aiogram", module)
    return module


# --- fixture objects shaped like aiogram 3 entities -------------------------------


def _user(uid=1001, first="Ada", last=""):
    return SimpleNamespace(id=uid, first_name=first, last_name=last, username="ada")


def _chat(cid=42, type="private"):
    return SimpleNamespace(id=cid, type=type)


def _message(*, message_id=7, chat=None, user=None, text="", caption=None, photo=None,
             document=None, voice=None, video=None, thread_id=None):
    return SimpleNamespace(message_id=message_id, chat=chat or _chat(), from_user=user or _user(),
                           text=text, caption=caption, photo=photo, document=document,
                           voice=voice, video=video, message_thread_id=thread_id)


def _update(payload=None, *, callback_query=None, update_id=1):
    return SimpleNamespace(update_id=update_id, message=payload, callback_query=callback_query)


class _CallbackQuery:
    def __init__(self, cid, data, message, user):
        self.id = cid
        self.data = data
        self.message = message
        self.from_user = user
        self.answered = 0

    def answer(self):
        self.answered += 1

        async def _noop():
            return None

        return _noop()


class _Sink:
    def __init__(self):
        self.messages = []

    async def inbound(self, message):
        self.messages.append(message)


async def _until(predicate, timeout=2.0, message="condition not met"):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError(message)
        await asyncio.sleep(0.005)


async def _start(tmp_path):
    channel = telegram.build_channel(ChannelConfig(id="telegram", token="TOKEN-1"), tmp_path / "uploads")
    assert isinstance(channel, Channel)
    sink = _Sink()
    await channel.start(sink)
    bot = channel._bot
    assert isinstance(bot, FakeBot) and bot.token == "TOKEN-1" and bot.webhooks_dropped == 1
    return channel, bot, sink


# --- receive: update → InboundMessage -----------------------------------------------


def test_private_text_update_flows_to_inbound_message(tmp_path, fake_aiogram):
    async def scenario():
        channel, bot, sink = await _start(tmp_path)
        bot.updates.append(_update(_message(message_id=7, chat=_chat(42, "private"), user=_user(1001, "Ada"),
                                            text="帮我看看 build 报错"), update_id=1))
        await _until(lambda: len(sink.messages) == 1, message="polling loop never delivered the update")
        msg = sink.messages[0]
        assert msg.channel == "telegram"
        assert msg.chat_id == "42"
        assert msg.chat_type == "dm"
        assert msg.sender_id == "1001"
        assert msg.sender_name == "Ada"
        assert msg.thread_id is None
        assert msg.text == "帮我看看 build 报错"
        assert msg.attachments == ()
        assert msg.message_ref == "42:7"
        await channel.stop()

    asyncio.run(scenario())


def test_group_message_with_caption_and_forum_thread(tmp_path, fake_aiogram):
    async def scenario():
        channel, bot, sink = await _start(tmp_path)
        photo = [SimpleNamespace(file_id="p1", width=90, height=90, file_size=1200),
                 SimpleNamespace(file_id="p2", width=800, height=600, file_size=90000)]
        bot.updates.append(_update(_message(message_id=8, chat=_chat(-100, "supergroup"), user=_user(1002, "Bob"),
                                            text=None, caption="看这张图", photo=photo, thread_id=55), update_id=1))
        await _until(lambda: len(sink.messages) == 1)
        msg = sink.messages[0]
        assert msg.chat_type == "group"
        assert msg.thread_id == "55"
        assert msg.text == "看这张图"  # caption stands in for text on media messages
        assert len(msg.attachments) == 1 and msg.attachments[0].kind == "image"
        assert bot.downloads == [photo[1]]  # largest photo size wins
        await channel.stop()

    asyncio.run(scenario())


def test_callback_query_normalizes_to_digit_text(tmp_path, fake_aiogram):
    async def scenario():
        channel, bot, sink = await _start(tmp_path)
        callback = _CallbackQuery("cb-9", "ans:1",
                                  message=SimpleNamespace(message_id=55, chat=_chat(42, "private"), message_thread_id=None),
                                  user=_user(1001, "Ada"))
        bot.updates.append(_update(callback_query=callback, update_id=2))
        await _until(lambda: len(sink.messages) == 1)
        msg = sink.messages[0]
        assert msg.text == "2"  # pump's question row reads the digit; no session logic here
        assert msg.chat_id == "42" and msg.channel == "telegram"
        assert msg.message_ref == "cb-9"
        assert callback.answered == 1  # button press acknowledged
        await channel.stop()

    asyncio.run(scenario())


def test_oversize_attachment_is_ignored_with_one_line_notice(tmp_path, fake_aiogram):
    async def scenario():
        channel, bot, sink = await _start(tmp_path)
        huge = SimpleNamespace(file_id="f1", file_name="huge.zip", file_size=21 * 1024 * 1024,
                               mime_type="application/zip")
        bot.updates.append(_update(_message(message_id=9, document=huge, text=""), update_id=1))
        await _until(lambda: len(sink.messages) == 1)
        msg = sink.messages[0]
        assert msg.attachments == ()  # attachment dropped
        assert bot.downloads == []
        notice = bot.sent[-1]
        assert "20MB" in notice.text  # one-line notice instead
        assert notice.chat_id == "42"
        await channel.stop()

    asyncio.run(scenario())


def test_document_attachment_downloads_into_uploads_dir(tmp_path, fake_aiogram):
    async def scenario():
        channel, bot, sink = await _start(tmp_path)
        doc = SimpleNamespace(file_id="f2", file_name="build log.txt", file_size=1024, mime_type="text/plain")
        bot.updates.append(_update(_message(message_id=10, chat=_chat(42), user=_user(), document=doc), update_id=1))
        await _until(lambda: len(sink.messages) == 1)
        (attachment,) = sink.messages[0].attachments
        assert attachment.path.is_file()
        assert attachment.path.parent.parent.parent == tmp_path / "uploads"  # <uploads>/telegram/<date>/
        assert attachment.path.parent.parent.name == "telegram"
        assert attachment.path.name == "build_log.txt"  # sanitized, no spaces
        assert attachment.content_type == "text/plain" and attachment.kind == "document"
        await channel.stop()

    asyncio.run(scenario())


# --- send ------------------------------------------------------------------------


def test_send_with_choices_builds_inline_keyboard_ans_digits(tmp_path, fake_aiogram):
    async def scenario():
        channel, bot, sink = await _start(tmp_path)
        await channel.send(SendTarget(chat_id="42"),
                           OutboundPayload(text="部署到生产环境？", choices=("立即部署", "再等等")))
        entry = bot.sent[-1]
        assert entry.text == "部署到生产环境？"
        assert entry.parse_mode is None  # markdown "none": plain text
        rows = [row[0] for row in entry.reply_markup.inline_keyboard]
        assert [button.callback_data for button in rows] == ["ans:0", "ans:1"]
        assert [button.text for button in rows] == ["立即部署", "再等等"]
        await channel.stop()

    asyncio.run(scenario())


def test_send_text_and_attachment_use_native_apis(tmp_path, fake_aiogram):
    async def scenario():
        channel, bot, sink = await _start(tmp_path)
        media = tmp_path / "out.png"
        media.write_bytes(b"png")
        payload = OutboundPayload(text="完成",
                                  attachments=(Attachment(path=media, content_type="image/png", kind="image"),))
        await channel.send(SendTarget(chat_id="42", thread_id="55"), payload)
        assert bot.sent[-1].text == "完成" and bot.sent[-1].message_thread_id == "55"
        assert bot.media[0][0] == "photo" and bot.media[0][1] == "42" and bot.media[0][2].path == str(media)
        await channel.stop()

    asyncio.run(scenario())


def test_typing_sends_chat_action(tmp_path, fake_aiogram):
    async def scenario():
        channel, bot, sink = await _start(tmp_path)
        await channel.typing(SendTarget(chat_id="42"))
        await channel.typing(SendTarget(chat_id="42", thread_id="7"))
        assert bot.chat_actions == [("42", "typing"), ("42", "typing")]
        await channel.stop()

    asyncio.run(scenario())


# --- lifecycle ---------------------------------------------------------------------


def test_stop_cancels_polling_and_closes_bot_session(tmp_path, fake_aiogram):
    async def scenario():
        channel, bot, sink = await _start(tmp_path)
        await channel.stop()
        assert bot.session.closed
        assert channel._poll_task is None and channel._bot is None
        await channel.send(SendTarget(chat_id="42"), OutboundPayload(text="after stop"))  # dropped, not raised
        assert bot.sent == []

    asyncio.run(scenario())
