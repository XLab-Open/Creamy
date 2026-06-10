# 第 09 章 · 样式、元数据与中间件

Next.js App Router 独立教学项目，演示三个核心主题：CSS Modules 作用域隔离、Metadata API SEO 控制、Middleware 请求拦截机制。

---

## 如何运行

```bash
# 进入本项目目录
cd learn/nextjs/chapter-09-styling-metadata

# 安装依赖
npm install
# 或 pnpm install / yarn

# 启动开发服务器
npm run dev

# 浏览器打开 http://localhost:3000
```

生产构建：

```bash
npm run build
npm run start
```

---

## 本项目文件清单与作用

| 文件 | 必需 | 说明 |
|------|:----:|------|
| `package.json` | ★ | 项目元信息与依赖声明（next、react、react-dom） |
| `next.config.ts` | ★ | Next.js 配置文件（本项目使用默认值） |
| `tsconfig.json` | ★ | TypeScript 编译配置，含路径别名 `@/` → `src/` |
| `src/app/layout.tsx` | ★ | 根布局：渲染 `<html>`/`<body>`，导入全局 CSS，设置顶栏 |
| `src/app/globals.css` | ★ | 全局样式：CSS 变量、Reset、工具类（`.card`/`.btn`/`.tag` 等） |
| `src/app/page.tsx` | ★ | 根路由 `/`：本章主页面，导出 metadata，演示 CSS Module、generateMetadata 与 middleware 代码示例 |
| `src/app/styles.module.css` | ★ | **CSS Module 示例文件**（见下方说明） |
| `notes.md` | — | 本章知识点笔记，含代码示例、常见坑、小练习 |
| `README.md` | — | 本文件 |

### 关于 `styles.module.css` 命名规则

文件名以 **`.module.css`** 结尾是触发 CSS Modules 功能的约定：

- **`.module.css`**（本文件）→ Next.js 启用模块化处理，构建时自动为每个类名加哈希后缀，实现**作用域隔离**。导入方式：`import styles from "./styles.module.css"`，在 JSX 中用 `className={styles.xxx}` 使用。
- **`.css`**（如 `globals.css`）→ 普通全局样式，对所有页面生效，类名不加哈希，可直接用 `className="card"` 引用。

这意味着你可以在 `styles.module.css` 和 `globals.css` 中同时定义名为 `.card` 的类，它们**完全不会冲突**——CSS Module 的 `.card` 在运行时已变成 `card_a1b2c3__xxx` 这样的唯一字符串。

---

## 本章演示内容

### 样式方案

| 方案 | 用法 | 适用场景 |
|------|------|----------|
| 全局 CSS | `import "./globals.css"` in layout | CSS 变量、Reset、全局工具类 |
| CSS Modules | `import styles from "./x.module.css"` | 组件级样式，零冲突 |
| 内联 style | `style={{ color: "red" }}` | 动态值、一次性微调 |
| Tailwind / CSS-in-JS | 需额外安装 | 大型项目，RSC 下 CSS-in-JS 需配置 |

### Metadata API

- **静态**：`export const metadata: Metadata = { title, description, openGraph, ... }` — 构建时确定，零运行时开销。
- **动态**：`export async function generateMetadata({ params })` — 根据路由参数或接口数据异步生成，内部 fetch 与页面组件自动去重。
- `page.tsx` 的 metadata 字段覆盖 `layout.tsx` 的同名字段，这是 Next.js 正常的合并行为。

### Middleware（仅代码讲解，未创建实体文件）

- `middleware.ts` 放在 `src/` 下（与 `src/app/` 平级）对整个项目生效，本项目**不实际创建**该文件以避免影响其他章节。
- 三种响应方式：`NextResponse.next()`（放行）、`NextResponse.redirect()`（重定向）、`NextResponse.rewrite()`（重写）。
- 运行在 Edge Runtime，不能使用 Node.js 内置模块或直连数据库。
- 必须配置 `matcher` 限制作用路径范围，否则所有请求（含静态文件）都会触发。

---

## 要点摘要

1. CSS Module 文件名必须以 `.module.css` 结尾；导入对象的键是原始类名，值是哈希后的唯一字符串。
2. `export const metadata` 和 `export async function generateMetadata` 只能在 Server Component（无 `"use client"`）中使用。
3. `generateMetadata` 中的 `fetch` 与页面组件中相同 URL 的 `fetch` 会被 Next.js 自动去重。
4. Next.js 15 中 `params` 和 `searchParams` 均为 Promise，需 `await` 解包。
5. Middleware 的 `matcher` 不配置则对所有请求生效（含静态文件），务必配置。

---

详细知识点、代码示例与常见坑见 [notes.md](./notes.md)。
