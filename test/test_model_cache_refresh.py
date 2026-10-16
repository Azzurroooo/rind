import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from agent.domain.models import Credential
from agent.infrastructure.credentials import CredentialStore
from agent.infrastructure.llm import provider_service as module
from agent.infrastructure.settings import AppSettings
from agent.runtime.server.worker import RuntimeWorker


@pytest.fixture
def service(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    settings = AppSettings(tmp_path / "settings.json", True, "deepseek-chat", "", "", "", provider="deepseek")
    monkeypatch.setattr(module, "load_settings", lambda: settings)
    monkeypatch.setattr(module.time, "time", lambda: 200000)
    instance = module.ProviderServiceImpl(CredentialStore(tmp_path / "auth.json"))
    instance.credentials.set("deepseek", Credential(type="api_key", key="key"))
    return instance


def entry(service, timestamp=200000, provider="deepseek"):
    return {"models": [{"id": "saved"}], "refreshed_at": timestamp,
            "base_url": service.providers[provider].default_base_url}


@pytest.mark.asyncio
@pytest.mark.parametrize("cached,expected", [(None, True), ([], True), ([{"id": "legacy"}], True),
                                           (113601, False), (113600, True), (200000, False)])
async def test_stale_boundary(service, monkeypatch, cached, expected):
    if cached is not None:
        service._write_cache({"deepseek": entry(service, cached) if isinstance(cached, int) else cached})
    fetch = AsyncMock(return_value=True)
    monkeypatch.setattr(service, "_fetch_models", fetch)
    await service.list_models()
    fetch.assert_not_called()
    await service.refresh_stale_models()
    assert fetch.await_count == int(expected)


@pytest.mark.asyncio
async def test_each_provider_and_supported_api(service, monkeypatch):
    for provider in ("openai", "google"):
        service.credentials.set(provider, Credential(type="api_key", key="stored"))
    service._write_cache({"deepseek": entry(service), "openai": entry(service, 1, "openai")})
    fetch = AsyncMock(return_value=True)
    monkeypatch.setattr(service, "_fetch_models", fetch)
    await service.refresh_stale_models()
    assert [call.args[0].id for call in fetch.await_args_list] == ["openai"]


@pytest.mark.asyncio
async def test_missing_environment_reference_and_unsupported_custom_api(service, monkeypatch):
    import json
    service.credentials.delete("deepseek")
    service.providers_path.write_text(json.dumps({
        "providers": {
            "custom-anthropic": {
                "api": "anthropic-messages",
                "baseUrl": "https://local.example/v1",
                "envKey": "ABSENT_MODEL_TEST_KEY",
            }
        }
    }), encoding="utf-8")
    monkeypatch.delenv("ABSENT_MODEL_TEST_KEY", raising=False)
    fetch = AsyncMock(return_value=True)
    monkeypatch.setattr(service, "_fetch_models", fetch)
    await service.refresh_stale_models()
    service.credentials.set("custom-anthropic", Credential(type="api_key", key="stored"))
    await service.refresh_stale_models()
    fetch.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("result", ["success", "error", "timeout", "empty", "invalid"])
async def test_fetch_preserves_or_upgrades_cache(service, monkeypatch, result):
    original = {"deepseek": [{"id": "legacy"}]}
    service._write_cache(original)
    async def listing(**kwargs):
        assert kwargs == {"timeout": 10}
        if result == "error":
            raise RuntimeError("secret must not be logged")
        if result == "timeout":
            await asyncio.Event().wait()
        return SimpleNamespace(data={"success": [{"id": "new"}], "empty": [], "invalid": [{}]}[result])
    client = SimpleNamespace(models=SimpleNamespace(list=listing), close=AsyncMock())
    build = Mock(return_value=client)
    monkeypatch.setattr(module, "build_async_client", build)
    if result == "timeout":
        # Keep the request argument at ten seconds, shorten only the outer deadline.
        timeout = asyncio.timeout
        monkeypatch.setattr(module.asyncio, "timeout", lambda seconds: timeout(0.001))
    await service.refresh_stale_models()
    build.assert_called_once_with("key", service.providers["deepseek"].default_base_url, max_retries=0)
    client.close.assert_awaited_once()
    cached = service._read_cache()
    if result == "success":
        assert cached["deepseek"] == dict(entry(service), models=[{"id": "new"}])
        assert "new" in [model.id for model in (await service.list_models()).models]
    else:
        assert cached == original


@pytest.mark.asyncio
async def test_endpoint_mismatch_is_hidden_and_refreshed(service, monkeypatch):
    service._write_cache({"deepseek": dict(entry(service), base_url="https://other.example/v1")})
    assert "saved" not in [model.id for model in (await service.list_models()).models]
    fetch = AsyncMock(return_value=True)
    monkeypatch.setattr(service, "_fetch_models", fetch)
    await service.refresh_stale_models()
    fetch.assert_awaited_once()


@pytest.mark.asyncio
async def test_explicit_refresh_and_login_ignore_fresh_timestamp(service, monkeypatch):
    service._write_cache({"deepseek": entry(service)})
    fetch = AsyncMock(return_value=True)
    monkeypatch.setattr(service, "_fetch_models", fetch)
    await service.list_models(refresh=True)
    await service.login("deepseek", "api_key", SimpleNamespace(prompt=AsyncMock(return_value="new-key")))
    assert fetch.await_count == 2


@pytest.mark.asyncio
async def test_worker_startup_does_not_wait_and_shutdown_reclaims_request(service, tmp_path, monkeypatch):
    service._write_cache({"deepseek": [{"id": "saved"}]})
    started = asyncio.Event()
    cancelled = asyncio.Event()
    async def listing(**kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
    client = SimpleNamespace(models=SimpleNamespace(list=listing), close=AsyncMock())
    build = Mock(return_value=client)
    monkeypatch.setattr(module, "build_async_client", build)
    worker = RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"))
    worker.provider_service = service
    before = asyncio.all_tasks()
    try:
        info = await asyncio.wait_for(worker.initialize(), 2)
        await asyncio.wait_for(started.wait(), 2)
        task = worker._model_refresh_task
        assert (await worker.initialize())["session_id"] == info["session_id"]
        assert worker._model_refresh_task is task
        models = (await worker.list_models())["models"]
        assert "saved" in [model["id"] for model in models]
        assert all("name" not in model for model in models)
    finally:
        await asyncio.wait_for(worker.close(), 2)
    assert task.done()
    assert cancelled.is_set()
    client.close.assert_awaited_once()
    build.assert_called_once()
    assert asyncio.all_tasks() == before
