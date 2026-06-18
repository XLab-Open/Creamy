# `backend/inventory/logicfunction.py` 精读(C 档·极详)⭐

## 这个文件在干嘛

库存系统的**核心算法层**,三块:
1. **意图向量信号**(`_inventory_embedding_signal` 等):把用户文本与"库存意图原型"算余弦相似度——
   就是 `hook_impl.intent_detection` 的"信号③"。
2. **`Pgvector`**(查询侧向量检索):自写 SQL 在 pgvector 表里做相似度搜索(替代 LangChain PGVector)。
3. **`DataFilter`**(SKU 解析):把模型识别出的物品(name/spec/...)通过"精确 + 模糊 + 向量"候选融合
   打分,解析到具体 SKU。

> `postprocess.LLMPostprocess` 用 `Pgvector` + `DataFilter` 把"图里/话里说的物品"对应到库里的 SKU,再查库存。

---

## 顶部:导入与安全标识符

```python
import math, re
from collections.abc import Callable, Mapping, Sequence
from difflib import SequenceMatcher   # 字符串相似度(模糊匹配)
from typing import Any, Protocol
from loguru import logger
from sqlalchemy import MetaData, text
from backend.inventory.sqlconstant import _INVENTORY_INTENT_PROTOTYPES   # 意图原型短语
from backend.llm.embedding import Embedding                              # 向量化客户端

_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
#   合法 SQL 标识符(列名/表名)正则——防 SQL 注入。


class VectorSkuStore(Protocol):
    def similarity_search_with_score(self, query, k=5, use_rule=False) -> list[tuple[dict[str, Any], float]]: ...
    #   "向量 SKU 库"的接口协议(Pgvector 实现它;DataFilter 依赖这个协议)。


def _safe_identifier(value: str) -> str:
    if not _IDENTIFIER_RE.fullmatch(value):
        raise ValueError(f"unsafe SQL identifier: {value!r}")
    return value
    #   校验标识符安全(只允许字母/数字/下划线开头),否则拒绝——拼 SQL 前必过这关。
```

---

## 向量小工具

> **整块作用**:把向量转 SQL 字面量;从 str/dict 查询取文本;取查询涉及的列;余弦相似度。

```python
def _vector_literal(vector: Sequence[float]) -> str:
    return "[" + ",".join(str(float(value)) for value in vector) + "]"
    #   向量 → "[0.1,0.2,...]" 字符串(pgvector 的字面量格式)。

def _query_text(query: str | Mapping[str, Any]) -> str:
    if isinstance(query, str):
        return query
    return " ".join(str(value).strip() for value in query.values() if str(value).strip())
    #   查询是 dict(如 {name,spec})→ 把各值拼成一段文本(用于嵌入)。

def _query_columns(query: str | Mapping[str, Any], fallback: Sequence[str]) -> list[str]:
    if isinstance(query, str):
        return [_safe_identifier(column) for column in fallback]
        #   字符串查询 → 用默认返回列。
    columns = ["sku_id"]
    for key in query:
        column = _safe_identifier(str(key).removesuffix("_norm"))   # 去掉 _norm 后缀
        if column not in columns:
            columns.append(column)
    return columns
    #   dict 查询 → 返回列 = sku_id + 查询涉及的字段(都过安全校验)。

def _cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
        #   维度不匹配/空 → 0。
    dot = 0.0; sum_l = 0.0; sum_r = 0.0
    for a, b in zip(left, right, strict=True):
        dot += a * b          # 点积
        sum_l += a * a        # 左模平方
        sum_r += b * b        # 右模平方
    denom = math.sqrt(sum_l) * math.sqrt(sum_r)
    if denom <= 0.0:
        return 0.0
    return dot / denom        # cos = 点积 / (模乘积)
```

---

## 意图向量信号(信号③)

> **整块作用(_ensure_inventory_prototype_embeddings)**:确保"库存意图原型"的向量已就绪(懒嵌入、缓存)。

