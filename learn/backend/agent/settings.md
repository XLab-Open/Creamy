# `backend/agent/settings.py` 精读(C 档·极详)

## 这个文件在干嘛

集中定义所有**运行时配置**(pydantic-settings)。核心是 `AgentSettings`(模型/密钥/步数/home 等),
外加各渠道/SQL/embedding 的设置类。配置来源优先级:**构造参数 > 环境变量 > .env > `~/.creamy/config.yml`**。

> 关键约定(CLAUDE.md):配置走 `CREAMY_*` 环境变量,如 `CREAMY_MODEL`(`provider:model`)、
> `CREAMY_API_KEY`、`CREAMY_HOME`(默认 `~/.creamy`)。本文件就是这些变量的"定义处"。
> `framework.py` 顶层 `load_dotenv()` 让 `.env` 生效后,这里读取。

---

## 顶部:常量

> **整块作用**:导入 + 默认值常量(模型、token 上限、home 目录、配置文件路径)。

```python
from __future__ import annotations
import os
#   读环境变量、展开 ~ 和 $VAR。
import pathlib
#   路径类型与 home 目录。
import re
#   provider_specific 用正则匹配 CREAMY_<PROVIDER>_API_KEY 这类变量。
from collections.abc import Callable
#   provider_specific 返回一个工厂函数,类型用 Callable。
from functools import lru_cache
#   load_settings 缓存单例。
from typing import Any, Literal
#   Any:client_args 等;Literal:api_format 限定取值。

from pydantic import Field, field_validator
#   Field:声明字段(默认/描述/校验);field_validator:给 home 字段加展开逻辑。
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict, YamlConfigSettingsSource
#   pydantic-settings:从环境/.env/YAML 自动装配配置的库。

DEFAULT_MODEL = "openrouter:qwen/qwen3-coder-next"
#   缺省模型(provider:model 形式)。可被 CREAMY_MODEL 覆盖。
DEFAULT_MAX_TOKENS = 1024
#   缺省单次最大生成 token 数。
DEFAULT_HOME = pathlib.Path.home() / ".creamy"
#   缺省 home 目录:~/.creamy(tapes、日志、config.yml、插件项目都在它下面)。
DEFAULT_CONFIG_FILE = DEFAULT_HOME / "config.yml"
#   缺省 YAML 配置文件路径。
```

---

## `provider_specific`:按提供商拆分的配置工厂

> **整块作用**:支持"每个模型提供商一套配置"。它返回一个工厂函数,扫描形如
> `CREAMY_<PROVIDER>_API_KEY` 的环境变量,聚成 `{provider: value}` 字典。用作 api_key/api_base 的默认值。

```python
def provider_specific(setting_name: str) -> Callable[[], dict[str, str] | None]:
    def default_factory() -> dict[str, str] | None:
        setting_regex = re.compile(rf"^CREAMY_(.+)_{setting_name.upper()}$")
        #   构造正则:匹配 CREAMY_<任意提供商>_<SETTING>(如 CREAMY_OPENAI_API_KEY)。
        loaded_env = os.environ
        #   当前环境变量。
        result: dict[str, str] = {}
        for key, value in loaded_env.items():
            if value is None:
                continue
                #   跳过空值。
            if match := setting_regex.match(key):
                #   命中"按提供商"的变量,
                provider = match.group(1).lower()
                #   取出提供商名(小写)。
                result[provider] = value
                #   记进字典。
        return result or None
        #   有就返回 {provider: value},没有就 None(让上层回落到全局单值配置)。
    return default_factory
    #   返回这个工厂(作为 Field 的 default_factory)。
```

- **意义**:你可以全局配一个 `CREAMY_API_KEY`,也可以按提供商配 `CREAMY_OPENAI_API_KEY` /
  `CREAMY_OPENROUTER_API_KEY`,两种都支持。

---

## `SQLSettings`:库存查询的数据库配置

> **整块作用**:库存子系统连数据库用的配置,前缀 `CREAMY_SQL_`,从 `.env` 读。

```python
class SQLSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CREAMY_SQL_", extra="ignore", env_file=".env")
    #   env_prefix:字段从 CREAMY_SQL_* 读;extra="ignore":多余变量忽略;env_file 指定 .env。
    host: str = Field(default="", description="host.")            # 数据库主机
    port: str = Field(default="", description="port.")            # 端口
    user: str = Field(default="", description="user.")            # 用户
    password: str = Field(default="", description="password.")    # 密码
    dbname: str = Field(default="", description="dbname.")        # 库名
    connect_timeout: int = Field(default=10, description="TCP connect timeout in seconds.")  # 连接超时(秒)
```

---

## `AgentSettings`:核心配置 ⭐

> **整块作用**:agent 的主配置。前缀 `CREAMY_`,字段覆盖模型、密钥、API 形态、步数、超时、详细度等。
> 还自定义了配置来源顺序(加入 YAML)与 home 路径展开。

