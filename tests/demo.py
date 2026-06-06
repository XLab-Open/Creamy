"""
Republic + DeepSeek (OpenAI 兼容接口) Demo
通过自定义 api_key_resolver 实现
"""

import os
from datetime import datetime, timedelta

from republic import LLM


class DeepSeekKeyResolver:
    """
    DeepSeek API Key 解析器
    模拟 Republic 官方 OAuth Resolver 的行为模式
    """

    def __init__(self, api_key: str | None = None):
        """
        初始化解析器
        
        Args:
            api_key: 可选的 API Key，如果不提供则从环境变量读取
        """
        # self._api_key = api_key or os.getenv("DEEPSEEK_API_KEY")
        # self._api_key = "sk-061b9c9c9f40428ab374680cd56ff05d"
        self._api_key = "sk-qtrdoedrxuzrprgmaboxhsvvrsoowdikzoaevwaejsukpkbv"
        if not self._api_key:
            raise RuntimeError(
                "请设置 DEEPSEEK_API_KEY 环境变量，或直接传入 api_key 参数"
            )

        # 模拟 token 信息（用于演示刷新机制）
        self._fetched_at: datetime | None = None

    def __call__(self, provider: str | None = None) -> str:
        """
        当 LLM 需要 API Key 时会调用此方法
        Republic 会通过调用这个可调用对象来获取密钥
        
        Returns:
            有效的 API Key 字符串
        """
        # provider 参数由 republic 传入（例如 "deepseek"、"openrouter"）。
        # 本示例不区分 provider，统一返回当前 key。
        _ = provider

        # 这里可以添加刷新逻辑
        # 例如：检查 key 是否过期，如果过期则重新获取
        if self._needs_refresh():
            self._refresh()

        return self._api_key

    def _needs_refresh(self) -> bool:
        """检查是否需要刷新（演示用，DeepSeek API Key 通常不过期）"""
        if self._fetched_at is None:
            return True

        # 模拟：每 24 小时刷新一次（实际 DeepSeek Key 不需要）
        return datetime.now() - self._fetched_at > timedelta(hours=24)

    def _refresh(self) -> None:
        """刷新 Key（实际使用时可以在这里实现动态获取逻辑）"""
        # 实际使用时，可以在这里：
        # - 从远程服务获取新 Key
        # - 刷新 OAuth Token
        # - 从密钥管理服务读取
        self._fetched_at = datetime.now()
        print(f"[INFO] API Key 已刷新，获取时间: {self._fetched_at}")


def create_deepseek_llm(
    api_key: str | None = None,
    model: str = "deepseek-chat"
) -> LLM:
    """
    创建支持 DeepSeek 的 Republic LLM 实例
    
    Args:
        api_key: DeepSeek API Key，如果不提供则从环境变量读取
        model: DeepSeek 模型名称，可选：
               - deepseek-chat: 标准对话模型
               - deepseek-coder: 代码模型
    
    Returns:
        配置好的 LLM 实例
    """

    # 注意：Republic 可能需要在底层支持自定义的 model 前缀
    # 如果 "deepseek:" 前缀不工作，可以尝试使用 OpenAI 兼容的 base_url
    # 但 Republic 版本可能有限制，这里展示的是概念性实现

    # 创建自定义解析器
    key_resolver = DeepSeekKeyResolver(api_key)

    # 方式一：如果 Republic 支持自定义提供商
    try:
        # llm = LLM(
        #     model=f"deepseek:{model}",  # 尝试使用 deepseek: 前缀
        #     api_key_resolver=key_resolver,
        # )
        # llm = LLM(
        #     model="deepseek:deepseek-chat",  # 尝试使用 deepseek: 前缀
        #     api_base="https://api.deepseek.com",
        #     api_key_resolver=key_resolver,
        # )

        llm = LLM(
            model="openai:deepseek-ai/DeepSeek-R1",  # 尝试使用 deepseek: 前缀
            api_base="https://api.siliconflow.cn/v1/",
            api_key="sk-qtrdoedrxuzrprgmaboxhsvvrsoowdikzoaevwaejsukpkbv",
            api_format="completion",
            # api_key_resolver=key_resolver,
        )
        return llm
    except Exception as e:
        print(f"[WARN] deepseek: 前缀失败: {e}")

    # 方式二：尝试使用 OpenAI 格式（如果 Republic 底层支持）
    # 这需要 Republic 版本允许传递额外的参数如 base_url
    # 由于 Republic API 限制，这里作为示例保留
    print("[INFO] 当前 Republic 版本可能不直接支持自定义提供商")
    print("[INFO] 建议使用 OpenRouter 方案替代，或等待 Republic 更新")

    # 回退方案：使用 OpenRouter 调用 DeepSeek
    print("[INFO] 回退到 OpenRouter 方案...")
    openrouter_key = os.getenv("OPENROUTER_API_KEY")
    if not openrouter_key:
        raise RuntimeError(
            "请设置 OPENROUTER_API_KEY 环境变量，"
            "或通过 https://openrouter.io/keys 获取"
        )

    return LLM(
        model="openrouter:deepseek/deepseek-chat",
        api_key=openrouter_key,
    )


# ============ 使用示例 ============

def main():
    """主函数：演示如何使用"""

    # 方式一：从环境变量读取
    # export DEEPSEEK_API_KEY="your-api-key-here"
    try:
        llm = create_deepseek_llm()

        # 发送聊天请求
        result = llm.chat(
            "请用一句话介绍你自己，并说明你是什么模型",
            max_tokens=100
        )
        print(f"DeepSeek 回复: {result}")

    except RuntimeError as e:
        print(f"错误: {e}")
        print("\n请确保已设置环境变量:")
        print("  export DEEPSEEK_API_KEY=your_api_key")
        print("\n或获取 OpenRouter API Key:")
        print("  export OPENROUTER_API_KEY=your_openrouter_key")


if __name__ == "__main__":
    main()
