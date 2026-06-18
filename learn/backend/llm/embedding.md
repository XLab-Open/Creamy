# `backend/llm/embedding.py` 精读(C 档·极详)

## 这个文件在干嘛

**文本向量化(embedding)客户端**,默认对接阿里云 DashScope 的 text-embedding 服务。把文本转成向量,
供**库存意图识别的"向量信号"**用(`hook_impl.intent_detection` → `inventory.logicfunction` 算相似度)。

> 配置来自 `EmbeddingSettings`(`CREAMY_Embedding_*`)。没配 model_name/api_key 时向量信号不可用,意图
> 识别会自动降级到只用关键词+模型(见 hook_impl 的权重归一化)。

---

## 顶部:导入与常量

```python
import httpx   # 同步 HTTP 客户端(直接 POST 到 DashScope)
from backend.agent.settings import EmbeddingSettings   # 读 CREAMY_Embedding_* 配置

MAX_EMBEDDING_BATCH_SIZE = 25
#   单次请求最多嵌入 25 条文本(超出会分批)。
```

---

## 构造与配置

> **整块作用**:保存默认 model/key/base_url,并用 EmbeddingSettings 覆盖(即以配置为准)。

```python
class Embedding:
    def __init__(
        self,
        model_name: str = "text-embedding-v1",
        #   默认模型名(会被配置覆盖)。
        api_key: str | None = None,
        base_url: str = "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding",
        #   DashScope text-embedding 接口地址。
    ) -> None:
        self.model_name = model_name
        self.api_key = api_key
        self.base_url = base_url
        self._embedding_set = EmbeddingSettings()
        #   读配置。

        self.set_embedding()  # 默认，设置embedding模型
        #   用配置值覆盖 model_name/api_key。

    def set_embedding(self):
        self.model_name = self._embedding_set.model_name
        self.api_key = self._embedding_set.api_key
        #   以配置为最终值(空配置 → 空 model/key → 后续请求会失败/信号不可用)。
```

---

## 批量 / 单条嵌入

> **整块作用**:embed_documents 分批嵌入多条;embed_query 嵌入单条查询(标 text_type="query")。

```python
    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        embeddings: list[list[float]] = []
        for start in range(0, len(texts), MAX_EMBEDDING_BATCH_SIZE):
            batch = texts[start : start + MAX_EMBEDDING_BATCH_SIZE]
            #   每 25 条一批。
            embeddings.extend(self._embed(batch))
            #   逐批请求并汇总。
        return embeddings

    def embed_query(self, text: str) -> list[float]:
        return self._embed([text], text_type="query")[0]
        #   单条查询;text_type="query" 让模型按"查询"而非"文档"编码(检索效果更好),取第一个向量。
```

---

## 实际请求 `_embed`

> **整块作用**:组装请求体、POST 到 DashScope、校验状态、按 text_index 还原顺序返回向量。

```python
    def _embed(self, texts: list[str], *, text_type: str | None = None) -> list[list[float]]:
        payload = {
            "model": self.model_name,
            "input": {"texts": texts},
        }
        #   DashScope 请求体:模型 + 文本数组。
        if text_type is not None:
            payload["parameters"] = {"text_type": text_type}
            #   查询模式带上 text_type 参数。

        response = httpx.post(
            self.base_url,
            headers={
                "Authorization": f"Bearer {self.api_key}",   # 鉴权
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=30,
        )
        #   同步 POST(注意:这是同步 IO;在异步上下文里由调用方决定如何使用)。
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(f"Embedding API failed: {exc.response.status_code} {exc.response.text}") from exc
            #   非 2xx → 抛含状态码与响应体的错误。

        data = response.json()
        embeddings = data["output"]["embeddings"]
        #   取出向量数组(DashScope 响应结构)。

        embeddings = sorted(embeddings, key=lambda item: item["text_index"])
        #   按 text_index 排序——保证返回顺序与输入 texts 一致(API 可能乱序返回)。
        return [item["embedding"] for item in embeddings]
        #   提取每条的向量。
```

---

## 怎么和别的文件连起来

- `hook_impl.py`:`intent_detection` 持有 `Embedding` 客户端(懒加载),算"库存原型向量"相似度。
- `inventory/logicfunction.py`:`_inventory_embedding_signal` 用它得到向量并算分。
- `agent/settings.py`:`EmbeddingSettings`(`CREAMY_Embedding_model_name`/`_api_key`)。

---

## 一句话总结

`embedding.py` 是 DashScope 文本向量化客户端:分批/单条嵌入、按 text_index 还原顺序、配置缺失即不可用。
它为库存意图识别提供"语义相似度"那一路信号。
