# 第 01 章笔记：起步与项目结构

> 本章是一个**独立的 Next.js 项目**，位于 `chapter-01-getting-started/` 目录，
> 可单独运行（见 README.md 中的「如何运行」）。

## 本章目标

学完本章，你应该能够：

1. 用一句话解释 Next.js 与纯 React 的区别
2. 区分 App Router 与 Pages Router，知道本教程选择哪个及原因
3. 说出 `page.tsx`、`layout.tsx`、`loading.tsx` 等特殊文件的作用
4. 理解「文件即路由」的含义，能根据目录结构推断 URL
5. 在本地启动 Next.js 开发服务器并访问页面

---

## 一、Next.js 核心特性

### 1.1 服务端渲染（SSR）

传统纯 React SPA（单页应用）的渲染流程是：

```
浏览器请求 → 服务器返回空 HTML → 浏览器下载 JS → 执行 JS → 渲染页面
```

用户要等 JS 下载并执行完毕才能看到内容，首屏慢、SEO 差（搜索引擎爬虫看不到内容）。

Next.js SSR 的流程是：

```
浏览器请求 → Next.js 在服务器渲染完整 HTML → 浏览器直接显示内容 → JS 加载完成后「激活」（Hydration）
```

首屏内容直接以 HTML 形式发送，搜索引擎可以直接读取，用户体验更好。

### 1.2 静态生成（SSG）与增量静态再生成（ISR）

- **SSG**：`npm run build` 时预先生成静态 HTML 文件，部署到 CDN 后响应极快，适合内容不频繁变化的页面（博客、文档站）。
- **ISR**：静态页面 + 定期重新生成，兼顾性能与时效性。例如电商商品页可以每 60 秒重新生成一次价格数据。

### 1.3 约定式文件系统路由

不需要像 React Router 那样手写路由配置：

```tsx
// React Router 的方式（需要配置）
<Route path="/blog/:slug" element={<BlogPost />} />

// Next.js 的方式（只需创建文件）
// src/app/blog/[slug]/page.tsx → 自动对应 /blog/:slug
```

目录结构即路由配置，降低了心智负担。

### 1.4 全栈能力

同一个 Next.js 项目里可以同时写前端页面和后端 API：

```
src/app/
├── page.tsx          ← 前端页面
└── api/
    └── users/
        └── route.ts  ← 后端 API，处理 GET /api/users 请求
```

无需额外搭建 Node.js 后端服务器，一个仓库、一次部署搞定前后端。

### 1.5 内置优化

Next.js 内置了多项生产级优化，开箱即用：

- **图片优化**：`<Image>` 组件自动压缩、懒加载、生成 WebP/AVIF 格式
- **字体优化**：`next/font` 自动内联关键字体，消除字体加载导致的布局偏移（CLS）
- **代码分割**：每个路由自动分割 JS bundle，只加载当前页面需要的代码
- **流式渲染**：结合 Suspense，先发送页面框架，再流式传输数据部分

---

## 二、App Router 目录与特殊文件约定

### 2.1 目录结构总览

```
src/app/                    ← App Router 的根目录
├── layout.tsx              ← 根布局（必须存在，包裹所有页面）
├── page.tsx                ← 首页，URL: /
├── globals.css             ← 全局样式
│
├── about/
│   └── page.tsx            ← URL: /about
│
├── blog/
│   ├── layout.tsx          ← 博客专属布局（嵌套）
│   ├── page.tsx            ← URL: /blog
│   ├── loading.tsx         ← 博客列表加载状态
│   └── [slug]/
│       ├── page.tsx        ← URL: /blog/任意值
│       └── not-found.tsx   ← 文章不存在时的 404
│
├── (auth)/                 ← 路由组（括号不计入 URL）
│   ├── login/page.tsx      ← URL: /login（不是 /auth/login）
│   └── register/page.tsx   ← URL: /register
│
└── api/
    └── hello/
        └── route.ts        ← API 端点，URL: /api/hello
```

### 2.2 特殊文件名一览表

