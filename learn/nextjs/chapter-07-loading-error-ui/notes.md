# 第 07 章笔记：加载、错误与 404 UI

## 一、App Router 特殊文件全景

App Router 通过约定文件名来处理路由不同状态下的 UI 呈现。除了最常用的 `page.tsx` 和 `layout.tsx`，还有以下特殊文件：

| 文件名 | 作用 | 必须客户端？ | HTTP 状态码 |
|---|---|---|---|
| `page.tsx` | 定义路由的可访问页面内容 | 否（默认服务端） | 200 |
| `layout.tsx` | 定义共享外壳，跨导航保持挂载 | 否（默认服务端） | — |
| `loading.tsx` | 基于 Suspense 的加载占位 UI | 否（默认服务端） | — |
| `error.tsx` | 捕获渲染期错误的错误边界 | **是（必须加 "use client"）** | 500 |
| `not-found.tsx` | 资源找不到时的 404 UI | 否（默认服务端） | 404 |
| `template.tsx` | 类似 layout，但每次导航都会重新挂载 | 否（默认服务端） | — |
| `global-error.tsx` | 捕获根布局级别的错误 | **是（必须加 "use client"）** | 500 |

这些文件都遵循「就近原则」：它们只影响同级路由段及其子路由，不同层级可以有各自独立的特殊文件。

### layout vs template

- `layout.tsx`：子路由之间切换时，layout **不会重新挂载**，状态保留（如输入框内容、scroll 位置）。
- `template.tsx`：每次导航时都会**重新挂载**，适合需要进入动画或每次都要重置状态的场景。大多数情况下用 layout，特殊场景才用 template。

---

## 二、loading.tsx 与 React Suspense 的关系

### 工作原理

`loading.tsx` 本质上是 Next.js 对 React Suspense 的自动化封装。当你在一个路由段下放置 `loading.tsx` 时，Next.js 会自动把同级的 `page.tsx` 和 `layout.tsx` 包裹在 `<Suspense>` 组件里：

```tsx
// Next.js 在背后做的事（伪代码）：
<Suspense fallback={<YourLoadingComponent />}>
  <Page />
</Suspense>
```

你无需手动写这段代码，只需提供 `loading.tsx` 文件。

### 触发条件

`loading.tsx` 生效的前提是同级的 `page.tsx`（或其子组件）是 async 函数组件，且内部有 `await` 操作使组件「挂起」。如果 `page.tsx` 是同步的，`loading.tsx` 永远不会显示。

### 流式渲染（Streaming）

loading + Suspense 配合 React 18 的流式渲染（Streaming SSR）工作：

1. 服务器立即把包含 `loading.tsx` 内容的 HTML 推送给浏览器（首字节响应快）。
2. 用户立刻看到加载状态，页面不会空白。
3. 服务器继续在后台执行 async page 的数据获取。
4. 数据就绪后，Next.js 通过流把真实内容追加到 HTTP 响应里，React 在客户端替换占位内容。

这与传统 SSR（等所有数据都好了再一次性响应）有本质区别：用户感知到的「首屏时间」大幅缩短。

### 手动 Suspense vs loading.tsx

两者可以并存：

- `loading.tsx` 是路由段级别的粗粒度 Suspense，整个页面作为一个整体等待。
- 手动 `<Suspense>` 是组件级别的细粒度控制，页面中不同数据块可以独立加载、独立显示。

推荐实践：对于页面骨架用 `loading.tsx`，对于页面内某个数据区块（如侧边栏推荐、评论列表）用手动 `<Suspense>` 包裹。

---

## 三、error.tsx：错误边界

### 为什么必须是客户端组件

React 的错误边界（Error Boundary）机制依赖客户端 React 运行时的特定 API（`componentDidCatch` 或等价的 Hook 实现）。服务端组件在服务器上以流水线方式渲染，不存在「捕获错误后继续渲染」的运行时状态机。因此：

- **`error.tsx` 第一行必须是 `"use client"`**，没有例外。
- 遗漏这一行，Next.js 构建时会直接报错。

### Props 详解

```tsx
"use client";

export default function ErrorUI({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // ...
}
```

**`error` 对象：**
- `error.message`：错误的文字描述。
- `error.digest`：Next.js 生成的服务端错误摘要 ID（字符串哈希）。在生产模式下，错误的真实 message 不会暴露给客户端（避免泄露内部信息），但 `digest` 会保留，让你可以在服务端日志中关联追踪。开发模式下 message 正常显示。

**`reset` 函数：**
- 调用 `reset()` 会让 Next.js 清除错误状态，并重新尝试渲染该路由段（重新执行 `page.tsx`）。
- 如果错误是偶发的（如瞬时网络请求失败），重试可能恢复正常。
- 如果错误是必现的（逻辑 bug），重试只会再次触发错误边界。
- `reset()` 常与按钮结合使用，给用户一个「重试」的交互机会。

### 错误冒泡规则

错误沿路由树向上冒泡，被最近的 `error.tsx` 捕获：

```
src/app/
├── error.tsx          ← 第 3 层：最后兜底（但捕获不了根 layout 的错误）
└── dashboard/
    ├── error.tsx      ← 第 2 层：捕获 dashboard/ 及其所有子路由的错误
    └── settings/
        ├── error.tsx  ← 第 1 层：优先捕获 settings/ 的错误
        └── page.tsx   ← 如果这里 throw，被第 1 层捕获
```

