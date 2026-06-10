# 第 07 章：加载、错误与 404 UI

Next.js App Router 提供了三个「特殊约定文件」，让你无需任何手动配置就能处理三种常见的非正常状态：数据加载中、渲染出错、资源不存在。本项目是该章节的独立可运行演示。

## 如何运行

```bash
# 安装依赖（首次）
npm install
# 或
pnpm install

# 开发模式（热更新）
npm run dev
# 或
pnpm dev

# 打开浏览器访问
# http://localhost:3000
```

生产构建：

```bash
npm run build && npm run start
```

> 本项目要求 Node.js 18.18+ 或 20+。

## 三个演示路由

| 路由 | 演示内容 | 特殊文件 |
|---|---|---|
| `/` | 概览页，三个演示入口 | `src/app/page.tsx` |
| `/slow` | 等待 1.5 秒后渲染，触发加载骨架 | `slow/loading.tsx` |
| `/broken` | 渲染时 throw，触发错误边界 | `broken/error.tsx` |
| `/missing` | 渲染时调用 notFound()，触发 404 UI | `missing/not-found.tsx` |

## 文件清单与作用

```
src/app/
├── globals.css             全局样式（card / demo-box / muted / tag / btn 等工具类）
├── layout.tsx              根布局（引入 globals.css，包裹所有页面）
├── page.tsx                概览页：说明三种特殊文件，提供演示入口链接
│
├── slow/
│   ├── loading.tsx         加载态占位 UI（自动触发，无需手动引用）
│   └── page.tsx            async 服务端组件，await 1500ms 后渲染真实内容
│
├── broken/
│   ├── error.tsx           错误边界 UI（必须是客户端组件，第一行 "use client"）
│   └── page.tsx            渲染时直接 throw new Error(...)，触发错误边界
│
└── missing/
    ├── not-found.tsx       自定义 404 UI（服务端组件，无需 "use client"）
    └── page.tsx            渲染时调用 notFound()，触发 not-found.tsx
```

## 三个特殊文件名详解

### `loading.tsx` — 加载态占位 UI

**所在文件夹**：`slow/loading.tsx`（与目标 `page.tsx` 同级）

**触发关系**：当同级的 `page.tsx` 是 `async` 函数组件且内部有 `await` 操作时，Next.js 自动把该页面包裹在 React `<Suspense>` 边界里，并将 `loading.tsx` 的内容作为 `fallback`。用户会立刻看到加载占位，等数据就绪后流式替换为真实内容。

**关键点**：
- 无需在 `page.tsx` 里手动写任何 `<Suspense>`，只需放一个 `loading.tsx` 文件。
- `loading.tsx` 本身是服务端组件，不需要 `"use client"`。
- 如果 `page.tsx` 是同步组件（没有 `await`），`loading.tsx` 永远不会显示。

### `error.tsx` — 错误边界（必须是客户端组件）

**所在文件夹**：`broken/error.tsx`（与出错的 `page.tsx` 同级）

**触发关系**：当同级的 `page.tsx` 在渲染时抛出错误（`throw new Error(...)`），Next.js 捕获该错误并渲染 `error.tsx`，同时将错误对象（`error`）和重试函数（`reset`）作为 props 传入。布局（`layout.tsx`）保持正常，只有出错的路由段被替换。

**关键点**：
- **第一行必须是 `"use client"`**，这是 Next.js 的硬性要求，没有例外。原因：React 错误边界依赖客户端运行时的生命周期 API，服务端组件无法实现。
- 接收两个 props：`error: Error & { digest?: string }` 和 `reset: () => void`。
- `reset()` 让 Next.js 重新尝试渲染该路由段，适用于偶发错误（如网络抖动）。
- 错误向上冒泡，被最近的 `error.tsx` 捕获；根布局的错误需要 `global-error.tsx`。

### `not-found.tsx` — 自定义 404 UI

**所在文件夹**：`missing/not-found.tsx`（与调用 `notFound()` 的 `page.tsx` 同级）

**触发关系**：当代码调用 `notFound()`（来自 `next/navigation`）时，Next.js 向上查找最近的 `not-found.tsx` 并渲染，HTTP 状态码设为 404。也适用于访问完全不存在的 URL。

**关键点**：
- `not-found.tsx` 是服务端组件，**不需要** `"use client"`（与 `error.tsx` 不同）。
- `notFound()` 语义是「资源不存在（404）」，与 `throw new Error`（发生了错误，500）语义不同，切勿混用。
- 典型场景：按 ID 查数据库，结果为 `null` 时调用 `notFound()`，而不是 `throw`。

## 核心规律

这三个特殊文件都遵循**就近原则**：放在哪个路由段文件夹里，就只影响该文件夹的 `page.tsx`（及其子路由）。不同路由段可以有各自独立的 `loading`/`error`/`not-found`，互不干扰。

## 要点摘要

| 文件 | 触发方式 | 是否需要 `"use client"` | HTTP 状态码 |
|---|---|---|---|
| `loading.tsx` | async page 内部有 `await`（挂起） | 否 | — |
| `error.tsx` | page 渲染时 `throw new Error(...)` | **是（必须）** | 500 |
| `not-found.tsx` | page 渲染时调用 `notFound()` | 否 | 404 |

详细知识点请参阅 [notes.md](./notes.md)。
