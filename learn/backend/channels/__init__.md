# `backend/channels/__init__.py` 精读(C 档·极详)

## 这个文件在干嘛

`channels` 子包入口,只做**再导出**:把渠道抽象 `Channel`、管理器 `ChannelManager`、消息结构
`ChannelMessage` 提到包顶层,方便外部 `from backend.channels import Channel/ChannelManager/ChannelMessage`。

> `channels/` 是"消息进出口层":定义渠道抽象 + 四个适配器(CLI/Web/Telegram/飞书)+ 管理器(把渠道
> 接进 turn 管线)。本文件是它的门面。

---

## 逐行精读

> **整块作用**:从子模块导入三大件并经 `__all__` 公开。

```python
from .base import Channel
#   渠道抽象基类(所有适配器继承它)。见 base.md。
from .manager import ChannelManager
#   渠道管理器:启动渠道、缓冲/分发入站、路由出站、管理任务生命周期。见 manager.md。
from .message import ChannelMessage
#   渠道与框架之间的结构化消息(入站/出站都用它)。见 message.md。

__all__ = ["Channel", "ChannelManager", "ChannelMessage"]
#   公开这三者(也控制 import *)。
```

---

## 一句话总结

门面文件:把 `Channel` / `ChannelManager` / `ChannelMessage` 上提到 `backend.channels` 顶层。
