# 第 01 章 · 起步与项目结构

本章是一个**独立、完整、可单独运行的 Next.js 项目**，演示一个最基础的 App Router 应用由哪些文件组成，以及每个文件的作用。

---

## 如何运行

```bash
# 1. 进入本章目录
cd chapter-01-getting-started

# 2. 安装依赖
npm install

# 3. 启动开发服务器（支持热更新）
npm run dev

# 4. 打开浏览器访问
#    http://localhost:3000
```

---

## 完整文件清单与作用

下表列出本项目的每一个文件，并说明它的作用与是否必需。

| 文件 | 作用 | 必需？ |
|------|------|--------|
| `package.json` | 声明项目依赖（next、react、react-dom）与脚本（dev / build / start / lint）。**没有它，项目无法安装依赖、无法运行。** | **必需** |
| `next.config.mjs` | Next.js 配置文件，可调整构建行为、图片域名白名单、重定向等。默认配置即可运行，此文件可省略。 | 可选 |
| `tsconfig.json` | TypeScript 编译配置，指定 target、路径别名（`@/`）、严格模式等。使用 `.tsx` / `.ts` 文件时需要；纯 JS 项目可省略。 | 用 TS 时需要 |
| `next-env.d.ts` | Next.js 自动生成的 TypeScript 类型声明文件，让编辑器识别 `next/image`、`next/link` 等模块的类型。**不要手动修改或删除。** | 自动生成 |
| `.gitignore` | 告诉 Git 忽略 `node_modules/`、`.next/`、`.env` 等不应提交的文件和目录。 | 可选（强烈建议保留） |
| `src/app/layout.tsx` | **根布局**。App Router 要求根布局必须存在，且必须返回包含 `<html>` 和 `<body>` 标签的结构，并渲染 `{children}`。所有页面都会被这个布局包裹。本文件同时引入了 `globals.css`，提供全局 CSS 类。 | **必需** |
| `src/app/page.tsx` | **根路由页面**。对应 URL `/`，即访问 `http://localhost:3000` 时显示的内容。App Router 中，`page.tsx` 是让一个路径变得「可访问」的唯一方式。 | **必需** |
| `src/app/globals.css` | 全局样式文件，定义了本项目使用的基础样式和工具类（`.card`、`.demo-box`、`.muted`、`.tag`、`.btn`、`.nav-no` 等）。在 `layout.tsx` 中 `import` 一次，全局生效，页面组件无需再次引入。 | 可选（但去掉后样式会丢失） |

---

## 最小可运行项目

虽然本项目包含多个文件，但其实**只要三个文件**，Next.js 就能跑起来：

```
my-app/
├── package.json          ← 1. 声明依赖与脚本
└── src/
    └── app/
        ├── layout.tsx    ← 2. 根布局（含 <html><body>）
        └── page.tsx      ← 3. 根路由页面
```

其余文件都是**增强**：

- `tsconfig.json` — 开启 TypeScript 支持
- `next.config.mjs` — 定制构建行为
- `globals.css` — 添加全局样式
- `.gitignore` — 管理版本控制
- `next-env.d.ts` — 补全 TypeScript 类型（Next.js 自动创建）

---

## 本章知识点

详见 [notes.md](./notes.md)，涵盖 SSR/SSG/ISR 原理、App Router 特殊文件约定、服务端组件与客户端组件的区别等。
