# `backend/inventory/postprocess.py` 精读(C 档·极详)⭐

## 这个文件在干嘛

**库存后处理 `LLMPostprocess`**:把模型识别出的物品(结构化 JSON)**解析成具体 SKU、查库存、组织成给
用户看的自然语言回复**。`hook_impl.postprocess_model_output` 在 intent 为 `query_inventory` 时调它的
`postprocess`,澄清意图时调 `clarify`。

> 这是库存链路的"最后一公里":意图识别 → 模型按结构化提示输出 items JSON → 本文件把每个 item 对应到
> SKU(DataFilter)→ 查库存(SQL)→ 拼成回复。

---

## 构造与连接

> **整块作用**:读 SQL 配置、拼连接串、建 embedding;若配置缺失标记 `_sql_set_error`。

```python
import json, re
import sqlalchemy
from loguru import logger
from sqlalchemy.exc import ArgumentError, SQLAlchemyError
from backend.agent.settings import SQLSettings
from backend.inventory.logicfunction import DataFilter, Pgvector
from backend.inventory.sql import SQL
from backend.llm.embedding import Embedding
from backend.utils.types import State

_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")   # 安全标识符


class LLMPostprocess:
    def __init__(self):
        self._sql_set = SQLSettings()
        self.connection_string = f"postgresql+psycopg://{self._sql_set.user}:{self._sql_set.password}@{self._sql_set.host}:{self._sql_set.port}/{self._sql_set.dbname}"
        #   拼 PostgreSQL 连接串。
        self.embedding = Embedding()
        #   向量化客户端(给 Pgvector 用)。
        self._sql_set_error = False
        if (self._sql_set.user is None or self._sql_set.password is None or self._sql_set.host is None
                or self._sql_set.port is None or self._sql_set.dbname is None):
            self._sql_set_error = True
            #   任一 SQL 配置缺失 → 标记错误(后续直接返回友好提示,不连库)。
```

---

## engine / 向量库

> **整块作用(get_engine)**:据配置建 engine(配置缺失返回 None)。

```python
    def get_engine(self) -> sqlalchemy.engine.Engine:
        if self._sql_set_error:
            logger.error("SQL settings are not configured")
            return None
        return sqlalchemy.create_engine(
            self.connection_string,
            connect_args={"connect_timeout": self._sql_set.connect_timeout},
            pool_timeout=self._sql_set.connect_timeout,
        )
        #   带连接超时的 engine。
```

> **整块作用(get_vector_db)**:确保 pgvector 扩展存在(可选清表),返回 (Pgvector, engine)。

```python
    def get_vector_db(self, table_name: str = "none", pre_delete_collection: bool = False) -> Pgvector | None:
        table_name = self._safe_identifier(table_name)
        #   表名安全校验。
        if self._sql_set_error:
            logger.error("SQL settings are not configured")
            return None
        timeout = self._sql_set.connect_timeout
        try:
            engine = sqlalchemy.create_engine(self.connection_string, connect_args={"connect_timeout": timeout}, pool_timeout=timeout)
            with engine.begin() as conn:
                conn.execute(sqlalchemy.text("CREATE EXTENSION IF NOT EXISTS vector"))
                #   确保 pgvector 扩展已装。
                if pre_delete_collection:
                    conn.execute(sqlalchemy.text(f"DROP TABLE IF EXISTS {table_name}"))
                    #   可选:先删旧表。
        except ArgumentError as e:
            logger.error("Invalid database URL or engine args: {}", e)
            return None
        except SQLAlchemyError as e:
            logger.error("Database error while creating engine or connecting: {}", e)
            return None
        return Pgvector(engine, self.embedding.embed_query), engine
        #   返回 (查询侧 Pgvector, engine)。注意返回的是元组(postprocess 解包用)。

    def _safe_identifier(self, value: str) -> str:
        if not _IDENTIFIER_RE.fullmatch(value):
            raise ValueError(f"unsafe SQL identifier: {value!r}")
        return value
```

---

## postprocess:核心 ⭐

