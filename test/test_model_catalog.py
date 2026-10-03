"""Catalog boundary and real-SDK contract checks; no external model calls."""
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import openai
import pytest

from agent.domain.models import ModelSelection
from agent.infrastructure.credentials import CredentialStore
from agent.infrastructure.llm import provider_service as module
from agent.infrastructure.llm.catalog import PROVIDERS
from agent.infrastructure.settings import AppSettings


@pytest.fixture
def service(tmp_path, monkeypatch):
    for provider in PROVIDERS.values():
        if provider.environment_key:
            monkeypatch.delenv(provider.environment_key, raising=False)
    settings = AppSettings(tmp_path / 'settings.json', True, 'LongCat-2.5-Preview', '', '', '', provider='longcat')
    monkeypatch.setattr(module, 'load_settings', lambda root=None: settings)
    return module.ProviderServiceImpl(CredentialStore(tmp_path / 'auth.json')), settings


@pytest.mark.parametrize('endpoint,cached,expected', [
    ('https://api.longcat.chat/openai/v1', None, 1048576),
    ('https://api.longcat.chat/openai/v1/', None, 1048576),
    ('https://proxy.example/v1', None, None),
    ('https://api.longcat.chat/openai/v1', 65536, 65536),
    ('https://api.longcat.chat/openai/v1', True, 1048576),
    ('https://api.longcat.chat/openai/v1', '65536', 1048576),
    ('https://api.longcat.chat/openai/v1', -1, 1048576),
])
@pytest.mark.asyncio
async def test_context_metadata_is_validated_and_endpoint_scoped(service, monkeypatch, endpoint, cached, expected):
    instance, settings = service
    from dataclasses import replace
    settings = replace(settings, base_url=endpoint, api_key='test')
    monkeypatch.setattr(module, 'load_settings', lambda root=None: settings)
    instance._write_cache({'longcat': {'base_url': endpoint, 'models': [
        {'id': settings.model, 'context_window': cached}]}})
    monkeypatch.setattr(module, 'build_async_client', lambda *a, **k: pytest.fail('Offline catalog read used network'))
    selected = instance.resolve_selection(None, ModelSelection('longcat', settings.model))
    listed = next(m for m in (await instance.list_models()).models if m.id == settings.model)
    assert listed.context_window == selected.context_window == expected


def test_custom_endpoint_does_not_inherit_legacy_or_other_host_context(service, monkeypatch):
    instance, settings = service
    from dataclasses import replace
    settings = replace(settings, base_url='https://proxy.example/v1')
    monkeypatch.setattr(module, 'load_settings', lambda root=None: settings)
    model = {'id': settings.model, 'context_window': 65536}
    for cached in ([model], {'base_url': 'https://other.example/v1', 'models': [model]}):
        instance._write_cache({'longcat': cached})
        assert instance.resolve_selection(None, ModelSelection('longcat', settings.model)).context_window is None


def test_compatible_endpoint_inherits_metadata_without_changing_api(service, monkeypatch):
    instance, settings = service
    from dataclasses import replace
    settings = replace(settings, provider='openai-compatible', base_url='https://api.longcat.chat/openai/v1')
    monkeypatch.setattr(module, 'load_settings', lambda root=None: settings)
    selected = instance.resolve_selection(None, ModelSelection('openai-compatible', settings.model))
    assert selected.provider_id == 'openai-compatible'
    assert selected.api == 'openai-chat'
    assert selected.image_input is True
    assert selected.context_window == 1048576


@pytest.mark.parametrize('provider,raw,expected', [
    ('openrouter', {'context_length': 123456}, 123456),
    ('mistral', {'max_context_length': 262144}, 262144),
    ('groq', {'context_window': 131072}, 131072),
    ('openai', {'context_length': 123456}, None),
    ('openrouter', {'context_length': True}, None),
    ('openrouter', {'context_length': 0}, None),
    ('openrouter', {'context_length': -1}, None),
    ('openrouter', {'context_length': '123456'}, None),
    ('groq', {'context_window': 131072.5}, None),
])
def test_remote_context_only_uses_verified_schema(provider, raw, expected):
    assert module._remote_context_window(raw, provider) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize('same_endpoint', [True, False])
