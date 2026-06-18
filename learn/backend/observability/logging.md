# `backend/observability/logging.py` 精读(C 档·极详)

## 这个文件在干嘛

**生产级 loguru 日志配置**。一个幂等的 `setup_logging()`:配人类可读的控制台 sink + 轮转(可 JSON)的文件
sink、把第三方库的标准库 `logging` 路由进 loguru、脱敏明显的密钥、可选接入 logfire APM。还有
`disable_console_logging()` 给全屏 CLI TUI 关控制台日志(否则会冲乱界面)。

> CLAUDE.md / 本文 docstring 的关键分工:**应用诊断走 loguru;业务/审计事件留在 tape**。配置项用 `CREAMY_LOG_*`
> 环境变量(见 docs/logging.md)。`__main__`/`channels/cli` 都调它。

---

## 顶部:状态与脱敏正则

```python
"""Logging setup — production-grade loguru configuration. ...(见上)..."""
from __future__ import annotations
import contextlib, inspect, logging, os, re, sys
from pathlib import Path

_CONFIGURED = False                # 是否已配置(幂等用)
_CONSOLE_SINK_ID: int | None = None  # 控制台 sink 的 id(便于单独移除)
_SECRET_RE = re.compile(r"(sk-[A-Za-z0-9_\-]{6})[A-Za-z0-9_\-]+")
#   脱敏正则:匹配 "sk-" 开头的密钥,保留前 6 位、后面替换(见 _redact)。
```

---

## 把标准库 logging 路由进 loguru

> **整块作用**:一个 logging.Handler,把第三方库(langchain/httpx/telegram/sqlalchemy…)的标准日志转发到 loguru,
> 统一到同一套 sink。

```python
class InterceptHandler(logging.Handler):
    """Route standard-library ``logging`` records into loguru (unified sinks)."""
    def emit(self, record: logging.LogRecord) -> None:
        from loguru import logger
        try:
            level: str | int = logger.level(record.levelname).name
            #   把标准库级别名映射到 loguru 级别。
        except ValueError:
            level = record.levelno
            #   没有对应名 → 用数字级别。
        frame, depth = inspect.currentframe(), 0
        while frame and (depth == 0 or frame.f_code.co_filename == logging.__file__):
            frame = frame.f_back
            depth += 1
            #   回溯到真正发起日志的调用帧(跳过 logging 内部),让记录的 name/line 正确。
        logger.opt(depth=depth, exception=record.exc_info).log(level, record.getMessage())
        #   用 loguru 重新发出这条记录(带正确深度与异常信息)。
```

> **整块作用(_redact)**:loguru filter——对每条消息做密钥脱敏。

```python
def _redact(record) -> bool:
    record["message"] = _SECRET_RE.sub(r"\1…", record["message"])
    #   把 "sk-XXXXXX..." 替换成 "sk-XXXXXX…"(保留前 6 位,后面省略)。
    return True
    #   返回 True = 这条记录保留(filter 必须返回 bool)。
```

---

## setup_logging:核心配置(幂等)

> **整块作用**:据 CREAMY_LOG_* 读级别/目录/JSON 等;配控制台 sink(可被 TUI 关)+ 文件 sink(轮转/保留/压缩/
> 可 JSON);捕获第三方 logging;可选接 logfire。重复调用安全。

