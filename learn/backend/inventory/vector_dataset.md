# `backend/inventory/vector_dataset.py` 精读(C 档·极详)

## 这个文件在干嘛

**向量库的"建库侧"工具**:`LLMDataset` 用 LangChain 的 `PGVector` 把一批文档(SKU 文本)+ DashScope
embedding 灌进 PostgreSQL 的 pgvector 表。即"把 SKU 主数据向量化、存进向量库"这一步。

> 与 `logicfunction.Pgvector`(查询侧:自写 SQL 做相似度检索)分工:本文件负责**建/灌**库,那边负责**查**。
> 属于库存系统的离线/准备阶段(给 SKU 建向量索引,供后续物品识别匹配)。

---

## 逐行精读

> **整块作用**:导入 LangChain 向量库组件;`LLMDataset` 持有一个向量库句柄 `db`。

```python
from langchain_community.embeddings import DashScopeEmbeddings        # 阿里云 embedding
from langchain_community.vectorstores.pgvector import DistanceStrategy, PGVector  # pgvector 向量库
from langchain_core.documents import Document                         # 文档类型


class LLMDataset:
    def __init__(self):
        self.db = None
        #   向量库句柄(建库后赋值)。
```

> **整块作用(set_client)**:据连接参数拼出 PostgreSQL 连接串并保存。

```python
    def set_client(self, host="localhost", port="5432", user="postgres", password="", dbname="postgres"):
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.dbname = dbname
        self.connection_string = (
            f"postgresql+psycopg2://{self.user}:{self.password}@{self.host}:{self.port}/{self.dbname}"
        )
        #   拼 SQLAlchemy 连接串(psycopg2 驱动)。
        return self.connection_string
```

> **整块作用(get_pgvector)**:把文档 + embedding 灌进指定 collection,建成 PGVector 向量库并返回。

```python
    def get_pgvector(
        self,
        docs: list[Document],                          # 要入库的文档(SKU 文本)
        embeddings: DashScopeEmbeddings,               # embedding 模型
        collection_name: str,                          # 集合名
        connection_string: str,                        # 连接串
        distance_strategy: DistanceStrategy = DistanceStrategy.COSINE,  # 距离度量:余弦
        pre_delete_collection: bool = True,            # 先删旧集合(重建)
    ) -> PGVector:
        self.db = PGVector.from_documents(
            documents=docs,
            embedding=embeddings,
            collection_name=collection_name,
            distance_strategy=distance_strategy,
            pre_delete_collection=pre_delete_collection,
            connection_string=connection_string,
        )
        #   LangChain 一步建库:把每个 doc 嵌成向量,写进 pgvector 表(可选先清旧表)。
        return self.db
```

---

## 怎么和别的文件连起来

- `inventory/logicfunction.py`:`Pgvector`(查询侧)读的就是这种向量表;`DataFilter` 用相似度检索匹配 SKU。
- `inventory/postprocess.py`:运行时用 `Pgvector`(自写 SQL),而非本文件的 LangChain PGVector。

---

## 一句话总结

`vector_dataset.py` 是库存向量库的"建库侧":用 LangChain PGVector + DashScope embedding 把 SKU 文档灌进
pgvector 表(余弦距离)。运行时查询走 `logicfunction.Pgvector`。
