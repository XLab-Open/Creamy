# 第 02 章 · 路由基础：页面、布局与导航

> Next.js 15 · App Router · React 19

这是一个**独立、完整、可单独运行**的 Next.js 项目，演示 App Router 的文件系统路由、page/layout 约定、嵌套结构，以及 `<Link>` 客户端导航。

---

## 如何运行

```bash
cd /home/lss/workspace/selflearning/opensource/Creamy/learn/nextjs/chapter-02-routing
npm install
npm run dev
# 打开 http://localhost:3000
```

---

## 本项目文件清单与作用

| 文件 | 必需 | 作用 |
|---|---|---|
| `package.json` | **必需** | 项目元信息与 Next.js 依赖声明 |
| `next.config.mjs` | **必需** | Next.js 配置（本项目保持默认） |
| `tsconfig.json` | **必需** | TypeScript 编译配置 |
| `src/app/globals.css` | **必需** | 全局样式，定义 `card`/`demo-box`/`muted`/`tag`/`btn`/`nav-no`/`topbar`/`content` 等全局类 |
| `src/app/layout.tsx` | **必需** | 根布局——渲染 `<html>`/`<body>`、顶部栏和子导航；所有页面共享，切换子页时不重新渲染 |
| `src/app/page.tsx` | **必需** | 根路由 `/` 的概览页，讲解文件系统路由、page/layout 对比、Link 导航 |
| `src/app/about/page.tsx` | 本章演示的子路由 | `/about` 子页，验证根布局状态保留行为，演示文件夹即路径段 |

---

## 本章要点摘要

1. **文件即路由**：在 `src/app/` 下建文件夹 + `page.tsx`，即注册一个新 URL，无需手动配置路由表。
2. **page.tsx vs layout.tsx**：`page.tsx` 是可访问的页面内容；`layout.tsx` 是共享外壳，必须渲染 `children`，子页切换时不重新挂载。
3. **根布局唯一渲染 `<html>/<body>`**：嵌套 layout（如果有）绝对不能再写 `<html>/<body>`。
4. **`<Link>` 客户端导航**：替代原生 `<a>`，无整页刷新，仅加载差量 chunk，生产模式自动预取视口内链接。
5. **状态保留**：layout 内的 React 状态（`useState`/`useRef`）在子页面切换时不丢失。

---

## 详细知识点

详见 [notes.md](./notes.md)。