```python
def _ensure_inventory_prototype_embeddings(inventory_proto_embeddings, intent_embedding_client):
    if inventory_proto_embeddings is not None:
        return inventory_proto_embeddings
        #   已有缓存 → 直接用。
    if intent_embedding_client is None:
        try:
            intent_embedding_client = Embedding()
            #   没客户端就建一个(读 CREAMY_Embedding_* 配置)。
        except Exception as exc:
            logger.debug("intent embedding client unavailable: {}", exc)
            return None
            #   建不出(没配)→ None(信号不可用)。
    try:
        inventory_proto_embeddings = intent_embedding_client.embed_documents(list(_INVENTORY_INTENT_PROTOTYPES))
        #   把所有原型短语嵌成向量。
    except Exception as exc:
        logger.warning("failed to embed inventory intent prototypes: {}", exc)
        inventory_proto_embeddings = None
        return None
    return inventory_proto_embeddings, intent_embedding_client
    #   ⚠️ 注意:成功分支返回的是元组(protos, client),失败分支返回 None——调用方需处理两种形态。
```

> **整块作用(_inventory_embedding_signal)**:返回(用户文本与原型的最大相似度, 信号是否可用)。

```python
def _inventory_embedding_signal(intent_embedding_client, text, inventory_proto_embeddings) -> tuple[float, bool]:
    """Return (similarity in [0, 1], whether embedding path was usable)."""
    stripped = text.strip()
    if not stripped:
        return (0.0, False)
        #   空文本 → 不可用。
    protos, intent_embedding_client = _ensure_inventory_prototype_embeddings(inventory_proto_embeddings, intent_embedding_client)
    #   取原型向量(+客户端)。
    if not protos or intent_embedding_client is None:
        return (0.0, False)
        #   没原型/没客户端 → 不可用(intent_detection 会把权重归零降级)。
    try:
        query_vec = intent_embedding_client.embed_query(stripped[:8000])
        #   嵌入用户文本(限 8000 字符)。
    except Exception as exc:
        logger.debug("intent query embedding failed: {}", exc)
        return (0.0, False)
    best = max(_cosine_similarity(query_vec, p) for p in protos)
    #   取与所有原型的最大相似度(最像哪句典型库存查询)。
    return (max(0.0, min(1.0, best)), True)
    #   裁剪到 [0,1],标记可用。
```

---

## `Pgvector`:查询侧向量检索

> **整块作用**:用自写 SQL 在 pgvector 表做相似度搜索(替代 LangChain PGVector)。反射找含查询字段+embedding
> 列的表,逐表用 `<=>`(余弦距离)排序取 top-k,全局汇总排序。

```python
class Pgvector:
    """Small SQLAlchemy pgvector adapter that replaces LangChain's PGVector store."""
    def __init__(self, engine, embedding_fn, *, embedding_column="embedding", return_columns=("sku_id","name","spec","brand","material")):
        self.engine = engine
        self.embedding_fn = embedding_fn               # 文本→向量函数(Embedding.embed_query)
        self.embedding_column = _safe_identifier(embedding_column)   # 向量列名(安全校验)
        self.return_columns = tuple(_safe_identifier(column) for column in return_columns)  # 返回列(校验)

    def similarity_search_with_score(self, query, k=5, use_rule=False) -> list[tuple[dict[str, Any], float]]:
        query_embedding = _vector_literal(self.embedding_fn(_query_text(query)))
        #   把查询文本嵌入并转成 pgvector 字面量。
        query_fields = set(query.keys()) if isinstance(query, Mapping) else set()

        # ── 1. 反射所有表 ──
        metadata = MetaData()
        metadata.reflect(bind=self.engine)

        # ── 2. 找含 query 字段 + embedding 列的表 ──
        matched_tables = []
        for table_name, table in metadata.tables.items():
            table_columns = {col.name for col in table.c}
            has_query_fields = query_fields.issubset(table_columns)
            has_embedding_col = self.embedding_column in table_columns
            if has_query_fields and has_embedding_col:
                matched_tables.append(table_name)
        if not matched_tables:
            return []
            #   没有合适的向量表 → 空。

        # ── 3. 逐表相似度查询 ──
        all_results: list[tuple[dict[str, Any], float]] = []
        for table_name in matched_tables:
            table = metadata.tables[table_name]
            table_columns = {col.name for col in table.c}
            return_columns = [c for c in _query_columns(query, self.return_columns) if c in table_columns]
            #   只取该表实际存在的返回列(防字段不一致报错)。
            if not return_columns:
                continue
            select_columns = ", ".join(return_columns)
            distance_expr = f"{self.embedding_column} <=> CAST(:query_embedding AS vector)"
            #   pgvector 的 <=> = 余弦距离(越小越相似)。
            statement = text(f"""
                SELECT {select_columns}, {distance_expr} AS score
                FROM {table_name}
                ORDER BY {distance_expr}
                LIMIT :limit
            """)
            #   按距离升序取 top-k(列名已过安全校验,值用参数绑定)。
            try:
                with self.engine.connect() as conn:
                    rows = conn.execute(statement, {"query_embedding": query_embedding, "limit": k}).mappings()
                    for row in rows:
                        all_results.append(({col: row[col] for col in return_columns}, float(row["score"])))
                        #   收集(行字典, 距离分)。
            except Exception as e:
                logger.warning("inventory.vector_query.table_failed table={} error={}", table_name, e)
                continue
                #   单表失败不影响其它表。

        # ── 4. 全局按距离升序,取 top-k ──
        all_results.sort(key=lambda x: x[1])
        if use_rule:
            return all_results[:k], all_results[:20]   # 额外返回前 20 条供"规则匹配"用
        return all_results[:k]
```

