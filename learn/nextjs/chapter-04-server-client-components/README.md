# 第 04 章 · 服务端组件 vs 客户端组件

Next.js App Router 教程第 04 章的独立可运行项目。

## 如何运行

```bash
# 进入本章目录
cd chapter-04-server-client-components

# 安装依赖
npm install
# 或
pnpm install

# 启动开发服务器
npm run dev
# 或
pnpm dev
```

打开浏览器访问 [http://localhost:3000](http://localhost:3000) 即可看到本章内容。

构建生产版本：

```bash
npm run build && npm run start
```

## 本项目文件清单与作用

| 文件 | 必需 | 类型 | 说明 |
|------|:----:|------|------|
| `src/app/layout.tsx` | 是 | 骨架 | 根布局，引入 `globals.css`，提供全局类 `card` / `demo-box` / `muted` / `tag` / `btn` / `nav-no` |
| `src/app/globals.css` | 是 | 骨架 | 全局样式，已由 `layout.tsx` 引入，无需在页面中重复 import |
| `src/app/page.tsx` | 是 | 服务端组件 | 根路由 `/` 的页面。**无 `"use client"` 声明，默认是服务端组件**，在 Node.js 环境执行，代码不进入浏览器 bundle |
| `src/app/Counter.tsx` | 是 | 客户端组件 | 交互式计数器。**第一行 `"use client"` 将其标记为客户端组件**，可使用 `useState`、`onClick` 等浏览器运行时特性 |
| `notes.md` | 否 | 文档 | 本章完整知识点笔记，包含能力对照表、边界概念、常见坑与练习 |
| `README.md` | 否 | 文档 | 本文件 |
| `package.json` | 是 | 配置 | 项目依赖与脚本 |
| `tsconfig.json` | 是 | 配置 | TypeScript 编译选项 |
| `next.config.ts` | 是 | 配置 | Next.js 配置 |

### 为什么 Counter.tsx 是客户端组件？

`Counter.tsx` 的**第一行**是 `"use client"`，这条指令告诉 Next.js：从这个文件开始，向下的整个组件子树在客户端运行。因此它可以使用 `useState`（维护点击状态）和 `onClick` 等事件处理器——这些特性依赖浏览器 JavaScript 运行时，在服务端组件里调用会直接报错。

### 为什么 page.tsx 是服务端组件？

`page.tsx` 顶部**没有** `"use client"` 声明。App Router 的默认规则是：所有组件都是服务端组件，除非显式标记。因此 `page.tsx` 在 Node.js 环境中执行，可以安全地访问后端资源（数据库、环境变量密钥），且其代码逻辑不会出现在发送给浏览器的 JavaScript bundle 中。

## 核心要点

- **默认服务端**：App Router 中所有组件默认是服务端组件（RSC），无需任何声明
- **`"use client"` 是边界**：不是给单个组件打标，而是声明「从此文件向下的子树进入客户端」
- **边界向下传染**：被客户端组件 import 的模块自动进入客户端 bundle，无需逐个声明
- **尽量下沉边界**：把 `"use client"` 放到最小的叶子组件，保持上层为服务端组件以减少 bundle 体积
- **Props 必须可序列化**：服务端组件向客户端组件传递 props 时，数据需能被序列化（字符串、数字、普通对象等），函数不可直接传递
- **客户端组件也做 SSR**：`"use client"` 不等于跳过服务端渲染，客户端组件依然先在服务器生成初始 HTML，再在浏览器 hydrate

## 详细知识点

完整笔记见 [notes.md](./notes.md)，包含：

- RSC 三大核心特性
- `"use client"` 边界的精确含义
- 服务端 vs 客户端能力完整对照表
- Props 序列化规则与示例
- 5 个常见坑及解决方法
- SSR + Hydration 完整数据流图
- 4 个动手练习