| 文件名 | 作用 | 是否必须 | 渲染位置 |
|--------|------|----------|----------|
| `page.tsx` | 定义路由页面，是该 URL 的唯一入口 | 有路由才需要 | 服务端（默认） |
| `layout.tsx` | 共享布局，包裹 `children`；切换页面不销毁 | 根布局必须 | 服务端（默认） |
| `loading.tsx` | 路由加载时的骨架屏 / Loading UI | 否 | 服务端（默认） |
| `error.tsx` | 路由级错误边界，捕获渲染错误 | 否 | **客户端（必须加 `"use client"`）** |
| `not-found.tsx` | 自定义 404 页面 | 否 | 服务端（默认） |
| `route.ts` | API 端点，处理 HTTP 请求 | 否 | 服务端（Node.js 环境） |
| `template.tsx` | 类似 layout，但每次切换路由都重新挂载 | 否 | 服务端（默认） |
| `default.tsx` | 并行路由的默认插槽内容 | 按需 | 服务端（默认） |

> **注意**：`page.tsx` 和 `route.ts` 不能在同一目录下同时存在。

### 2.3 布局嵌套规则

布局是可嵌套的，子目录的 `layout.tsx` 会被父级 `layout.tsx` 包裹：

```
根布局 (app/layout.tsx)
  └─ 博客布局 (app/blog/layout.tsx)
       └─ 博客文章页 (app/blog/[slug]/page.tsx)
```

最终渲染结果相当于：

```tsx
<RootLayout>
  <BlogLayout>
    <BlogPostPage />
  </BlogLayout>
</RootLayout>
```

---

## 三、渲染模型：服务端组件简介

### 3.1 什么是服务端组件（Server Component）

React Server Components（RSC）是 React 19 引入的新范式，App Router 全面采用：

- **默认行为**：`src/app` 下的所有组件（`page.tsx`、`layout.tsx` 等）默认都是服务端组件，无需任何声明。
- **运行位置**：服务器上的 Node.js 环境，组件代码不会发送到浏览器。
- **能力**：可以直接 `await` 数据库查询、读取文件系统、访问环境变量——因为运行在服务器上。
- **限制**：不能使用 `useState`、`useEffect`、事件监听器（`onClick` 等）——这些是客户端浏览器的能力。

### 3.2 什么是客户端组件（Client Component）

在文件顶部加上 `"use client"` 指令，该组件就变为客户端组件：

```tsx
"use client";  // ← 这一行让组件在客户端运行

import { useState } from "react";

export default function Counter() {
  const [count, setCount] = useState(0);  // ✅ 客户端组件可以用 hooks
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
```

### 3.3 两者的选择原则

| 需求 | 推荐组件类型 |
|------|------------|
| 获取数据（数据库、API） | 服务端组件 |
| 访问敏感配置（API Key） | 服务端组件 |
| 渲染无交互的静态内容 | 服务端组件 |
| 使用 `useState` / `useReducer` | 客户端组件 |
| 使用 `useEffect` | 客户端组件 |
| 处理点击、输入等浏览器事件 | 客户端组件 |
| 使用浏览器 API（`window`、`localStorage`） | 客户端组件 |

> **最佳实践**：尽量保持组件为服务端组件，只在真正需要交互的叶子节点处使用 `"use client"`。这样可以最小化客户端 JavaScript 体积。

---

## 四、运行方式

### 4.1 前置条件

- Node.js 18.17+（推荐 20 LTS 或 22）
- 包管理器：`npm`、`yarn` 或 `pnpm`（本章项目使用 `npm`）

### 4.2 创建新项目

```bash
# 使用官方脚手架（推荐）
npx create-next-app@latest my-app

# 交互式选项建议：
# ✔ Would you like to use TypeScript? › Yes
# ✔ Would you like to use ESLint? › Yes
# ✔ Would you like to use Tailwind CSS? › No（本教程不用）
# ✔ Would you like your code inside a `src/` directory? › Yes
# ✔ Would you like to use App Router? › Yes
# ✔ Would you like to use Turbopack? › Yes（更快的开发构建）
# ✔ Would you like to customize the import alias? › No
```

### 4.3 常用命令

```bash
npm run dev    # 启动开发服务器（默认 http://localhost:3000，热更新）
npm run build  # 构建生产版本（输出到 .next/ 目录）
npm start      # 运行构建后的生产服务器（需先执行 build）
npm run lint   # 运行 ESLint 检查代码质量
```

---

## 五、常见疑问

