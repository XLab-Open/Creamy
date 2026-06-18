# `backend/inventory/inventory_query.py` 精读(C 档·极详)

## 这个文件在干嘛

**全量库存盘点查询**:`InventoryQuery` 找出库里所有含 name/spec/brand/material 四字段的表,把它们
`UNION ALL` 起来按"name+spec+brand+material"分组计数,得到"每种物品组合各有多少条"的全量盘点。

> `toolimpl.query.inventory` 工具用它产出库存盘点结果(再写 Excel、发飞书)。与 `sql.py`(按条件查某物品)
> 不同——这是**无条件全量统计**。连 PostgreSQL,模块级缓存 engine。

---

## 顶部:配置、engine 单例

```python
from sqlalchemy import Engine, create_engine, inspect, text
from sqlalchemy.orm import Session
from backend.agent.settings import SQLSettings

REQUIRED_FIELDS = {"name", "spec", "brand", "material"}
#   只统计"同时含这四个字段"的表(视为库存表)。

_engine: Engine | None = None
#   模块级 engine 缓存(单例,避免重复建连接池)。

def _get_engine() -> Engine:
    global _engine
    if _engine is None:
        s = SQLSettings()
        _engine = create_engine(f"postgresql+psycopg://{s.user}:{s.password}@{s.host}:{s.port}/{s.dbname}")
        #   首次按 CREAMY_SQL_* 配置建 engine。
    return _engine
```

---

## `InventoryQuery`

> **整块作用**:构造取 engine;内部方法找匹配表、拼 UNION SQL;公开 query 执行,print_results 调试打印。

```python
class InventoryQuery:
    """Cross-table query module for inventory combination statistics(SQLAlchemy + PostgreSQL). ..."""
    def __init__(self):
        self.engine = _get_engine()
        #   拿缓存的 engine。

    def _get_matching_tables(self) -> list[str]:
        """Use SQLAlchemy inspect to find tables that contain all required fields"""
        inspector = inspect(self.engine)
        matching = []
        for table_name in inspector.get_table_names(schema="public"):
            columns = {col["name"] for col in inspector.get_columns(table_name, schema="public")}
            if REQUIRED_FIELDS.issubset(columns):
                matching.append(table_name)
                #   含全部四字段的表 → 纳入。
        return matching

    def _build_sql(self, tables: list[str]) -> str:
        """Build UNION ALL + GROUP BY SQL"""
        union_parts = [f'SELECT name, spec, brand, material FROM "{t}"' for t in tables]
        #   每张表选四字段。
        union_sql = " UNION ALL ".join(union_parts)
        #   UNION ALL 合并(保留重复行,因为要 count)。
        return f"""
            SELECT name, spec, brand, material, COUNT(*) AS total
            FROM ({union_sql}) AS combined
            GROUP BY name, spec, brand, material
            ORDER BY name, spec, brand, material
        """
        #   对合并结果按四字段分组计数 → 每个组合的 total。

    def get_matching_tables(self) -> list[str]:
        """Return a list of all table names that match the criteria"""
        return self._get_matching_tables()

    def query(self) -> list[dict]:
        """Main query: Cross all matching tables and count totals by combination. ..."""
        tables = self._get_matching_tables()
        if not tables:
            return []
            #   没有匹配表 → 空。
        sql = text(self._build_sql(tables))
        with Session(self.engine) as session:
            rows = session.execute(sql).mappings().all()
            return [dict(row) for row in rows]
            #   执行并返回 [{name,spec,brand,material,total}, ...]。

    def print_results(self):
        """Query and print results to the terminal (for debugging)"""
        tables = self._get_matching_tables()
        if not tables:
            print("No tables found containing all required fields:", REQUIRED_FIELDS)
            return
        print(f"Matching tables ({len(tables)}): {tables}\n")
        results = self.query()
        if not results:
            print("The query result is empty.")
            return
        print(f"{'name':<15} {'spec':<10} {'brand':<12} {'material':<10} {'Total number':>6}")
        print("─" * 58)
        for row in results:
            print(f"{row['name']:<15} {row['spec']:<10} {row['brand']:<12} {row['material']:<10} {row['total']:>6}")
        print("─" * 58)
        print(f"{len(results)} combinations, {sum(r['total'] for r in results)} records total\n")
        #   纯调试用:表格化打印盘点结果。
```

---

## 怎么和别的文件连起来

- `tools/toolimpl.py`:`query.inventory` 工具调 `InventoryQuery().query()`(放线程池避免阻塞),写 Excel。
- `agent/settings.py`:`SQLSettings`(CREAMY_SQL_*)。
- 对比 `inventory/sql.py`:按条件查某物品库存;本文件是全量盘点。

---

## 一句话总结

`inventory_query.py` 做"全量库存盘点":反射找出所有含 name/spec/brand/material 的表,UNION ALL + 分组计数,
得到每种物品组合的总数。供 `query.inventory` 工具产出盘点报表。