> **整块作用**:把模型输出的 items 逐个解析成 SKU、查库存、拼成中文回复。无库连接则返回友好提示。

```python
    def postprocess(self, model_output: str | dict, state: State) -> str:  # noqa: C901
        pgvector, engine = self.get_vector_db()
        if pgvector is None:
            return "数据库连接失败，请稍后再试"
            #   没库 → 友好提示(不报错)。
        data_filter = DataFilter(pgvector)
        #   用向量库建 SKU 解析器。

        if isinstance(model_output, str):
            model_output = json.loads(model_output)
            #   字符串 → 解析成 dict(模型按结构化提示输出 JSON)。

        resolutions = [data_filter.resolve_sku(item) for item in model_output.get("items", [])]
        #   ⭐ 对每个识别出的物品,解析到具体 SKU(精确/模糊/向量融合)。

        sql = SQL()
        final_rendered = "您好！很高兴为您服务！\n"
        final_rendered += f"{model_output.get('summary')}\n"
        #   开头 + 图像/查询摘要。
        if model_output.get("unknowns"):
            final_rendered += f"{model_output.get('unknowns')}\n"
            #   无法识别的物品也提一下。

        if not resolutions:
            final_rendered += "帮您查询了数据库，未找到相关物品\n"
            #   没有任何可解析物品。
        for res in resolutions:
            item_norm = res.get("input_item")
            query = {key: item_norm[key] for key in item_norm if key != "confidence" and item_norm[key] not in [None, ""]}
            #   用非空字段作查询条件。
            if set(query) == {"name"}:
                #   只有名字(没规格等)→ 按 name 查库存。
                inventory_row = sql.query_inventory(query, engine)
                if inventory_row:
                    for row in inventory_row:
                        final_rendered += f"{row['name']}库存数量为: {row['total']} \n"
                        #   有结果 → 报库存数量。
                else:
                    final_rendered += f"{res['name']} 未找到库存\n"
            else:
                #   有更多字段 → 用解析出的最佳 SKU 的字段查。
                item_norm = res.get("top_candidate")
                query = {key: item_norm[key] for key in res.get("top_candidate")
                         if key in ["name", "spec", "brand", "material"] and item_norm[key] not in [None, ""]}
                if res.get("resolved"):
                    #   解析成功才查。
                    inventory_row = sql.query_inventory(query, engine)
                    if inventory_row:
                        for row in inventory_row:
                            final_rendered += f"{row['name']} {row['spec']} {row['brand']} {row['material']} 库存数量为: {row['total']} \n"
                            #   报完整规格 + 库存。
                else:
                    final_rendered += "帮您查询了数据库，未找到相关物品\n"
                    #   未解析。
        return final_rendered
        #   返回拼好的中文回复(hook_impl.postprocess_model_output 把它当最终输出)。
```

---

## clarify:澄清问题

> **整块作用**:意图为 clarify_* 时,直接返回模型给出的澄清问题。

```python
    def clarify(self, model_output: str, state: State) -> str:
        question = model_output.get("question")
        #   模型按结构化提示输出 {"intent":"clarify_*","question":"..."}。
        if question is None:
            return "无法确定用户意图，请重新输入"
            #   没给问题 → 兜底提示。
        return question
        #   返回澄清问题给用户。
```

---

## 怎么和别的文件连起来

- `hook_impl.postprocess_model_output`:intent=query_inventory 调 `postprocess`,clarify_* 调 `clarify`。
- `inventory/logicfunction.py`:`Pgvector`(向量检索)、`DataFilter.resolve_sku`(SKU 解析)。
- `inventory/sql.py`:`SQL.query_inventory`(按条件查库存数量)。
- `llm/embedding.py`:`Embedding`(向量化)。
- `agent/settings.py`:`SQLSettings`。

---

## 一句话总结

`postprocess.py` 是库存链路收尾:把模型识别的 items 经 `DataFilter` 解析到具体 SKU、用 `SQL` 查库存数量、
拼成中文回复;澄清意图则直接转述模型的澄清问题。无库连接时优雅降级为提示语。
