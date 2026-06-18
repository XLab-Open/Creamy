# `backend/skills/skills.py` 精读(C 档·极详)

## 这个文件在干嘛

**技能(Skill)发现与渲染**。技能 = 数据(一个带 frontmatter 的 `SKILL.md`),按需加载而非 import。本模块
负责:从"项目 / 全局 / 内置"三处根目录发现技能、校验其 frontmatter、按覆盖优先级去重,并渲染成喂给模型的
提示文本。

> 回顾 CLAUDE.md:"Skills = data(SKILL.md),discovered by skills.py and loaded on demand"。agent 的
> `_load_skills_prompt`、`skill` 工具都调本模块的 `discover_skills`/`render_skills_prompt`。

---

## 顶部:常量

```python
"""Skill discovery and Creamy runtime adapter loading."""
from __future__ import annotations
import re, string, sys, warnings
from collections.abc import Collection
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
import yaml

PROJECT_SKILLS_DIR = ".agents/skills"      # 项目级技能目录(工作区下)
LEGACY_SKILLS_DIR = ".agent/skills"        # 旧目录(兼容,会告警)
SKILL_FILE_NAME = "SKILL.md"               # 技能文件名
SKILL_SOURCES = ("project", "global", "builtin")   # 三个来源(优先级从高到低)
SKILL_NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")   # 合法技能名:小写+数字+连字符
```

---

## SkillMetadata:技能元数据

> **整块作用**:表示一个发现到的技能;`body()` 读 SKILL.md 正文(去 frontmatter,并替换 $SKILL_DIR/$PYTHON 变量)。

```python
@dataclass(frozen=True)
class SkillMetadata:
    """Discovered skill metadata."""
    name: str                 # 技能名
    description: str          # 描述(给模型看)
    location: Path            # SKILL.md 绝对路径
    source: str               # 来源(project/global/builtin)
    metadata: dict[str, Any] = field(default_factory=dict)   # 其余 frontmatter 字段

    def body(self) -> str:
        front_matter_pattern = re.compile(r"^---\s*\n.*?\n---\s*\n", re.DOTALL)
        #   匹配开头的 YAML frontmatter 块。
        try:
            template = string.Template(self.location.read_text(encoding="utf-8").strip())
            #   读 SKILL.md 全文,当成 $变量 模板。
        except OSError:
            return ""
        content = template.safe_substitute({"SKILL_DIR": str(self.location.parent), "PYTHON": sys.executable})
        #   替换 $SKILL_DIR(技能目录)与 $PYTHON(当前解释器)——让技能脚本路径可用。
        return front_matter_pattern.sub("", content, count=1).strip()
        #   去掉 frontmatter,返回正文(展开技能时给模型)。
```

---

## discover_skills:发现(含覆盖优先级)

> **整块作用**:遍历三处根,读每个子目录的 SKILL.md;**先发现的(高优先级源)胜出**,同名不覆盖;按名排序返回。

```python
def discover_skills(workspace_path: Path) -> list[SkillMetadata]:
    """Discover skills from project, global, and builtin roots with override precedence."""
    skills_by_name: dict[str, SkillMetadata] = {}
    for root, source in _iter_skill_roots(workspace_path):
        #   按 project → global → builtin 顺序遍历根目录。
        if not root.is_dir():
            continue
        for skill_dir in sorted(root.iterdir()):
            if not skill_dir.is_dir():
                continue
            metadata = _read_skill(skill_dir, source=source)
            if metadata is None:
                continue
                #   无效技能跳过。
            key = metadata.name.casefold()
            if key not in skills_by_name:
                skills_by_name[key] = metadata
                #   ⭐ 同名不覆盖 → 先来的(project 优先于 global 优先于 builtin)胜出。
    return sorted(skills_by_name.values(), key=lambda item: item.name.casefold())
    #   按名排序返回。
```

---

## 读取与校验技能

> **整块作用(_read_skill)**:读 SKILL.md、解析 frontmatter、校验,构造 SkillMetadata。

```python
def _read_skill(skill_dir: Path, *, source: str) -> SkillMetadata | None:
    skill_file = skill_dir / SKILL_FILE_NAME
    if not skill_file.is_file():
        return None
        #   目录里没有 SKILL.md → 不是技能。
    try:
        content = skill_file.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    metadata = _parse_frontmatter(content)
    #   解析 YAML frontmatter。
    if not _is_valid_frontmatter(skill_dir=skill_dir, metadata=metadata):
        return None
        #   校验不过 → 丢弃。
    name = str(metadata["name"]).strip()
    description = str(metadata["description"]).strip()
    return SkillMetadata(
        name=name, description=description, location=skill_file.resolve(), source=source,
        metadata={str(key).casefold(): value for key, value in metadata.items() if key is not None},
    )
```

> **整块作用(_parse_frontmatter)**:从 "---...---" 块里解析出 YAML dict(键转小写)。

