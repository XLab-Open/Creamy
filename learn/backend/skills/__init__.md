# `backend/skills/__init__.py` 精读(C 档·极详)

## 这个文件在干嘛

`skills` 子包入口,纯**再导出**:把 `skills/skills.py` 的发现 API(常量 + `SkillMetadata` + `discover_skills`
+ `render_skills_prompt` 等)提到包顶层,方便 `from backend.skills import discover_skills`。

> 注意:`backend/skills/` 目录既是"代码包"(本文件+skills.py),又是"内置技能根目录"(各子目录的 SKILL.md)
> ——`_builtin_skills_root()` 正是用本包的 `__path__` 找内置技能。

---

## 逐行精读

> **整块作用**:从 skills.py 再导出全部公开 API(含几个下划线函数,供测试/内部用)。

```python
"""Skills package — re-exports the discovery API from :mod:`skills.skills`."""
from backend.skills.skills import (
    LEGACY_SKILLS_DIR,        # 旧技能目录常量
    PROJECT_SKILLS_DIR,       # 项目技能目录常量
    SKILL_FILE_NAME,          # "SKILL.md"
    SKILL_NAME_PATTERN,       # 技能名正则
    SKILL_SOURCES,            # ("project","global","builtin")
    SkillMetadata,            # 技能元数据类
    _parse_frontmatter,       # 解析 frontmatter(内部,导出供测试)
    _read_skill,              # 读单个技能(内部,导出供测试)
    discover_skills,          # 发现技能
    render_skills_prompt,     # 渲染技能提示
)

__all__ = [
    "LEGACY_SKILLS_DIR", "PROJECT_SKILLS_DIR", "SKILL_FILE_NAME", "SKILL_NAME_PATTERN",
    "SKILL_SOURCES", "SkillMetadata", "_parse_frontmatter", "_read_skill",
    "discover_skills", "render_skills_prompt",
]
#   公开清单(也控制 import *)。
```

---

## 一句话总结

门面文件:把技能发现 API 上提到 `backend.skills` 顶层。该包目录同时充当"内置技能"的存放根。
