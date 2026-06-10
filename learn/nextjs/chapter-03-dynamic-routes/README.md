# Chapter 03 · 动态路由与路由组

独立、可单独运行的 Next.js 15 示例项目，演示动态路由（`[id]`、`[...slug]`）与路由组（`(group)`）的完整用法。

## 如何运行

```bash
# 进入本项目目录
cd learn/nextjs/chapter-03-dynamic-routes

# 安装依赖（需要 Node.js 18+）
npm install
# 或
pnpm install

# 启动开发服务器
npm run dev
# 或
pnpm dev
```

浏览器打开 [http://localhost:3000](http://localhost:3000) 即可看到章节概览页。

## 本项目文件清单与作用

| 文件路径 | 必需 | 说明 |
|---|:---:|---|
| `package.json` | ✅ | 项目依赖与脚本（next、react、react-dom） |
| `next.config.mjs` | ✅ | Next.js 配置文件（本项目使用默认配置） |
| `tsconfig.json` | ✅ | TypeScript 编译配置 |
| `next-env.d.ts` | ✅ | Next.js 类型声明（自动生成，勿手动修改） |
| `src/app/layout.tsx` | ✅ | **根布局**：引入 globals.css，提供全局样式类（`card`/`btn`/`tag`/`muted` 等）；所有页面都嵌套在这个布局中 |
| `src/app/globals.css` | ✅ | **全局样式**：深色主题 + 全局类定义 |
| `src/app/page.tsx` | ✅ | **首页**（路由 `/`）：章节概览，介绍所有核心概念，提供跳转链接 |
| `src/app/products/[id]/page.tsx` | ✅ | **动态路由页**（路由 `/products/:id`）：演示 `[id]` 动态段与 `generateStaticParams` |
| `src/app/docs/[...slug]/page.tsx` | ✅ | **Catch-all 路由页**（路由 `/docs/*`）：演示 `[...slug]` 多段捕获 |
| `notes.md` | — | 本章知识点笔记，供离线查阅 |
| `README.md` | — | 本文件 |

### 关键：带方括号的文件夹就是动态路由

Next.js App Router 的动态路由完全由**文件夹命名**决定，不需要任何额外配置：

- **`products/[id]/`** — 文件夹名为 `[id]`（单对方括号），表示这一位置是一个动态 URL 段。访问 `/products/42` 时，Next.js 自动将 `42` 解析为参数 `id`，注入到页面组件的 `params` 中。文件夹里的 `page.tsx` 就是该动态路由的页面。

- **`docs/[...slug]/`** — 文件夹名为 `[...slug]`（三个点 + 方括号），是 catch-all 语法，可以匹配该层级后面**任意数量**的 URL 片段。访问 `/docs/guide/intro` 时，`slug` 被解析为数组 `["guide", "intro"]`；访问 `/docs/a/b/c` 时得到 `["a", "b", "c"]`。

```
src/app/
├── page.tsx                    ← 根路由 /
├── layout.tsx                  ← 根布局（包裹所有页面）
├── globals.css
│
├── products/
│   └── [id]/                   ← ⭐ 动态段：[id] 匹配单个 URL 片段
│       └── page.tsx            ← 路由：/products/任意值
│
└── docs/
    └── [...slug]/              ← ⭐ catch-all：[...slug] 匹配多个 URL 片段
        └── page.tsx            ← 路由：/docs/任意/深度/路径
```

## 要点摘要

| 概念 | 语法 | 说明 |
|---|---|---|
| 动态段 | `[id]` | 匹配一个 URL 片段，`params.id: string` |
| catch-all | `[...slug]` | 匹配一个或多个片段，`params.slug: string[]` |
| 可选 catch-all | `[[...slug]]` | 连零片段也匹配，`params.slug: string[] \| undefined` |
| 路由组 | `(group)` | 不出现在 URL 中，仅用于文件组织与共享 layout |
| 静态预渲染 | `generateStaticParams()` | 构建期枚举参数，生成静态 HTML（SSG） |

**Next.js 15 重要变化**：`params` 是 `Promise`，页面必须是 `async` 组件并 `await params`：

```tsx
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;   // ← Promise 类型
}) {
  const { id } = await params;       // ← 必须 await
  // ...
}
```

## 详细笔记

更完整的知识点、代码对比与常见坑详见 [notes.md](./notes.md)。