```python
def setup_logging(*, force: bool = False) -> None:
    """Configure loguru ... Idempotent ..."""
    global _CONFIGURED
    if _CONFIGURED and not force:
        return
        #   已配过且非强制 → 直接返回(幂等:CLI 入口与库使用都可能调)。

    from loguru import logger
    from backend.agent.settings import load_settings
    settings = load_settings()
    env = os.getenv

    console_level = (env("CREAMY_LOG_LEVEL") or {0: "WARNING", 1: "INFO"}.get(settings.verbose, "DEBUG")).upper()
    #   控制台级别:CREAMY_LOG_LEVEL 优先,否则按 settings.verbose(0→WARNING,1→INFO,其它→DEBUG)。
    file_level = env("CREAMY_LOG_FILE_LEVEL", "DEBUG").upper()
    #   文件级别(缺省 DEBUG,记更全)。
    log_dir = Path(env("CREAMY_LOG_DIR", str(settings.home / "logs"))).expanduser()
    #   日志目录(缺省 ~/.creamy/logs)。
    as_json = env("CREAMY_LOG_JSON", "0") == "1"
    #   文件是否 JSON 行(给 Loki/ELK 摄取)。
    diagnose = env("CREAMY_LOG_DIAGNOSE", "0") == "1"
    #   是否在 traceback 里展开变量值(生产关闭,避免泄露密钥/敏感值)。

    logger.remove()
    #   清掉 loguru 默认 sink(重新配)。
    logger.configure(extra={"run_id": "-", "session_id": "-", "channel": "-"})
    #   设默认 extra 字段(framework.contextualize 会覆盖成真实值,日志据此关联会话)。

    global _CONSOLE_SINK_ID
    _CONSOLE_SINK_ID = logger.add(
        sys.stderr, level=console_level, backtrace=False, diagnose=diagnose, filter=_redact,
        format=("<green>{time:HH:mm:ss}</green> <level>{level: <7}</level> "
                "<cyan>{extra[run_id]}</cyan> <dim>{name}:{line}</dim> {message}"),
    )
    #   控制台 sink:彩色、人类可读。记下 id —— 全屏 TUI 用 disable_console_logging 关它(否则冲乱界面)。

    log_dir.mkdir(parents=True, exist_ok=True)
    logger.add(
        log_dir / "creamy.log", level=file_level,
        rotation=env("CREAMY_LOG_ROTATION", "20 MB"),      # 超 20MB 轮转
        retention=env("CREAMY_LOG_RETENTION", "14 days"),  # 保留 14 天
        compression="zip",                                  # 旧日志压缩
        enqueue=True,                                        # 异步队列写(长服务不阻塞、多进程安全)
        backtrace=True, diagnose=diagnose, filter=_redact,
        serialize=as_json,                                  # JSON 行(便于日志系统摄取)
        format=("{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <7} | "
                "run={extra[run_id]} session={extra[session_id]} channel={extra[channel]} | "
                "{name}:{function}:{line} - {message}"),
    )
    #   文件 sink:轮转/保留/压缩 + 关联字段(run/session/channel)。

    logging.basicConfig(handlers=[InterceptHandler()], level=0, force=True)
    #   ⭐ 把标准库 logging 全量路由进 loguru(level=0 收全,force 覆盖已有配置)。
    for noisy in ("httpx", "httpcore", "urllib3", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
        #   把吵闹的库降到 WARNING(少刷屏)。

    try:
        import logfire
    except ImportError:
        pass
        #   没装 logfire → 跳过 APM。
    else:
        logfire.configure()
        logger.add(**logfire.loguru_handler())
        #   装了 → 额外加一个 logfire sink(与控制台/文件并存,不替换)。

    _CONFIGURED = True
    #   标记已配置。
```

---

## disable_console_logging:给 TUI 关控制台日志

> **整块作用**:移除 stderr 控制台 sink(保留文件日志)。全屏 CLI TUI 启动前调,防日志冲乱界面。幂等。

```python
def disable_console_logging() -> None:
    """Remove the stderr console sink, keeping file logging. ... Idempotent."""
    global _CONSOLE_SINK_ID
    if _CONSOLE_SINK_ID is None:
        return
        #   已移除/未配 → 无操作(幂等)。
    from loguru import logger
    with contextlib.suppress(ValueError):
        logger.remove(_CONSOLE_SINK_ID)
        #   按 id 移除控制台 sink(suppress:重复移除不报错)。
    _CONSOLE_SINK_ID = None


__all__ = ["InterceptHandler", "disable_console_logging", "setup_logging"]
```
- `channels/cli._run_tui` 开头就调 `disable_console_logging()`——这正是它的用途。

---

## 怎么和别的文件连起来

- `backend/__main__.py`:启动第一步 `setup_logging()`。
- `channels/cli.py`:全屏 TUI 调 `disable_console_logging()`。
- `app/framework.py`:`logger.contextualize(session_id, channel)` 填充这里配的 extra 字段。
- `agent/settings.py`:`verbose` 决定默认控制台级别。

---

## 一句话总结

`logging.py` 是统一的可观测性配置:幂等 `setup_logging` 配彩色控制台 + 轮转文件(可 JSON)双 sink、把第三方
标准库日志并入 loguru、脱敏密钥、可选 logfire;`disable_console_logging` 让全屏 TUI 不被日志干扰。诊断走
loguru,业务/审计留 tape。