```python
class AgentSettings(BaseSettings):
    """Configuration settings for the Agent."""

    model_config = SettingsConfigDict(env_prefix="CREAMY_", env_parse_none_str="null", extra="ignore")
    #   前缀 CREAMY_;env_parse_none_str="null":环境里写 "null" 视为 None;忽略多余字段。
    home: pathlib.Path = Field(default=DEFAULT_HOME)
    #   home 目录(CREAMY_HOME)。tapes/日志/插件项目的根。
    model: str = DEFAULT_MODEL
    #   主模型(CREAMY_MODEL,provider:model)。
    fallback_models: list[str] | None = None
    #   备用模型列表(主模型失败时回退)。
    api_key: str | dict[str, str] | None = Field(default_factory=provider_specific("api_key"))
    #   API key:可为单值,或按提供商的 {provider: key} 字典(默认工厂扫 CREAMY_<P>_API_KEY)。
    api_base: str | dict[str, str] | None = Field(default_factory=provider_specific("api_base"))
    #   API base URL:同上,支持按提供商。
    api_format: Literal["completion", "responses", "messages"] = "completion"
    #   接口形态:OpenAI completion / responses / Anthropic messages。
    max_steps: int = 50
    #   agent 循环最大步数(防死循环;_agent_loop 用它)。
    max_tokens: int = DEFAULT_MAX_TOKENS
    #   单次最大生成 token。
    model_timeout_seconds: int | None = None
    #   单次模型调用超时(_run_once 用 asyncio.timeout 包住);None=不限。
    client_args: dict[str, Any] | None = None
    #   透传给底层模型客户端的额外参数。
    verbose: int = Field(default=0, description="Verbosity level for logging. Higher means more verbose.", ge=0, le=2)
    #   日志详细度 0~2(ge/le 约束范围)。

    @field_validator("home")
    @classmethod
    def _expand_home(cls, value: pathlib.Path) -> pathlib.Path:
        # Expand "~" (and env vars) ...
        return pathlib.Path(os.path.expanduser(os.path.expandvars(str(value))))
        #   校验器:把 home 里的 ~ 和 $VAR 展开成真实绝对路径,
        #   确保由 home 派生的 tapes/logs/plugins/history/config.yml 都指向正确目录。
```

> **整块作用(settings_customise_sources)**:自定义"配置来源优先级",插入 YAML 文件源。

```python
    @classmethod
    def settings_customise_sources(cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings):
        home = os.path.expanduser(os.getenv("CREAMY_HOME", str(DEFAULT_HOME)))
        #   先确定 home(因为 YAML 路径基于它)。直接读 env,避免"鸡生蛋"(此时 settings 还没建好)。
        return (
            init_settings,       # ① 构造时显式传的参数(最高优先)
            env_settings,        # ② 环境变量
            dotenv_settings,     # ③ .env 文件
            YamlConfigSettingsSource(settings_cls, yaml_file=pathlib.Path(home) / "config.yml"),  # ④ ~/.creamy/config.yml
            file_secret_settings,# ⑤ 密钥文件(最低)
        )
        #   pydantic-settings 按此元组顺序取值:靠前者覆盖靠后者。
```

- **优先级链**:`构造参数 > 环境变量 > .env > config.yml > secret 文件`。这让用户既能临时用环境变量
  覆盖,也能在 `~/.creamy/config.yml` 持久化默认。

---

## 各渠道 / embedding / 全局渠道设置

> **整块作用**:飞书、Telegram、embedding、以及通用渠道行为(去抖、流式开关等)的配置类。每类一个前缀。

```python
class FeishuSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CREAMY_FEISHU_", extra="ignore", env_file=".env")
    app_id: str = Field(default="", description="Feishu app id.")          # 飞书 app id
    app_secret: str = Field(default="", description="Feishu app secret.")  # 飞书 app secret
    base_url: str = Field(default="https://open.feishu.cn", description="Feishu OpenAPI base URL.")  # OpenAPI 基址
    allow_users: str | None = Field(default=None, description="...allowed Feishu sender open_ids.")  # 白名单用户
    allow_chats: str | None = Field(default=None, description="...allowed Feishu chat_ids.")          # 白名单群

class TelegramSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CREAMY_TELEGRAM_", extra="ignore", env_file=".env")
    token: str = Field(default="", description="Telegram bot token.")      # 机器人 token
    allow_users: str | None = Field(default=None, description="...allowed Telegram user IDs...")   # 白名单用户
    allow_chats: str | None = Field(default=None, description="...allowed Telegram chat IDs...")   # 白名单群
    proxy: str | None = Field(default=None, description="Optional proxy URL ...")                   # 可选代理

class EmbeddingSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CREAMY_Embedding_", extra="ignore", env_file=".env")
    model_name: str = Field(default="", description="model name.")          # embedding 模型名(意图识别用)
    api_key: str = Field(default="", description="api key.")                # embedding api key

class ChannelSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CREAMY_", extra="ignore", env_file=".env")
    enabled_channels: str = Field(default="all", description="...enabled channels, or 'all'...")    # 启用哪些渠道
    debounce_seconds: float = Field(default=1.0, description="...between processing two messages...")  # 去抖间隔
    max_wait_seconds: float = Field(default=10.0, description="Maximum seconds to wait ...")        # 最大等待
    active_time_window: float = Field(default=60.0, description="Time window ... active ...")       # 活跃窗口
    stream_output: bool = Field(default=False, description="Whether to stream model output ...")    # 是否流式输出
```

- `ChannelSettings.stream_output` 就是决定 `process_inbound(stream_output=...)` 的来源之一;
  渠道管理器用 `debounce_seconds`/`max_wait_seconds` 做节流(见 [`../channels/manager.md`](../channels/manager.md))。

---

## `load_settings`:单例

> **整块作用**:用 lru_cache 缓存,保证全进程只构造一次 AgentSettings(避免反复读环境/文件)。

```python
@lru_cache(maxsize=1)
def load_settings() -> AgentSettings:
    return AgentSettings()
    #   首次调用构造并缓存;之后都返回同一个实例。Agent.__init__ 调它。
```

---

## 一句话总结

`settings.py` 是配置中枢:`AgentSettings` 定义核心运行参数并约定"构造>env>.env>YAML>secret"的来源
优先级;按提供商拆分密钥、各渠道独立配置;`load_settings()` 提供全局单例。
