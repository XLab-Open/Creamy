# Next.js 学习教程（App Router · 由浅入深）

一套面向初学者、循序渐进的 Next.js 教程。**每一章都是一个独立、完整、可单独运行的 Next.js 项目**——这样你能清楚看到「一个完整的 Next.js 项目到底需要哪些文件」，而不是被一个大工程绕晕。

```
learn/nextjs/
├── README.md                      ← 你在这里（总目录）
├── chapter-01-getting-started/    ← 独立项目，自带全部配置文件
├── chapter-02-routing/            ← 又一个独立项目
├── ...
└── chapter-09-styling-metadata/
```

每个章节目录里都有：

| 文件 | 作用 |
| ---- | ---- |
| `package.json` | 依赖（next/react/react-dom）与脚本（dev/build/start）。**每个项目必需** |
| `next.config.mjs` | Next.js 配置（可选，留空也能跑） |
| `tsconfig.json` | TypeScript 配置（用 TS 时需要） |
| `next-env.d.ts` | Next 自动生成的类型声明，无需手改 |
| `.gitignore` | 忽略 `node_modules`、`.next` 等 |
| `src/app/layout.tsx` | **根布局，必需**，必须渲染 `<html>`/`<body>` |
| `src/app/page.tsx` | **根路由 `/` 页面，必需** |
| `src/app/globals.css` | 全局样式 |
| `src/app/...` | 本章特有的页面/接口/组件（demo 源码，含详细中文注释） |
| `README.md` | 本章如何运行 + 完整文件清单说明 |
| `notes.md` | 本章知识点笔记 |

> 💡 **最小可运行项目**只需三个文件：`package.json` + `src/app/layout.tsx` + `src/app/page.tsx`。其余都是增强。第 01 章对此有详细说明。

## 如何运行某一章

每章都是独立项目，**各自安装依赖、各自启动**：

```bash
cd learn/nextjs/chapter-01-getting-started   # 进入想学的章节
npm install                                  # 安装该章依赖
npm run dev                                   # 启动开发服务器
# 打开 http://localhost:3000
```

学完一章再进入下一章，重复 `npm install && npm run dev` 即可。

> 环境要求：Node.js 18.18+（推荐 20/22+）。包管理器 npm / pnpm / yarn 均可。

## 章节总览

| 章 | 目录 | 学到什么 |
| -- | ---- | -------- |
| 01 | `chapter-01-getting-started` | Next.js 是什么、一个完整项目需要哪些文件、第一个页面 |
| 02 | `chapter-02-routing` | 文件即路由、`page`/`layout`、`<Link>` 客户端导航、嵌套子路由 |
| 03 | `chapter-03-dynamic-routes` | `[id]`、`[...slug]`、`generateStaticParams`（Next 15 中 `params` 是 Promise） |
| 04 | `chapter-04-server-client-components` | RSC 默认服务端、`"use client"` 边界、二者组合 |
| 05 | `chapter-05-data-fetching` | `async` 组件直接 `await` 取数、缓存/重新验证、`<Suspense>` streaming |
| 06 | `chapter-06-route-handlers` | `route.ts` 写 GET/POST 接口、读参数、返回 JSON |
| 07 | `chapter-07-loading-error-ui` | `loading.tsx`、`error.tsx`、`not-found.tsx` 特殊文件 |
| 08 | `chapter-08-server-actions` | `"use server"`、表单 `action`、`useActionState` 数据变更 |
| 09 | `chapter-09-styling-metadata` | CSS Modules/全局样式、Metadata API、`middleware` |

## 学习建议

1. **按顺序学**：每一章都假设你掌握了前面的内容。
2. **三步走**：先读该章 `README.md` 看「需要哪些文件、怎么跑」→ 启动 demo 看效果 → 对照 `src/app/` 源码（含详细中文注释）→ 读 `notes.md` 深入知识点。
3. **动手改**：`npm run dev` 支持热更新，改一行立刻见效，这是最快的学习方式。

> 本教程基于 **Next.js 15 App Router** 编写，已全部通过 `next build` 验证。API 以官方文档 <https://nextjs.org/docs> 为准。