- 返回类型随 `use_rule` 变(top-k 或 (top-k, top-20))——`DataFilter.vector_candidates` 用了 `use_rule=True`。

---

## `DataFilter`:SKU 解析(精确+模糊+向量融合)⭐

> **整块作用**:把"模型识别的物品"解析到库里的具体 SKU。流程:归一化 → 向量候选 + 规则(精确/模糊)候选
> → 合并 → 逐候选打分 → 取最高分,据阈值判定 resolved / 需人工复核。

```python
class DataFilter:
    def __init__(self, sku_vector_db: VectorSkuStore):
        self.sku_vector_db = sku_vector_db   # 向量 SKU 库(Pgvector)

    def normalize_item(self, item: dict) -> dict:
        return {
            "name": self.normalize_name(str(item.get("name", ""))),
            "spec": self.normalize_spec(str(item.get("spec", ""))),
            "brand": str(item.get("brand", "")).strip(),
            "material": str(item.get("material", "")).strip(),
            "confidence": float(item.get("confidence", 0.0) or 0.0),
        }
        #   归一化输入物品(去空格/统一大小写)。

    def normalize_name(self, name: str) -> str:
        return (name or "").strip().replace(" ", "")   # 名称:去空格
    def normalize_spec(self, spec: str) -> str:
        return (spec or "").strip().lower().replace(" ", "")   # 规格:小写+去空格

    def exact_and_fuzzy_candidates(self, item_norm, matches) -> list:
        candidates = []
        for meta, score in matches:
            sku_name = self.normalize_name(meta["name"])
            sku_spec = self.normalize_spec(meta["spec"])
            if item_norm["name"] == sku_name and item_norm["spec"] == sku_spec:
                candidates.append({"source": "exact", "sku": meta, "vector_score": score})
                continue
                #   名+规格完全一致 → 精确候选。
            name_like = SequenceMatcher(None, item_norm["name"], sku_name).ratio()
            spec_like = SequenceMatcher(None, item_norm["spec"], sku_spec).ratio()
            if (name_like >= 0.6 and spec_like >= 0.5) or (name_like >= 0.75):
                candidates.append({"source": "fuzzy", "sku": meta, "vector_score": 0.0})
                #   名/规格足够相似 → 模糊候选。
        return candidates

    def vector_candidates(self, item_norm, sku_vector_db, top_k=5) -> list:
        query = {key: item_norm[key] for key in item_norm if key != "confidence"}
        matches, rule_matches = sku_vector_db.similarity_search_with_score(query, k=top_k, use_rule=True)
        #   向量检索 top-k,并拿前 20 条供规则匹配。
        cands = []
        for meta, score in matches:
            vector_score = max(0.0, min(1.0, 1.0 - float(score)))
            #   余弦距离 → 相似度(1 - 距离,裁剪到 [0,1])。
            cands.append({"source": "vector", "sku": {...五字段...}, "vector_score": vector_score})
        return cands, rule_matches

    def merge_candidates(self, rule_cands, vec_cands) -> list:
        merged = {}
        for cand in rule_cands + vec_cands:
            sku_id = cand["sku"]["sku_id"]
            if sku_id not in merged:
                merged[sku_id] = cand
                continue
            merged[sku_id]["vector_score"] = max(merged[sku_id]["vector_score"], cand["vector_score"])
            #   同一 SKU 取更高的向量分。
            if merged[sku_id]["source"] != "exact" and cand["source"] == "exact":
                merged[sku_id]["source"] = "exact"
                #   精确来源优先级最高。
        return list(merged.values())
        #   按 sku_id 去重合并规则候选与向量候选。

    def score_candidate(self, item_norm, candidate) -> dict:
        sku = candidate["sku"]
        name_score = SequenceMatcher(None, item_norm["name"], self.normalize_name(sku["name"])).ratio()
        spec_score = SequenceMatcher(None, item_norm["spec"], self.normalize_spec(sku["spec"])).ratio()
        brand_score = 1.0 if not item_norm["brand"] else SequenceMatcher(None, item_norm["brand"], sku["brand"]).ratio()
        vector_score = candidate.get("vector_score", 0.0)
        final_score = 0.45 * name_score + 0.35 * spec_score + 0.10 * brand_score + 0.10 * vector_score
        #   ⭐ 综合打分:名 0.45 + 规格 0.35 + 品牌 0.10 + 向量 0.10。
        return {...各项分 + final_score + source...}

    def resolve_sku(self, item: dict) -> dict:
        item_norm = self.normalize_item(item)
        vec_cands, rule_matches = self.vector_candidates(item_norm, self.sku_vector_db, top_k=5)
        rule_cands = self.exact_and_fuzzy_candidates(item_norm, rule_matches)
        candidates = self.merge_candidates(rule_cands, vec_cands)
        #   向量候选 + 规则候选 → 合并。
        if not candidates:
            return {... "resolved": False, "needs_human_review": True, "match_reason": "no candidate" ...}
            #   无候选 → 未解析、需人工。
        scored = [self.score_candidate(item_norm, c) for c in candidates]
        best = max(scored, key=lambda x: x["final_score"])
        #   取最高分候选。
        resolved = best["final_score"] >= 0.50
        #   ≥0.50 视为解析成功。
        needs_human_review = 0.50 <= best["final_score"] < 0.85
        #   0.50~0.85 之间:解析了但置信不高,标记需人工复核。
        return {... "resolved": resolved, "sku_id": best["sku_id"] if resolved else None,
                "match_score": best["final_score"], "needs_human_review": needs_human_review, "top_candidate": best ...}
```

- **三路候选融合**:精确(名+规格全等)/模糊(SequenceMatcher 相似)/向量(语义检索),合并去重后用
  加权分挑最优,再用阈值分"已解析 / 需复核 / 未解析"。

---

## 怎么和别的文件连起来

- `hook_impl.intent_detection`:用 `_inventory_embedding_signal`(信号③)。
- `inventory/postprocess.py`:用 `Pgvector`(查询)+ `DataFilter.resolve_sku`(把识别物品对应到 SKU)。
- `inventory/sqlconstant.py`:`_INVENTORY_INTENT_PROTOTYPES`(原型短语)。
- `llm/embedding.py`:`Embedding`(向量化)。

---

## 一句话总结

`logicfunction.py` 是库存算法核心:用 embedding 算"库存意图相似度"(意图识别信号③);用自写 SQL 在
pgvector 做相似度检索;`DataFilter` 把识别物品经"精确+模糊+向量"候选融合打分解析到具体 SKU(带阈值
分级:已解析/需复核/未解析)。
