# `backend/inventory/sql.py` 精读(C 档·极详)

## 这个文件在干嘛

**按条件统计库存的 SQL 查询器**:`SQL.query_inventory(filters, engine)` 反射数据库所有表,对"包含全部
filter 字段"的表执行"按 filter 分组、count 求总数",再跨表累加,返回 `[{...filter字段, total}, ...]`。

> `postprocess.LLMPostprocess.postprocess` 用它:把模型识别+解析出的物品(name/spec/brand/material)作为
> filter 查库存数量。与 `inventory_query.py`(全量盘点)不同——这是**按条件**查。

---

## 逐行精读

> **整块作用**:反射所有表,筛出含全部 filter 字段的表,对每张表做"条件过滤 + 分组计数",跨表把同一组合
> 的 total 累加,最后还原成 list[dict]。出错返回空。

```python
from collections.abc import Mapping
from typing import Any
from sqlalchemy import Engine, MetaData, and_, func, select


class SQL:
    def __init__(self):
        pass

    def query_inventory(self, filters: Mapping[str, Any] | None, engine: Engine | None = None) -> list[dict]:
        query_fields = set(filters.keys()) if isinstance(filters, Mapping) else set()
        #   filter 的字段名集合(如 {"name","spec"})。
        try:
            metadata = MetaData()
            metadata.reflect(bind=engine)  # 自动反射所有表
            #   读取数据库里所有表结构(无需预先定义 ORM 模型)。

            merged: dict[tuple, int] = {}
            #   key:(各 filter 字段值组成的元组) → 累加的 total。
            with engine.connect() as conn:
                for _tname, table in metadata.tables.items():
                    table_columns = {col.name for col in table.c}
                    if not query_fields.issubset(table_columns):
                        continue
                        #   该表不含全部 filter 字段 → 跳过(只查"能按这些字段过滤"的表)。
                    conditions = [table.c[key] == value for key, value in filters.items()]
                    #   构造 WHERE:每个 filter 字段 = 指定值。
                    group_by_cols = [table.c[key] for key in filters]
                    #   GROUP BY:按 filter 字段分组。

                    stmt = (
                        select(*group_by_cols, func.count().label("total"))
                        .where(and_(*conditions))
                        .group_by(*group_by_cols)
                    )
                    #   SELECT 分组字段, COUNT(*) AS total WHERE 条件 GROUP BY 分组字段。

                    for row in conn.execute(stmt).mappings():
                        key = tuple(row[k] for k in query_fields)
                        #   用各 filter 字段的值组成 key。
                        merged[key] = merged.get(key, 0) + row["total"]
                        #   跨表累加同一组合的总数。

            return [{**dict(zip(query_fields, key, strict=False)), "total": total} for key, total in merged.items()]
            #   把 {key:total} 还原成 [{字段名:值..., total:数量}, ...]。

        except Exception:
            return []
            #   任何错误(无 engine、连不上、表结构异常)→ 返回空(调用方据空判断"未找到")。
```

- **设计**:不假设有固定库存表名,而是**反射 + 字段匹配**,任何含 name/spec/... 的表都纳入统计——
  适配"库存散落在多张表"的情形。

---

## 怎么和别的文件连起来

- `inventory/postprocess.py`:`postprocess` 用它按 name(或 name/spec/brand/material)查库存数量。
- `inventory/inventory_query.py`:做"全量盘点"(无 filter,所有匹配表 UNION),与本文件互补。

---

## 一句话总结

`sql.py` 按给定字段条件统计库存:反射所有表 → 筛出含这些字段的表 → 条件分组计数 → 跨表累加。是
"查某物品库存有多少"的实现,供库存后处理调用。
