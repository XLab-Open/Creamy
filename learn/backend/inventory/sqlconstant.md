# `backend/inventory/sqlconstant.py` 精读(C 档·极详)

## 这个文件在干嘛

库存子系统的**常量集中地**:意图识别用的关键词与"原型短语"、三信号融合的权重与阈值,以及一份 mock
的 SKU 主数据 / 库存 / 名称别名(开发/演示用)。`hook_impl.intent_detection` 与 `logicfunction` 都从这里取。

> 这些是"业务数据/调参"。改库存识别的灵敏度、加关键词、调权重,都在这。

---

## 关键词与意图原型

> **整块作用**:关键词命中(信号①)用的词表;向量相似(信号③)用的"典型库存查询句"原型。

```python
_INVENTORY_KEYWORDS = (
    "库存", "库存量", "库存查询", "查库存", "余量", "剩余", "数量", "多少", "有货", "缺货", "库",
)
#   信号①关键词:用户文本含任一即得分(intent_detection 的 keyword_score)。

# Phrases for semantic (embedding) similarity toward inventory-query intent.
_INVENTORY_INTENT_PROTOTYPES = (
    "查一下库存还有多少", "查询这个物料的库存情况", "仓库里有没有这个配件的现货",
    "库存余量和可用数量是多少", "帮忙看看有没有库存", "图中物品是否在库存里",
    "识别图片里的东西在不在库存", "这个规格有没有货",
)
#   信号③原型:把这些句子嵌成向量,用户输入与它们的最大余弦相似度 = embedding_score。
#   (logicfunction._ensure_inventory_prototype_embeddings 嵌这些)。
```

---

## 融合权重与阈值

> **整块作用**:三信号加权融合的权重(和为 1)与"判为库存查询"的阈值。

```python
INTENT_WEIGHT_KEYWORD = 0.25     # 关键词权重
INTENT_WEIGHT_MODEL = 0.45       # 模型自报权重(最高:最信模型判断)
INTENT_WEIGHT_EMBEDDING = 0.30   # 向量相似权重
INTENT_INVENTORY_SCORE_THRESHOLD = 0.45   # 融合分 ≥ 0.45 判为 query_inventory
```
- 对应 `hook_impl.intent_detection`:`fused = w_kw*kw + w_mo*model + w_em*emb`,`≥ threshold` → 查库存。
  向量不可用时把 em 权重归零并把 kw/mo 重归一化(见 hook_impl)。

---

## Mock 数据(SKU 主数据 / 库存 / 别名)

> **整块作用**:演示/开发用的假数据——SKU 主表、部分 SKU 的库存、名称别名映射。真实环境用数据库
> (`InventoryQuery`/`SQL` 查 PostgreSQL),这些是无库时的样例。

```python
SKU_MASTER = [
    {"sku_id": "SKU_1001", "name": "内六角螺丝", "spec": "M6x20", "brand": "Generic", "material": "304不锈钢"},
    ...(约 29 条:螺丝/垫圈/螺母/工具/锤子/螺丝刀等,name+spec+brand+material)...
]
#   SKU 主数据(物品目录)。每条是一个具体规格的物品。

MOCK_INVENTORY = {
    "SKU_1001": {"qty_available": 120, "warehouse_id": "WH_A", "updated_at": "2026-03-23 10:00:00"},
    "SKU_1002": {"qty_available": 0, ...},   # 0 = 缺货
    ...(5 条)...
}
#   部分 SKU 的库存量(演示)。真实库存来自 SQL 查询。

NAME_ALIAS = {
    "内六角螺栓": "内六角螺丝", "内六角螺钉": "内六角螺丝", "平垫": "平垫圈",
    "弹垫": "弹簧垫圈", "六角母": "六角螺母", ...(同义词 → 标准名)...
}
#   名称别名:把用户/模型说的俗称映射到 SKU 主数据里的标准名(提升匹配命中)。
```

---

## 怎么和别的文件连起来

- `hook_impl.intent_detection`:用 `_INVENTORY_KEYWORDS` 与三个权重/阈值。
- `inventory/logicfunction.py`:`_INVENTORY_INTENT_PROTOTYPES` 嵌成原型向量算相似度。

---

## 一句话总结

`sqlconstant.py` 是库存识别的"参数与样例数据":关键词、意图原型短语、三信号权重/阈值,以及一份 mock 的
SKU/库存/别名。调库存识别灵敏度就改这里。