async def test_context_refresh_merges_only_same_endpoint(service, monkeypatch, same_endpoint):
    instance, settings = service
    from dataclasses import replace
    settings = replace(settings, provider='openrouter', model='new', api_key='test', base_url='https://openrouter.ai/api/v1')
    monkeypatch.setattr(module, 'load_settings', lambda root=None: settings)
    instance._write_cache({'openrouter': {
        'base_url': settings.base_url if same_endpoint else 'https://other.example/v1',
        'models': [{'id': 'updated', 'context_window': 1}, {'id': 'keep', 'context_window': 2048}, {'id': 'removed'}],
    }})
    client = SimpleNamespace(models=SimpleNamespace(list=AsyncMock(return_value=SimpleNamespace(data=[
        {'id': 'updated', 'context_length': 128000}, {'id': 'keep'}, {'id': 'new', 'context_length': 32768},
    ]))), close=AsyncMock())
    monkeypatch.setattr(module, 'build_async_client', lambda *a, **k: client)
    await instance.list_models(refresh=True)
    cached = {m['id']: m for m in instance._read_cache()['openrouter']['models']}
    assert cached['updated']['context_window'] == 128000
    assert cached['new']['context_window'] == 32768
    assert cached['keep'].get('context_window') == (2048 if same_endpoint else None)
    assert 'removed' not in cached
    selected = instance.resolve_selection(None, ModelSelection('openrouter', 'new'))
    assert selected.context_window == 32768
    client.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_longcat_login_discovery_and_streamed_tool_round_trip(service, monkeypatch):
    instance, settings = service
    calls = []

    async def handle(request):
        assert request.headers['authorization'] == 'Bearer isolated-longcat-key'
        assert request.url.host == 'api.longcat.chat'
        if request.method == 'GET':
            assert request.url.path == '/openai/v1/models'
            return httpx.Response(200, json={'object': 'list', 'data': [
                {'id': 'LongCat-2.5-Preview', 'object': 'model', 'owned_by': 'LongCat'},
                {'id': 'LongCat-2.0', 'object': 'model', 'owned_by': 'LongCat'},
            ]})
        assert request.url.path == '/openai/v1/chat/completions'
        body = json.loads(request.content)
        calls.append(body)
        assert body['model'] == 'LongCat-2.5-Preview'
        assert 'reasoning_effort' not in body  # Also when inherited from a previous model.
        assert body['tools'][0]['function']['name'] == 'read_file'
        if body['stream']:
            chunks = [
                {'choices': [{'index': 0, 'delta': {'reasoning_content': 'Inspect the file.'}}]},
                {'choices': [{'index': 0, 'delta': {'tool_calls': [{'index': 0, 'id': 'call_1', 'type': 'function',
                    'function': {'name': 'read_file', 'arguments': '{"path":"note.txt"}'}}]}}]},
                {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}]},
                {'choices': [], 'usage': {'prompt_tokens': 8, 'completion_tokens': 4, 'total_tokens': 12}},
            ]
            content = ''.join('data: ' + json.dumps({'id': 'chatcmpl-qa', 'object': 'chat.completion.chunk',
                'created': 1, 'model': body['model'], **chunk}) + '\n\n' for chunk in chunks)
            return httpx.Response(200, text=content + 'data: [DONE]\n\n', headers={'content-type': 'text/event-stream'})
        assert body['messages'][-1] == {'role': 'tool', 'tool_call_id': 'call_1', 'content': 'fixture contents'}
        return httpx.Response(200, json={'id': 'chatcmpl-qa', 'object': 'chat.completion', 'created': 1,
            'model': body['model'], 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'Read complete.'},
            'finish_reason': 'stop'}]})

    def build(key, endpoint, **kwargs):
        return openai.AsyncOpenAI(api_key=key, base_url=endpoint, max_retries=0,
                                 http_client=httpx.AsyncClient(transport=httpx.MockTransport(handle)))

    monkeypatch.setattr(module, 'build_async_client', build)
    await instance.login(None, 'longcat', 'api_key', SimpleNamespace(prompt=AsyncMock(return_value='isolated-longcat-key')))
    assert instance.credentials.get('longcat').key == 'isolated-longcat-key'
    assert instance.credentials.get('openai') is None
    catalog = await instance.list_models()
    assert [(m.id, m.image_input, m.context_window, m.reasoning_efforts) for m in catalog.models] == [
        ('LongCat-2.5-Preview', True, 1048576, ()), ('LongCat-2.0', False, 1000000, ()),
    ]
    tools = [{'type': 'function', 'function': {'name': 'read_file', 'description': 'Read file',
              'parameters': {'type': 'object', 'properties': {'path': {'type': 'string'}}}}}]
    messages = [{'role': 'user', 'content': 'Read note.txt'}]
    client = await instance.create_chat_client(settings, ModelSelection('longcat', settings.model, 'high'), workspace_root=None)
    try:
        events = [event async for event in client.stream(messages, tools)]
        assert any(e.kind == 'reasoning_delta' and e.reasoning == 'Inspect the file.' for e in events)
        assert any(e.kind == 'tool_start' and e.tool_name == 'read_file' for e in events)
        assert any(e.kind == 'tool_arguments_delta' and e.arguments == '{"path":"note.txt"}' for e in events)
        messages.extend([
            {'role': 'assistant', 'content': '', 'tool_calls': [{'id': 'call_1', 'type': 'function',
                'function': {'name': 'read_file', 'arguments': '{"path":"note.txt"}'}}]},
            {'role': 'tool', 'tool_call_id': 'call_1', 'content': 'fixture contents'},
        ])
        result = await client.create(messages, tools, reasoning_effort='low')
        assert result.content == 'Read complete.'
    finally:
        await client.close()
    assert len(calls) == 2


def test_catalog_has_unique_ids_and_valid_metadata():
    for key, provider in PROVIDERS.items():
        assert key == provider.id
        assert len({m.id for m in provider.fallback_models}) == len(provider.fallback_models)
        for model in provider.fallback_models:
            assert model.provider_id == key and model.api == provider.api
            assert model.context_window is None or type(model.context_window) is int and model.context_window > 0
            assert model.image_input is None or type(model.image_input) is bool
            assert len(set(model.reasoning_efforts)) == len(model.reasoning_efforts)
