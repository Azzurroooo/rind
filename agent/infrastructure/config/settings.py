"""配置模块"""
from openai import OpenAI, AsyncOpenAI

from .settings_loader import AppSettings, ensure_user_settings_template, load_settings, save_settings_patch


_SETTINGS = load_settings()


class Config:
    SETTINGS: AppSettings = _SETTINGS
    SETTINGS_PATH = str(_SETTINGS.settings_path)
    SETTINGS_EXISTS = _SETTINGS.settings_exists
    OPENAI_API_KEY = _SETTINGS.api_key
    OPENAI_API_BASE = _SETTINGS.base_url
    OPENAI_USER_AGENT = _SETTINGS.user_agent
    DEFAULT_MODEL = _SETTINGS.model
    MODEL_REASONING_EFFORT = _SETTINGS.reasoning_effort
    TEMPERATURE = 0.7
    MAX_TOKENS = 2000

    @classmethod
    def validate(cls):
        if not cls.OPENAI_API_KEY:
            raise ValueError(f"OpenAI apiKey is required. Create {cls.SETTINGS_PATH} or set OPENAI_API_KEY.")
        return True

    @classmethod
    def ensure_user_settings_template(cls):
        return ensure_user_settings_template()

    @classmethod
    def reload(cls) -> AppSettings:
        settings = load_settings()
        cls.SETTINGS = settings
        cls.SETTINGS_PATH = str(settings.settings_path)
        cls.SETTINGS_EXISTS = settings.settings_exists
        cls.OPENAI_API_KEY = settings.api_key
        cls.OPENAI_API_BASE = settings.base_url
        cls.OPENAI_USER_AGENT = settings.user_agent
        cls.DEFAULT_MODEL = settings.model
        cls.MODEL_REASONING_EFFORT = settings.reasoning_effort
        return settings

    @classmethod
    def set_model(cls, model: str) -> AppSettings:
        clean = str(model or "").strip()
        if not clean:
            raise ValueError("Model name is required.")
        save_settings_patch({"model": clean})
        return cls.reload()

    @classmethod
    def get_client(cls) -> OpenAI:
        return OpenAI(
            api_key=cls.OPENAI_API_KEY,
            base_url=cls.OPENAI_API_BASE,
            default_headers=cls._default_headers(),
        )

    @classmethod
    def get_async_client(cls) -> AsyncOpenAI:
        return AsyncOpenAI(
            api_key=cls.OPENAI_API_KEY,
            base_url=cls.OPENAI_API_BASE,
            default_headers=cls._default_headers(),
        )

    @classmethod
    def _default_headers(cls) -> dict[str, str] | None:
        if not cls.OPENAI_USER_AGENT:
            return None
        return {"User-Agent": cls.OPENAI_USER_AGENT}
