"""Sign in with ChatGPT: a public OAuth client whose token calls api.openai.com directly.

Login runs PKCE through the browser with a callback on 127.0.0.1:1455; the
redirect URL can also be pasted when the callback cannot be reached. The token
then works like an API key for the OpenAI Responses API, and is refreshed
before it expires.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import secrets
import time
import uuid
import webbrowser
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx

from agent.domain.models import Credential

# Each login registers a client under this id; the callback names the one issued.
DYNAMIC_CLIENT_ID = "dynamic_agent_client"
AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize"
TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token"
RESOURCE = "https://api.openai.com/v1"
CALLBACK_HOST = "127.0.0.1"
CALLBACK_PORT = 1455
CALLBACK_PATH = "/auth/callback"
REDIRECT_URI = f"http://{CALLBACK_HOST}:{CALLBACK_PORT}{CALLBACK_PATH}"
DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct"
SCOPE = f"openid profile email offline_access resource.invoke {DIRECT_TOKEN_SCOPE}"
REFRESH_BEFORE_SECONDS = 5 * 60
TOKEN_TIMEOUT_SECONDS = 15
SIGNED_IN_PAGE = "Signed in to ChatGPT. You can close this page and return to Rind."


async def login(interaction) -> Credential:
    verifier = _random()
    state = _random()
    callback: asyncio.Future[tuple[str, str]] = asyncio.get_running_loop().create_future()
    try:
        server = await asyncio.start_server(lambda reader, writer: _answer(reader, writer, state, callback), CALLBACK_HOST, CALLBACK_PORT)
    except OSError as exc:
        raise ValueError(f"Port {CALLBACK_PORT} is in use, probably by another unfinished sign-in or the Codex CLI. Finish or cancel it, then try again.") from exc
    url = _authorize_url(verifier, state)
    # Whichever comes first: the browser's callback (the prompt then closes by
    # itself) or a redirect URL pasted into it. The code is exchanged at once:
    # it expires quickly.
    interaction.notify({"type": "auth_url", "message": "Sign in with ChatGPT in your browser. If it did not open, visit: " + url})
    pasted = asyncio.ensure_future(interaction.prompt("text", "Waiting for your browser… or paste the redirect URL here"))
    try:
        await asyncio.to_thread(webbrowser.open, url)
        await asyncio.wait({pasted, callback}, return_when=asyncio.FIRST_COMPLETED)
        if callback.done():
            code, client_id = callback.result()
        elif answer := pasted.result().strip():
            code, client_id = _authorization(urlsplit(answer), state)
        else:
            raise ValueError("Login canceled.")
    finally:
        server.close()
        pasted.cancel()
    return await asyncio.to_thread(_exchange, code, client_id, verifier)


def expiring(credential: Credential) -> bool:
    return credential.expires_at is not None and credential.expires_at - time.time() <= REFRESH_BEFORE_SECONDS


def fresh(credential: Credential) -> Credential:
    """The credential, refreshed first when it is expiring."""
    if not expiring(credential):
        return credential
    return _token({"grant_type": "refresh_token", "client_id": credential.client_id, "refresh_token": credential.refresh, "resource": RESOURCE}, credential.client_id)


def _authorize_url(verifier: str, state: str) -> str:
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return AUTHORIZE_URL + "?" + urlencode({
        "client_id": DYNAMIC_CLIENT_ID, "agent_name_hint": "Rind", "ext_agent_host_id": f"urn:uuid:{_host_id()}",
        "response_type": "code", "redirect_uri": REDIRECT_URI, "resource": RESOURCE, "scope": SCOPE, "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256", "nonce": _random(),
    })


# OpenAI identifies each installation by a stable id; this one is derived from the machine.
def _host_id() -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"rind-host:{uuid.getnode()}"))


async def _answer(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, state: str, callback: asyncio.Future) -> None:
    try:
        target = (await reader.readline()).decode("latin-1").split(" ")[1:2]
        url = urlsplit(f"http://{CALLBACK_HOST}:{CALLBACK_PORT}" + (target[0] if target else "/"))
        if url.path != CALLBACK_PATH:
            status, page = "404 Not Found", "Not found."
        else:
            try:
                result = _authorization(url, state)
            except ValueError as exc:
                status, page = "400 Bad Request", str(exc)
            else:
                status, page = "200 OK", SIGNED_IN_PAGE
                if not callback.done():
                    callback.set_result(result)
        body = f"<!doctype html><meta charset=utf-8><title>Rind</title><p>{page}</p>".encode()
        writer.write(f"HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
        await writer.drain()
    finally:
        writer.close()


def _authorization(url, state: str) -> tuple[str, str]:
    """(code, issued client id) from the callback URL."""
    if f"{url.scheme}://{url.netloc}{url.path}" != REDIRECT_URI:
        raise ValueError(f"Paste the full redirect URL; it starts with {REDIRECT_URI}")
    query = {key: values[0] for key, values in parse_qs(url.query).items()}
    if query.get("error"):
        raise ValueError(f"ChatGPT sign-in failed: {query.get('error_description') or query['error']}")
    if query.get("state") != state:
        raise ValueError("That redirect belongs to another sign-in. Run /login again.")
    if not query.get("code") or not query.get("client_id"):
        raise ValueError("The redirect URL has no authorization code.")
    return query["code"], query["client_id"]


def _exchange(code: str, client_id: str, verifier: str) -> Credential:
    return _token({"grant_type": "authorization_code", "client_id": client_id, "code": code, "code_verifier": verifier, "redirect_uri": REDIRECT_URI, "resource": RESOURCE}, client_id)


def _token(form: dict[str, str], client_id: str) -> Credential:
    response = httpx.post(TOKEN_URL, data=form, headers={"Accept": "application/json"}, timeout=TOKEN_TIMEOUT_SECONDS)
    if response.status_code != 200:
        try:
            error = response.json()
            reason = str(error.get("error_description") or error.get("error") or "") if isinstance(error, dict) else ""
        except ValueError:
            reason = ""
        raise ValueError(f"ChatGPT sign-in failed ({response.status_code}{': ' + reason if reason else ''}). Run /login again.")
    token = response.json()
    if DIRECT_TOKEN_SCOPE not in str(token.get("scope") or "").split():
        raise ValueError("This ChatGPT account cannot use its subscription with Rind (no API access was granted).")
    return Credential(type="oauth", access=str(token["access_token"]), refresh=str(token["refresh_token"]),
                      expires_at=int(time.time() + float(token["expires_in"])), client_id=client_id)


def _random() -> str:
    return secrets.token_urlsafe(32)