**Q：`src/app` 和 `app` 有什么区别？**  
A：功能完全相同。使用 `src/` 子目录是一个常见的代码组织习惯，把所有源代码集中在 `src/` 下，与配置文件（`package.json`、`next.config.mjs`）分离，结构更清晰。本教程使用 `src/app`。

**Q：可以同时使用 App Router 和 Pages Router 吗？**  
A：可以，Next.js 支持两者共存（用于渐进式迁移）。但新项目直接使用 App Router 即可，不要混用。

**Q：服务端组件里能用 `console.log` 吗？**  
A：可以，但输出会出现在**服务器终端**（运行 `npm run dev` 的命令行窗口），而不是浏览器的 DevTools 控制台。客户端组件的 `console.log` 才出现在浏览器控制台。

**Q：`layout.tsx` 和 `template.tsx` 有什么区别？**  
A：`layout.tsx` 在路由切换时保持挂载状态（不销毁），适合导航栏等需要保持状态的 UI。`template.tsx` 每次路由切换都会重新创建实例，适合需要重置状态的场景（如动画）。

**Q：为什么 `error.tsx` 必须是客户端组件？**  
A：React 的错误边界（`componentDidCatch`）目前只在客户端工作，所以 Next.js 要求 `error.tsx` 必须加 `"use client"` 指令。

**Q：`npm run dev` 和 `npm run dev -- --turbopack` 有什么区别？**  
A：Turbopack 是 Next.js 的新一代打包器（Rust 编写），比 Webpack 快很多。新项目创建时选择 Turbopack 后，`npm run dev` 就已经默认使用它了；也可以手动加 `--turbopack` 标志启用。

---

## 六、小练习

完成以下练习，巩固本章知识：

### 练习 1：新建 `/hello` 路由

在本章项目中创建一个新页面，访问 `http://localhost:3000/hello` 时显示「Hello, World!」。

**步骤提示：**

1. 在 `src/app/` 下新建目录 `hello/`
2. 在 `hello/` 目录下创建 `page.tsx`
3. 在 `page.tsx` 中默认导出一个组件，返回 `<h1>Hello, World!</h1>`
4. 运行 `npm run dev`，访问 `http://localhost:3000/hello` 验证

**参考代码：**

```tsx
// src/app/hello/page.tsx

// 这是一个服务端组件（默认，无需声明）
export default function HelloPage() {
  return (
    <div>
      <h1>Hello, World!</h1>
      <p>这是我的第一个 Next.js 页面！</p>
    </div>
  );
}
```

### 练习 2：添加专属布局

为 `/hello` 页面添加一个布局，在页面内容上方显示一个固定的顶部横幅。

**步骤提示：**

1. 在 `src/app/hello/` 下创建 `layout.tsx`
2. 布局组件接收 `children` 参数并渲染它
3. 在 `children` 上方添加一个 `<div>` 横幅

**思考：** 这个布局只影响 `/hello` 路由，不影响其他页面。为什么？

### 练习 3：观察服务端渲染

1. 运行本章项目后，访问 `http://localhost:3000`
2. 按 `Ctrl+U`（或右键 → 查看页面源代码）
3. 在源代码中搜索「你好，Next.js！」
4. 确认这段文字已经出现在 HTML 中，而不是由 JavaScript 动态插入

**对比实验（可选）：** 如果你有纯 React SPA 项目，查看它的页面源代码，会发现 `<div id="root"></div>` 是空的，内容全靠 JS 填充。

---

## 七、章节知识图谱

```
Next.js
├── 渲染方式
│   ├── SSR（服务端实时渲染）
│   ├── SSG（构建时静态生成）
│   └── ISR（增量静态再生成）
│
├── 路由系统
│   ├── App Router（本教程）← src/app/
│   └── Pages Router（旧）← pages/
│
├── App Router 核心
│   ├── 文件即路由（目录名 = URL 路径）
│   ├── 特殊文件（page / layout / loading / error / route）
│   └── 组件模型
│       ├── 服务端组件（默认，无 "use client"）
│       └── 客户端组件（需要 "use client"）
│
└── 开发工具
    ├── npm run dev（开发服务器，热更新）
    ├── npm run build（生产构建）
    └── npm start（生产服务器）
```
