# Creamy 后端代码精读(learn/backend)

这是对 `backend/` 下所有代码文件的**逐文件精读**。每个源文件对应一篇同名 `.md`
(如 `backend/channels/web.py` → `learn/backend/channels/web.md`),目录结构与
`backend/` 完全镜像。

注释风格:**以"贴代码块 + 逐块详解"为主(B 模式),再补充该文件在 Creamy
架构中的角色、设计意图、与其它模块的协作(A 模式)**。不是逐行翻译语法,而是
讲"为什么这么写、它怎么接进整条 turn 管线"。

> 源码不动:所有讲解都在本目录的 `.md` 里,`backend/*.py` 保持原样。

---

## 一、Creamy 是什么(一句话)

一个**hook 优先**的 AI agent 框架:不管消息从哪个渠道(CLI / Telegram / 飞书 /
Web)进来,都走**同一条 pluggy 插件管线**跑一个 turn。框架核心极小,出厂行为
都是"默认插件";要改某一环,**覆盖那个 hook 即可,永远不用 fork 内核**。

发行名是 `creamy`,但可导入的包名是 **`backend`**(`import backend`)。控制台命令
`creamy = backend.__main__:app`。

---

## 二、最重要的一条主线:turn 管线

一次消息处理(`CreamyFramework.process_inbound`)依次经过这些 hook 点:

```
resolve_session → load_state → build_prompt → run_model(_stream)
                → save_state → intent_detection → postprocess_model_output
                → render_outbound → dispatch_outbound
```

- **契约**在 `hooks/hookspecs.py`(`CreamyHookSpecs`)——只定义"有哪些 hook、
  签名是什么"。
- **出厂实现**在 `hooks/hook_impl.py`(`BuiltinImpl`)——所有默认行为都在这。
- **运行时**在 `app/framework.py`(`CreamyFramework`)+ `hooks/hook_runtime.py`
  (`HookRuntime`,安全派发、异步/同步、firstresult 语义)。
- **插件优先级:后注册者胜**。内置先注册(`name="builtin"`),再加载
  `creamy` entry-point 组里的外部插件;`firstresult=True` 的 hook 取第一个非 None。

`firstresult=True`(取第一个非空结果)的 hook:`resolve_session`、`load_state`、
`build_prompt`、`run_model` / `run_model_stream`、`provide_tape_store`、
`build_tape_context`。其余是"广播型"(收集所有实现的结果)。

> `run_model` 与 `run_model_stream` **二选一**实现,不要同时实现。

---

## 三、推荐阅读顺序

按"先骨架、后血肉"的顺序读,效率最高:

1. **架构契约核心**(必读,先读这三块就懂全局)
   - [`hooks/hookspecs.md`](hooks/hookspecs.md) — hook 契约(地图)
   - [`app/framework.md`](app/framework.md) — turn 管线驱动
   - [`hooks/hook_impl.md`](hooks/hook_impl.md) — 默认行为全集
   - [`hooks/hook_runtime.md`](hooks/hook_runtime.md) — hook 安全派发
   - 包入口:[`__init__.md`](__init__.md)、[`__main__.md`](__main__.md)、[`_version.md`](_version.md)

2. **类型与引擎基座** [`core/`](core/)
   - events / store / tape_types / tools / engine / errors

3. **agent 装配** [`agent/`](agent/) — agent.py 是真正"跑模型 + 工具循环"的地方

4. **渠道层** [`channels/`](channels/) — base/message/manager/handler + 四个适配器
   (cli / web / telegram / feishu)+ renderer

5. **模型层** [`llm/`](llm/) — client / graph / messages / embedding

6. **状态与上下文** [`memory/`](memory/)、[`context/`](context/)

7. **工具** [`tools/`](tools/) — tools / toolimpl + filetool / shelltool / channeltool

8. **库存子系统** [`inventory/`](inventory/) — 意图识别 + SQL/向量查询 + 后处理

9. **收尾** [`skills/`](skills/)、[`cli/`](cli/)、[`observability/`](observability/)、[`utils/`](utils/)

---

## 四、目录速览

| 目录 | 职责 |
| --- | --- |
| `app/` | 框架运行时 `CreamyFramework`(turn 管线) |
| `hooks/` | hook 契约 + 默认实现 + 派发运行时 |
| `core/` | 引擎、事件流、tape 存储抽象、工具抽象、错误、类型 |
| `agent/` | Agent(模型+工具循环)、设置、鉴权(codex OAuth) |
| `channels/` | 渠道抽象 + CLI/Web/Telegram/飞书适配器 + 渲染 |
| `llm/` | 模型客户端、对话图、消息结构、embedding |
| `memory/` | tape 存储实现(FileTapeStore 等) |
| `context/` | tape 上下文构建 |
| `tools/` | 工具注册与实现(文件/shell/渠道工具) |
| `inventory/` | 库存查询子系统(意图打分、SQL、向量) |
| `skills/` | 技能(SKILL.md)发现与加载 |
| `cli/` | `creamy` 各子命令实现(run/cli/web/gateway/login/install…) |
| `observability/` | 日志配置 |
| `utils/` | Envelope 取值、类型别名、杂项工具 |

> 注:空的 `__init__.py` 与 `skills/*/scripts/*`(技能附带脚本,mypy 都排除)
> 不单独成篇。

---

## 五、几个贯穿全局的概念

- **Envelope**:消息的统一载体(入站/出站都是它)。框架不假设具体类型,用
  `utils/envelope.py` 的 `field_of` / `content_of` 防御式取值,既能吃 dict 也能吃
  `ChannelMessage`。
- **session_id**:一次会话的主键(默认 `channel:chat_id`),贯穿状态、tape、流式
  路由。
- **tape**:会话状态/历史的记录载体(`core/store.py` 抽象,`memory/store.py`
  实现),`provide_tape_store` 提供后端。
- **stream events**:`core/events.py` 定义流式事件(text/error/...),流式模型输出
  与渠道回灌都靠它。