**关键细节：** `error.tsx` 捕获的是 `page.tsx` 和同级子组件的错误，**但不捕获同级 `layout.tsx` 的错误**。这是因为 error.tsx 在 React 树中被包裹在 layout 的内部，layout 出错时 error.tsx 还没挂载。

### global-error.tsx

`src/app/global-error.tsx`（放在根 app 目录）用于捕获根 `layout.tsx` 的错误。它必须自己渲染 `<html>` 和 `<body>`，因为这时根 layout 已经出错、无法使用。这是最后的兜底，实际中很少触发。

---

## 四、not-found.tsx 与 notFound()

### notFound() 的语义

`notFound()` 来自 `next/navigation`，语义是「这个资源不存在」，而不是「发生了错误」。两者的区别非常重要：

| 情况 | 正确做法 | 错误做法 |
|---|---|---|
| 按 ID 查询数据库，结果为 null | `notFound()` | `throw new Error("not found")` |
| 数据库连接失败 | `throw new Error(...)` | `notFound()` |
| 数据格式解析异常 | `throw new Error(...)` | `notFound()` |
| 参数合法但对应资源已删除 | `notFound()` | `throw new Error(...)` |

### 典型使用模式

```tsx
import { notFound } from "next/navigation";

export default async function ProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const product = await db.products.findById(id);

  // 资源不存在：用 notFound()，HTTP 状态码会是 404
  if (!product) {
    notFound();
  }

  // notFound() 返回类型是 never，TypeScript 知道此后 product 一定非 null
  return <ProductDetail product={product} />;
}
```

### not-found.tsx 的查找顺序

Next.js 会从当前路由段向上查找最近的 `not-found.tsx`：

1. 当前目录的 `not-found.tsx`（最优先）
2. 父目录的 `not-found.tsx`
3. 根目录 `src/app/not-found.tsx`（Next.js 全局 404）
4. Next.js 内置默认 404 页（如果以上都不存在）

---

## 五、常见坑

### 坑 1：error.tsx 忘写 "use client"

```tsx
// 错误写法——缺少第一行
export default function ErrorUI({ error, reset }) { ... }

// 正确写法
"use client";
export default function ErrorUI({ error, reset }) { ... }
```

Next.js 会在构建阶段报错，开发时也会有明显警告。

### 坑 2：混用 notFound() 和 throw Error

资源不存在不应该 throw，发生错误不应该 notFound()。语义错误会导致：
- HTTP 状态码不对（404 vs 500），影响 SEO 和监控报警。
- 错误被错误的边界捕获（not-found.tsx vs error.tsx），显示不一致。

### 坑 3：error.tsx 无法捕获同级 layout 的错误

如果 `layout.tsx` 里 throw 了错误，同级的 `error.tsx` **无法**捕获它（因为 error.tsx 被嵌套在 layout 内部的 React 树中）。需要在父级放 `error.tsx`，或使用 `global-error.tsx`。

### 坑 4：loading.tsx 不生效——page.tsx 是同步组件

```tsx
// 不会触发 loading.tsx——同步函数，没有挂起
export default function Page() {
  return <div>内容</div>;
}

// 会触发 loading.tsx——async 函数 + await，会挂起
export default async function Page() {
  const data = await fetchData();
  return <div>{data}</div>;
}
```

### 坑 5：在 error.tsx 里访问服务端数据

`error.tsx` 是客户端组件，它不能直接 `await fetch(...)` 或访问数据库。如果需要在错误 UI 里展示额外信息，只能用 `error.message`、`error.digest`，或通过 `searchParams` 传递简单参数。

### 坑 6：reset() 并不等于刷新页面

`reset()` 只是重新尝试渲染**该路由段**（等效于 React 错误边界的 `setState` 清除错误状态并重渲染）。它不会重新发起完整的 HTTP 请求，也不会重置父级 layout 的状态。若需要完整刷新，使用 `window.location.reload()` 或 `router.refresh()`。

---

## 六、小练习

1. **基础练习**：在 `slow/page.tsx` 中，把等待时间改为 3000ms，重新访问 `/slow`，观察 `loading.tsx` 停留更长时间。

2. **样式练习**：修改 `slow/loading.tsx`，把纯文字占位换成「骨架屏」——用几个灰色方块模拟真实内容的形状（标题一个宽条，正文三个窄条）。

3. **条件触发练习**：修改 `broken/page.tsx`，改为根据 URL 的 `searchParams` 决定是否 throw：`/broken?fail=true` 时 throw，否则正常渲染内容。提示：page.tsx 可以接受 `searchParams` prop。

4. **notFound 练习**：在 `missing/page.tsx` 中，改为接受 `searchParams`，只有当 `?id=` 参数不是 `"1"` 时才调用 `notFound()`，否则正常显示内容（模拟按 ID 查询的真实逻辑）。

5. **思考题**：如果 `src/app/layout.tsx` 里的某个组件 throw 了错误，哪个文件可以捕获它？`src/app/error.tsx` 能捕获吗？答案是不能，需要 `src/app/global-error.tsx`——试着创建一个验证你的理解。
