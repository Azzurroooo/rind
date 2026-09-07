import os
import sys
import tempfile
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway import InboundMessage
from gateway.security import (
    CODE_ALPHABET,
    PENDING_CAP,
    CooldownGate,
    PairingStore,
    SecurityGate,
    is_addressed_to_bot,
)


class _FakeClock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def _message(**overrides) -> InboundMessage:
    base = dict(
        channel="telegram",
        chat_id="chat",
        chat_type="dm",
        sender_id="u1",
        sender_name="n",
        thread_id=None,
        text="hi",
        attachments=(),
        message_ref="m-1",
    )
    base.update(overrides)
    return InboundMessage(**base)


def _gate(tmp_path, clock, *, pairing_enabled=True, cooldown_limit=1000):
    return SecurityGate(
        pairing=PairingStore(tmp_path / "pairing.json", now=clock),
        cooldown=CooldownGate(cooldown_limit),
        allow_from={"telegram": ("allowed-sender",)},
        group_allow={"telegram": ("good-group",)},
        pairing_enabled=pairing_enabled,
        pairing_ttl_seconds=3600.0,
    )


# --- admit() decision matrix ---------------------------------------------------


def test_dm_allowlist_hit_allows(tmp_path):
    clock = _FakeClock()
    assert _gate(tmp_path, clock).admit(_message(sender_id="allowed-sender")).allow is True


def test_dm_stranger_gets_pairing_instructions_with_code(tmp_path):
    clock = _FakeClock()
    gate = _gate(tmp_path, clock)
    verdict = gate.admit(_message(sender_id="stranger"))
    assert verdict.allow is False
    assert verdict.pairing is True
    assert "approve" in verdict.notice
    code = next(iter(gate._pairing.pending))
    assert code in verdict.notice
    assert gate._pairing.pending[code]["sender_id"] == "stranger"


def test_dm_pairing_approved_sender_allows(tmp_path):
    clock = _FakeClock()
    gate = _gate(tmp_path, clock)
    code = gate._pairing.ensure_pending("telegram", "stranger", 3600.0)
    assert gate._pairing.approve(code) is True
    assert gate.admit(_message(sender_id="stranger")).allow is True


def test_dm_pairing_disabled_denies_silently(tmp_path):
    clock = _FakeClock()
    gate = _gate(tmp_path, clock, pairing_enabled=False)
    verdict = gate.admit(_message(sender_id="stranger"))
    assert verdict.allow is False
    assert verdict.pairing is False
    assert verdict.notice == ""
    assert gate._pairing.pending == {}


def test_group_allowed_with_mention(tmp_path):
    clock = _FakeClock()
    gate = _gate(tmp_path, clock)
    verdict = gate.admit(_message(chat_type="group", chat_id="good-group", text="@Rind 帮我看下"))
    assert verdict.allow is True


def test_group_allowed_chat_without_mention_denied(tmp_path):
    clock = _FakeClock()
    gate = _gate(tmp_path, clock)
    verdict = gate.admit(_message(chat_type="group", chat_id="good-group", text="普通聊天"))
    assert (verdict.allow, verdict.notice) == (False, "")


def test_group_not_in_allowlist_denied_even_with_mention(tmp_path):
    clock = _FakeClock()
    gate = _gate(tmp_path, clock)
    verdict = gate.admit(_message(chat_type="group", chat_id="evil-group", text="@rind hi"))
    assert verdict.allow is False


def test_mention_detection_is_handle_and_case_insensitive():
    assert is_addressed_to_bot(_message(text="yo @Rind!"), ("rind",))
    assert is_addressed_to_bot(_message(text="(@bot,)"), ("bot",))
    assert not is_addressed_to_bot(_message(text="email me at a@b.com"), ("rind", "bot"))
    assert not is_addressed_to_bot(_message(text="plain"), ("rind",))


# --- pairing codes ---------------------------------------------------------------


def test_code_alphabet_has_no_ambiguous_characters():
    assert "I" not in CODE_ALPHABET and "1" not in CODE_ALPHABET
    assert "O" not in CODE_ALPHABET and "0" not in CODE_ALPHABET
    with tempfile.TemporaryDirectory() as tmp:
        code = PairingStore(Path(tmp) / "pairing.json").ensure_pending("telegram", "s", 60.0)
        assert len(code) == 6
        assert set(code) <= set(CODE_ALPHABET)


def test_pending_cap_is_three(tmp_path):
    clock = _FakeClock()
    store = PairingStore(tmp_path / "pairing.json", now=clock)
    codes = [store.ensure_pending("telegram", f"s{i}", 3600.0) for i in range(PENDING_CAP)]
    assert all(codes)
    assert store.ensure_pending("telegram", "one-more", 3600.0) is None
    # approving frees a slot
    assert store.approve(codes[0]) is True
    assert store.ensure_pending("telegram", "one-more", 3600.0) is not None


def test_pending_ttl_expires_and_is_purged(tmp_path):
    clock = _FakeClock()
    store = PairingStore(tmp_path / "pairing.json", now=clock)
    first = store.ensure_pending("telegram", "s", 60.0)
    clock.advance(61)
    assert store.approve(first) is False  # expired entries are dropped
    second = store.ensure_pending("telegram", "s", 60.0)
    assert second != first


def test_pairing_store_persists_across_instances(tmp_path):
    store = PairingStore(tmp_path / "pairing.json")
    code = store.ensure_pending("telegram", "s", 3600.0)
    reloaded = PairingStore(tmp_path / "pairing.json")
    assert reloaded.approve(code) is True
    assert reloaded.is_approved("telegram", "s") is True
    assert PairingStore(tmp_path / "pairing.json").is_approved("telegram", "s") is True


def test_pairing_store_corrupt_file_starts_empty(tmp_path):
    path = tmp_path / "pairing.json"
    path.write_text("{{garbage", encoding="utf-8")
    store = PairingStore(path)
    assert store.pending == {} and store.approved == []
    assert (tmp_path / "pairing.json.corrupt").is_file()


# --- cooldown --------------------------------------------------------------------


def test_cooldown_allows_then_notices_once_per_window():
    gate = CooldownGate(2)
    verdicts = [gate.admit("telegram", "s", now=1000.0 + offset) for offset in range(4)]
    assert [verdict.allow for verdict in verdicts[:2]] == [True, True]
    assert verdicts[2].allow is False and "频繁" in verdicts[2].notice
    assert verdicts[3].allow is False and verdicts[3].notice == ""  # silent after first notice


def test_cooldown_window_slides_and_notice_resets(tmp_path):
    gate = CooldownGate(1)
    assert gate.admit("telegram", "s", now=1000.0).allow is True
    denied = gate.admit("telegram", "s", now=1030.0)
    assert denied.allow is False and denied.notice != ""
    assert gate.admit("telegram", "s", now=1031.0).allow is False
    # 60s after the first hit the window has only that old entry
    again = gate.admit("telegram", "s", now=1061.0)
    assert again.allow is True


def test_cooldown_is_per_sender(tmp_path):
    gate = CooldownGate(1)
    assert gate.admit("telegram", "a", now=1.0).allow is True
    assert gate.admit("telegram", "b", now=1.0).allow is True
