# 第 05 章 · 数据获取与缓存（独立项目）

Next.js App Router 数据获取与缓存的独立可运行演示，涵盖 async 服务端组件直接取数、`<Suspense>` streaming、以及 `fetch()` 三种缓存策略。

---

## 如何运行

```bash
# 进入本项目目录
cd learn/nextjs/chapter-05-data-fetching

# 安装依赖（首次）
npm install
# 或使用 pnpm / yarn

# 开发模式（热更新）
npm run dev

# 访问
open http://localhost:3000
```

> 打开页面后，注意观察：页面外壳（标题、用户卡片）约 800ms 后先出现，统计数据区块约 1.5 秒后才流式补充进来——这就是 Suspense streaming 的效果。

---

## 文件清单与作用

| 文件 | 必需 | 作用 |
|---|:---:|---|
| `src/app/page.tsx` | 是 | 根路由 `/`，页面主体：async 取数 + Suspense + fetch 缓存示例 |
| `src/app/layout.tsx` | 是 | 根布局，引入 globals.css，提供全局类（`card` / `demo-box` / `muted` / `tag`） |
| `src/app/globals.css` | 是 | 全局样式，定义 CSS 变量与上述工具类 |
| `next.config.mjs` | 是 | Next.js 配置文件 |
| `tsconfig.json` | 是 | TypeScript 配置 |
| `package.json` | 是 | 项目元信息与依赖声明 |
| `next-env.d.ts` | 是 | Next.js 自动生成的类型声明，勿手动修改 |
| `.gitignore` | 否 | 忽略 node_modules / .next 等构建产物 |
| `notes.md` | 否 | 本章知识点详细笔记（见下方） |
| `README.md` | 否 | 本文件 |

---

## 要点摘要

### async 服务端组件直接取数

服务端组件（Server Component）是普通的 async 函数，可以在顶层直接 `await`，无需 `useState` / `useEffect`：

```tsx
export default async function Page() {
  const user = await db.users.findFirst(); // 服务端执行，密钥不泄露
  return <div>{user.name}</div>;
}
```

数据在服务器上取好后再生成 HTML，浏览器拿到的是已填充数据的页面——零客户端二次请求，对 SEO 友好。

### fetch() 三种缓存策略

| 策略 | 写法 | 行为 |
|---|---|---|
| 实时（动态渲染） | `{ cache: "no-store" }` | 每次请求重新获取，不缓存 |
| 永久缓存（静态渲染） | `{ cache: "force-cache" }` | 构建时或首次后缓存，除非重新部署 |
| ISR 定时重验 | `{ next: { revalidate: 60 } }` | 60 秒后后台悄悄刷新，用户始终秒开 |

> **Next.js 15 注意**：`fetch()` 的默认行为已从 `force-cache` 改为 `no-store`，需要缓存必须显式声明。

### Suspense + Streaming

用 `<Suspense fallback={...}>` 包裹慢 async 组件，可让页面外壳先到达浏览器，慢内容数据就绪后再流式追加：

```tsx
<Suspense fallback={<div>加载中...</div>}>
  <SlowStats /> {/* async 组件，内部 await 1.5s */}
</Suspense>
```

用户感知首屏从「等最慢的数据」变为「外壳立刻可见，数据渐进填充」。

---

## 详细知识点

完整笔记见 [notes.md](./notes.md)，内容包括：

- 服务端取数 vs 客户端取数对比表
- 三种缓存模式的原理与适用场景
- 静态渲染 vs 动态渲染的判断机制
- Suspense streaming 渲染时间线图解
- 常见坑：`"use client"` 组件里不能顶层 await、缓存导致看到旧数据、Next.js 15 默认行为变化、循环中串行 await
- 小练习与思考题
- 关键词速查表
