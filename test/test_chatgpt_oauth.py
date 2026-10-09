"""Sign in with ChatGPT: the browser callback, a pasted redirect, the token,
its refresh before it expires, and what a subscription token may send."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from agent.domain.errors import ProviderError
from agent.domain.models import Credential, ModelSelection
from agent.infrastructure.credentials import CredentialStore
from agent.infrastructure.llm import chatgpt_oauth
from agent.infrastructure.llm.openai_responses import OpenAIResponsesClient
from agent.infrastructure.llm.provider_service import ProviderServiceImpl
from agent.infrastructure.settings import AppSettings

TOKEN = {"access_token": "access-1", "refresh_token": "refresh-1", "expires_in": 3600, "id_token": "id", "scope": "openid resource.invoke chatgpt.tokens.use.direct"}


class Browser:
    """Opens nothing; remembers the authorize URL the way a browser would get it."""

    def __init__(self, monkeypatch):
        self.url = ""
        monkeypatch.setattr(chatgpt_oauth.webbrowser, "open", lambda url: setattr(self, "url", url) or True)

    def params(self) -> dict[str, str]:
        return {key: values[0] for key, values in parse_qs(urlsplit(self.url).query).items()}


class Interaction:
    def __init__(self, answer):
        self.answer = answer
        self.notices: list[dict] = []
        self.prompts: list[tuple[str, str]] = []

    def notify(self, event):
        self.notices.append(event)

    async def prompt(self, kind, message, options=None):
        self.prompts.append((kind, message))
        return await self.answer() if callable(self.answer) else self.answer


@pytest.fixture
def token_endpoint(monkeypatch):
    calls: list[dict[str, str]] = []

    def post(url, data, headers, timeout):
        calls.append(dict(data))
        body = dict(TOKEN, access_token=f"access-{len(calls)}", refresh_token=f"refresh-{len(calls)}")
        return httpx.Response(200, json=body, request=httpx.Request("POST", url))

    monkeypatch.setattr(chatgpt_oauth.httpx, "post", post)
    return calls


async def _callback(query: str) -> tuple[int, str]:
    reader, writer = await asyncio.open_connection(chatgpt_oauth.CALLBACK_HOST, chatgpt_oauth.CALLBACK_PORT)
    writer.write(f"GET {chatgpt_oauth.CALLBACK_PATH}?{query} HTTP/1.1\r\nHost: x\r\n\r\n".encode())
    await writer.drain()
    response = (await reader.read()).decode()
    writer.close()
    return int(response.split(" ")[1]), response


@pytest.mark.asyncio
async def test_the_browser_callback_signs_in_and_the_token_is_exchanged_with_pkce(monkeypatch, token_endpoint):
    browser = Browser(monkeypatch)
    pages = []

    async def press_enter():
        state = browser.params()["state"]
        pages.append(await _callback(f"state=wrong&code=c&client_id=x"))
        pages.append(await _callback(f"code=the-code&state={state}&client_id=issued-client"))
        return ""

    interaction = Interaction(press_enter)
    credential = await chatgpt_oauth.login(interaction)

    params = browser.params()
    assert (params["client_id"], params["code_challenge_method"], params["redirect_uri"]) == ("dynamic_agent_client", "S256", chatgpt_oauth.REDIRECT_URI)
    assert "chatgpt.tokens.use.direct" in params["scope"] and params["ext_agent_host_id"].startswith("urn:uuid:")
    assert interaction.notices[0]["type"] == "auth_url" and browser.url in interaction.notices[0]["message"], "the URL is shown in case no browser opened"
    assert pages[0][0] == 400 and pages[1][0] == 200 and "Return to Rind" in pages[1][1]
    exchange = token_endpoint[0]
    assert (exchange["grant_type"], exchange["code"], exchange["client_id"]) == ("authorization_code", "the-code", "issued-client")
    assert len(exchange["code_verifier"]) >= 43
    assert (credential.type, credential.access, credential.refresh, credential.client_id) == ("oauth", "access-1", "refresh-1", "issued-client")
    assert credential.expires_at > time.time() + 3000


@pytest.mark.asyncio
async def test_a_pasted_redirect_url_signs_in_without_the_callback(monkeypatch, token_endpoint):
    browser = Browser(monkeypatch)

    async def paste():
        return f"{chatgpt_oauth.REDIRECT_URI}?code=pasted&state={browser.params()['state']}&client_id=c2"

    credential = await chatgpt_oauth.login(Interaction(paste))
    assert (token_endpoint[0]["code"], credential.client_id) == ("pasted", "c2")


@pytest.mark.asyncio
@pytest.mark.parametrize("answer, message", [
    (lambda state: "", "did not finish in the browser"),
    (lambda state: "https://example.com/elsewhere?code=x", "starts with http://127.0.0.1:1455/auth/callback"),
    (lambda state: f"{chatgpt_oauth.REDIRECT_URI}?error=access_denied&error_description=No+thanks", "No thanks"),
    (lambda state: f"{chatgpt_oauth.REDIRECT_URI}?code=x&state=other&client_id=c", "another sign-in"),
])
async def test_a_sign_in_that_did_not_finish_says_why_and_frees_the_port(monkeypatch, token_endpoint, answer, message):
    browser = Browser(monkeypatch)

    async def respond():
        return answer(browser.params()["state"])

    with pytest.raises(ValueError, match=message):
        await chatgpt_oauth.login(Interaction(respond))
    assert token_endpoint == []
    server = await asyncio.start_server(lambda r, w: None, chatgpt_oauth.CALLBACK_HOST, chatgpt_oauth.CALLBACK_PORT)
    server.close()


@pytest.mark.asyncio
async def test_a_busy_callback_port_is_explained(monkeypatch):
    Browser(monkeypatch)
    server = await asyncio.start_server(lambda r, w: None, chatgpt_oauth.CALLBACK_HOST, chatgpt_oauth.CALLBACK_PORT)
    try:
        with pytest.raises(ValueError, match="Port 1455 is in use"):
            await chatgpt_oauth.login(Interaction(""))
    finally:
        server.close()


def test_a_token_without_api_access_is_refused(monkeypatch):
    monkeypatch.setattr(chatgpt_oauth.httpx, "post", lambda url, data, headers, timeout: httpx.Response(200, json=dict(TOKEN, scope="openid"), request=httpx.Request("POST", url)))
    with pytest.raises(ValueError, match="cannot use its subscription"):
        chatgpt_oauth._exchange("c", "client", "verifier")


def test_a_token_is_refreshed_only_when_it_is_about_to_expire(token_endpoint):
    valid = Credential(type="oauth", access="a", refresh="r", expires_at=int(time.time()) + 3600, client_id="client")
    assert chatgpt_oauth.fresh(valid) is valid
    renewed = chatgpt_oauth.fresh(Credential(type="oauth", access="a", refresh="r", expires_at=int(time.time()) + 60, client_id="client"))
    assert token_endpoint == [{"grant_type": "refresh_token", "client_id": "client", "refresh_token": "r", "resource": "https://api.openai.com/v1"}]
    assert (renewed.access, renewed.refresh, renewed.client_id) == ("access-1", "refresh-1", "client")


def _settings(tmp_path: Path) -> AppSettings:
    return AppSettings(tmp_path / "settings.json", False, "gpt-5.5", "", "", "", provider="openai")


@pytest.mark.asyncio
async def test_a_signed_in_client_sends_a_fresh_token_and_persists_the_rotated_one(tmp_path, monkeypatch, token_endpoint):
    monkeypatch.setattr("agent.infrastructure.llm.provider_service.load_settings", lambda: _settings(tmp_path))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    store = CredentialStore(tmp_path / "auth.json")
    store.set("openai", Credential(type="oauth", access="old", refresh="r0", expires_at=int(time.time()) + 30, client_id="client"))
    service = ProviderServiceImpl(store)
    assert {status.id: status.methods for status in service.list_providers()}["openai"] == ("api_key", "oauth")

    seen = []

    async def send(self, request, **kwargs):
        seen.append((request.headers["authorization"], json.loads(request.content)))
        return httpx.Response(200, json={"id": "r", "object": "response", "status": "completed", "output": [], "usage": {"input_tokens": 1, "output_tokens": 1}}, request=request)

    monkeypatch.setattr(httpx.AsyncClient, "send", send)
    client = await service.create_chat_client(_settings(tmp_path), ModelSelection("openai", "gpt-5.5"), workspace_root=None)
    try:
        await client.create([{"role": "user", "content": "hi"}], max_output_tokens=16)
        await client.create([{"role": "user", "content": "again"}])
    finally:
        await client.close()
    assert [authorization for authorization, _ in seen] == ["Bearer access-1", "Bearer access-1"], "refreshed once, then reused"
    assert seen[0][1]["store"] is False and "max_output_tokens" not in seen[0][1], "a subscription token stores nothing and takes no output cap"
    stored = store.get("openai")
    assert (stored.access, stored.refresh, stored.client_id) == ("access-1", "refresh-1", "client")


@pytest.mark.asyncio
async def test_signing_out_while_a_client_is_open_says_so(tmp_path, monkeypatch):
    monkeypatch.setattr("agent.infrastructure.llm.provider_service.load_settings", lambda: _settings(tmp_path))
    store = CredentialStore(tmp_path / "auth.json")
    store.set("openai", Credential(type="oauth", access="old", refresh="r0", expires_at=int(time.time()) + 30, client_id="client"))
    service = ProviderServiceImpl(store)
    client = await service.create_chat_client(_settings(tmp_path), ModelSelection("openai", "gpt-5.5"), workspace_root=None)
    service.logout("openai")
    try:
        with pytest.raises(ProviderError, match="Signed out of OpenAI"):
            await client.create([{"role": "user", "content": "hi"}])
    finally:
        await client.close()


def test_an_api_key_client_is_unchanged():
    client = OpenAIResponsesClient(None, "gpt-5.5")
    assert "store" not in client._payload([{"role": "user", "content": "hi"}], None, stream=True)
