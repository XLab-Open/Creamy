# `backend/inventory/__init__.py` 精读(C 档·极详)

## 这个文件在干嘛

`inventory` 子包入口,只有一段 docstring,给整个子包定性:**库存领域**——SQL + 向量库存查询、意图原型
(用于意图识别)、LLM 后处理。它被**内置 hook 实现直接消费**(不是插件)。

> 这是 Creamy 在"通用 agent 框架"之上耦合的**具体业务**:把库存查询能力做成一组模块,由 `hook_impl` 的
> `intent_detection`(意图原型)、`postprocess_model_output`(LLMPostprocess)、`query.inventory` 工具直接调用。

---

## 逐行精读

```python
"""Inventory domain — SQL + vector inventory query, intent prototypes, and
LLM post-processing. Consumed directly by the builtin hook impl (not a plugin).
"""
#   定性:库存领域子包 = SQL+向量查询 + 意图原型 + LLM 后处理;由内置 hook 直接用(非插件)。
```

---

## 子包内各文件分工(便于通览)

| 文件 | 职责 |
| --- | --- |
| `sqlconstant.py` | 常量:库存关键词、意图原型短语、融合权重/阈值、SKU/库存 mock、名称别名 |
| `sql.py` | `SQL.query_inventory`:跨表反射 + 条件分组统计库存 |
| `inventory_query.py` | `InventoryQuery`:跨所有匹配表 UNION ALL + GROUP BY 全量盘点 |
| `vector_dataset.py` | `LLMDataset`:用 LangChain PGVector 建/灌向量库(建库侧) |
| `logicfunction.py` | 意图向量信号 + `Pgvector`(查询侧)+ `DataFilter`(SKU 解析:精确/模糊/向量融合打分) |
| `postprocess.py` | `LLMPostprocess`:把模型识别的物品解析成 SKU、查库存、组织成用户回复 |

---

## 一句话总结

`inventory/__init__.py` 宣告这是 Creamy 的库存业务子包(SQL+向量查询+意图原型+后处理),由内置 hook 直接
消费——这是"业务层"耦合进框架的地方。