```python
def _parse_frontmatter(content: str) -> dict[str, Any]:
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
        #   首行不是 "---" → 没有 frontmatter。
    for idx, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            #   找到结束的 "---"。
            payload = "\n".join(lines[1:idx])
            try:
                parsed = yaml.safe_load(payload)
            except yaml.YAMLError:
                parsed = {}
            if isinstance(parsed, dict):
                return {str(key).lower(): value for key, value in parsed.items()}
                #   键统一小写。
    return {}
```

> **整块作用(校验三件套)**:name 合法(小写连字符、≤64、必须等于目录名)、description 非空≤1024、metadata
> 字段(若有)须是 str→str 字典。

```python
def _is_valid_frontmatter(*, skill_dir: Path, metadata: dict[str, object]) -> bool:
    name = metadata.get("name")
    description = metadata.get("description")
    return (_is_valid_name(name=name, skill_dir=skill_dir)
            and _is_valid_description(description)
            and _is_valid_metadata_field(metadata.get("metadata")))

def _is_valid_name(*, name: object, skill_dir: Path) -> bool:
    if not isinstance(name, str):
        return False
    normalized_name = name.strip()
    if not normalized_name or len(normalized_name) > 64:
        return False                              # 非空且 ≤64
    if normalized_name != skill_dir.name:
        return False                              # ⭐ 必须与所在目录名一致(防错配)
    return SKILL_NAME_PATTERN.fullmatch(normalized_name) is not None   # 小写+数字+连字符

def _is_valid_description(description: object) -> bool:
    if not isinstance(description, str):
        return False
    normalized = description.strip()
    return bool(normalized) and len(normalized) <= 1024   # 非空 ≤1024

def _is_valid_metadata_field(metadata_field: object) -> bool:
    if metadata_field is None:
        return True                               # 没有 metadata 字段也合法
    if not isinstance(metadata_field, dict):
        return False
    return all(isinstance(key, str) and isinstance(value, str) for key, value in metadata_field.items())
    #   metadata 必须是 str→str。
```

---

## 技能根目录 + 渲染提示

> **整块作用(根目录)**:内置根来自包路径;三源顺序产出(project 含旧目录兼容告警、global 在 home、builtin 在包内)。

```python
def _builtin_skills_root() -> list[Path]:
    import importlib
    return [Path(p) for p in importlib.import_module("backend.skills").__path__]
    #   内置技能 = backend/skills 包目录。

def _iter_skill_roots(workspace_path: Path) -> list[tuple[Path, str]]:
    roots: list[tuple[Path, str]] = []
    for source in SKILL_SOURCES:
        if source == "project":
            roots.append((workspace_path / PROJECT_SKILLS_DIR, source))   # 工作区/.agents/skills
            legacy_path = workspace_path / LEGACY_SKILLS_DIR
            if legacy_path.is_dir():
                warnings.warn(f"Found legacy skills directory at '{legacy_path}'. Please move it to '{PROJECT_SKILLS_DIR}' ...",
                    category=UserWarning, stacklevel=2)
                roots.append((legacy_path, source))   # 旧目录兼容(告警提示迁移)
        elif source == "global":
            roots.append((Path.home() / PROJECT_SKILLS_DIR, source))   # ~/.agents/skills
        elif source == "builtin":
            for path in _builtin_skills_root():
                roots.append((path, source))   # 包内置技能
    return roots
```

> **整块作用(render_skills_prompt)**:把技能列表渲染成 `<available_skills>` 提示;被"展开"的技能附上位置+正文。

```python
def render_skills_prompt(skills: list[SkillMetadata], expanded_skills: Collection[str] = ()) -> str:
    if not skills:
        return ""
    lines = ["<available_skills>"]
    for skill in skills:
        line = f"- {skill.name}: {skill.description}"
        #   默认只给 名: 描述(摘要)。
        if skill.name in expanded_skills:
            line += f"\n  Location: {skill.location}"
            body = skill.body()
            if body:
                line += f"\n{body}"
            #   ⭐ 被 $skill 点名的技能 → 附上位置 + 完整正文(agent._load_skills_prompt 决定谁展开)。
        lines.append(line)
    lines.append("</available_skills>")
    return "\n".join(lines)
```

---

## 怎么和别的文件连起来

- `agent/agent.py`:`_load_skills_prompt` 调 `discover_skills`/`render_skills_prompt`;prompt 里 `$名字` 触发展开。
- `tools/toolimpl.py`:`skill` 工具调 `discover_skills` 按名加载技能正文。
- `channels/web.py`:`_list_skills` 自己扫 SKILL.md(另一套简版,供前端列技能)。

---

## 一句话总结

`skills.py` 实现"技能=数据、按需加载":从 project/global/builtin 三源发现 SKILL.md(同名高优先源胜)、校验
frontmatter、渲染成提示(被点名的技能给全文)。技能无需 import,改数据即扩展能力。
