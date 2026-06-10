# 第 02 章 · 路由基础：页面、布局与导航

> 笔记日期：2025 年  
> 适用版本：Next.js 15 · App Router · React 19

---

## 本章目标

1. 理解 App Router 的文件系统路由规则，能根据 URL 推断文件位置，反之亦然。
2. 区分 `page.tsx`、`layout.tsx` 与根布局的职责，知道什么该放哪里。
3. 理解根布局与状态保留的机制，建立正确的渲染层级心智模型。
4. 掌握 `<Link>` 的客户端导航与预取，能替换项目里所有不合适的 `<a>` 标签。
5. 知道 `useRouter` 和 `usePathname` 的存在场景（客户端 hook，不在本章深挖）。

---

## 一、文件系统路由规则

App Router 把 `src/app/` 目录当作路由树的根。每一层文件夹就是 URL 的一段，规则极其简单：

```
文件夹路径（相对 src/app/）   →    URL（本项目）
─────────────────────────────────────────────
/                            →    /
/about                       →    /about
```

**核心约定：只有包含 `page.tsx`（或 `page.js`）的文件夹才会生成一个可公开访问的路由。**  
没有 `page.tsx` 的文件夹只是 URL 的中间层级，直接访问会得到 404。

### 特殊文件（约定文件名）

| 文件名 | 作用 |
|---|---|
| `page.tsx` | 定义该路径的页面内容，使路径可访问 |
| `layout.tsx` | 定义该路径及所有子路径共享的外壳（必须渲染 `children`）|
| `loading.tsx` | 该路由段的 Suspense 骨架屏（第 07 章详述）|
| `error.tsx` | 该路由段的错误边界（需加 `"use client"`）（第 07 章详述）|
| `not-found.tsx` | 自定义 404 界面（第 07 章详述）|
| `route.ts` | API 路由处理程序（第 06 章详述）|

---

## 二、page.tsx 详解

`page.tsx` 是路由的「内容层」。每次用户访问对应 URL，Next.js 就会渲染这个文件导出的组件，并将结果嵌入外层的 layout。

```tsx
// src/app/page.tsx  →  URL: /
// 这是一个服务端组件（Server Component），无需任何声明，默认即是
export default function HomePage() {
  return <h1>首页</h1>;
}
```

**props 约定**（动态路由时会用到）：

```tsx
// 静态路由的 page 一般不需要 props
// 动态路由（[id] 文件夹）时 page 会收到 params
export default async function PostPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const { page = "1" } = await searchParams;
  // ...
}
```

---

## 三、layout.tsx 详解

`layout.tsx` 是路由的「外壳层」。它包裹该路由段及所有子路由，在子页面切换时**不会重新渲染**。

```tsx
// src/app/layout.tsx  →  根布局，全站共享
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        {/* 顶部栏、全局导航等共享 UI */}
        <nav>...</nav>
        {/* children 是当前匹配到的子页面 */}
        <main>{children}</main>
      </body>
    </html>
  );
}
```

### 根布局 vs 嵌套布局

| 对比项 | 根布局 `src/app/layout.tsx` | 嵌套布局 `src/app/xxx/layout.tsx` |
|---|---|---|
| 必须有 | 是，App Router 要求 | 否，按需创建 |
| 渲染 `<html>/<body>` | 必须 | 绝对不能 |
| 作用范围 | 全站所有页面 | 仅该路由段及子路由 |
| 状态保留 | 整个应用生命周期内保持挂载 | 在该路由段内的子页面切换时保持挂载 |

---

## 四、根布局与状态保留

这是 App Router 最重要的行为特征之一，初学者容易忽视。

### 渲染树结构（本项目）

当用户访问 `/about` 时，Next.js 构造如下组件树：

```
<RootLayout>     ← src/app/layout.tsx
  <AboutPage />  ← src/app/about/page.tsx
</RootLayout>
```

当用户点击 Link 切换到 `/` 时，组件树变为：

```
<RootLayout>       ← 没有重新挂载（实例复用）
  <HomePage />     ← 只有这层被替换
</RootLayout>
```

**结论：只有最深层匹配到新页面的 `page` 组件被替换，上层所有 layout 均保持挂载。**

这意味着：
- layout 里的 `useState`/`useRef` 等状态在子页切换时不会丢失。
- layout 里的网络请求（如果有的话）不会因子页切换而重复发起。
- 共享 UI（导航栏、顶部栏）不会闪烁或消失。

---

## 五、`<Link>` 客户端导航与预取

### 为什么不用 `<a>`？

原生 `<a href="...">` 会触发浏览器的全页面导航：
1. 当前页面卸载，JS 上下文销毁。
2. 浏览器向服务器请求新 HTML。
3. 整个页面重新解析、重新渲染（白屏时间）。

这在 SPA 时代是不可接受的体验。

### `<Link>` 的工作原理

```tsx
import Link from "next/link";

// 基本用法：与 <a> 几乎相同，但行为截然不同
<Link href="/about">关于页</Link>

// 带 className、style 等原生属性
<Link href="/about" className="btn">关于我们</Link>

// 动态路径（模板字符串）
<Link href={`/blog/${post.id}`}>{post.title}</Link>
```

Next.js 的 `<Link>` 最终会渲染为 `<a>`，但拦截了点击事件，改为：
1. 用 History API 更新 URL（无页面刷新）。
2. 只向服务器请求新页面对应的 React Server Component payload。
3. 把新 `page` 组件插入已有的 layout 树，其余部分不变。

### 预取（Prefetching）

在**生产模式**下（`next build && next start`），当 `<Link>` 进入浏览器视口时，Next.js 会自动在后台预取目标页面的数据。用户点击时，数据几乎已经就绪，跳转体验近乎瞬间。

开发模式（`next dev`）下预取行为不同（为避免干扰开发），不要用开发模式测试预取效果。

可以显式控制预取行为：

```tsx
// 禁用预取（适合需要登录鉴权的页面，避免发起未授权请求）
<Link href="/dashboard" prefetch={false}>仪表盘</Link>
```

---

## 六、useRouter 与 usePathname（简介）

有时你需要在代码里**程序化地导航**（例如表单提交后跳转），或者**读取当前 URL**（例如高亮当前导航项），这时需要用到 Next.js 提供的客户端 hook。

**重要：这两个 hook 必须在客户端组件（即文件顶部有 `"use client"` 声明的组件）中使用。不能在服务端组件中调用。**

```tsx
"use client"; // 必须声明

import { useRouter, usePathname } from "next/navigation"; // 注意来源是 next/navigation

export default function MyClientComponent() {
  const router = useRouter();
  const pathname = usePathname(); // 当前路径，如 "/about"

  function handleClick() {
    // 程序化导航，等价于 <Link>，但可以在事件处理函数里调用
    router.push("/");
  }

  return (
    <div>
      <p>当前路径：{pathname}</p>
      <button onClick={handleClick}>返回概览</button>
    </div>
  );
}
```

> 第 04 章（服务端组件 vs 客户端组件）会详细讲解 `"use client"` 边界。本章点到为止，先建立「hook 只能在客户端组件里用」的印象即可。

---

## 七、常见坑

### 1. layout 忘记渲染 children

```tsx
// ❌ 错误：children 没有渲染，子页面内容消失
export default function Layout({ children }: { children: React.ReactNode }) {
  return <div>导航栏</div>;
}

// ✅ 正确：必须把 children 放进去
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <nav>导航栏</nav>
      {children}
    </div>
  );
}
```

### 2. 嵌套 layout 里写了 `<html>/<body>`

```tsx
// ❌ 错误：嵌套 layout 不能有 html/body，会导致 DOM 结构非法
export default function SomeNestedLayout({ children }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}

// ✅ 正确：嵌套 layout 只渲染「内容部分」
export default function SomeNestedLayout({ children }) {
  return <div>{children}</div>;
}
```

### 3. 混淆 `next/link` 和 `next/navigation`

```tsx
import Link from "next/link";        // 组件，用于 JSX 导航链接 ✅
import { useRouter } from "next/navigation"; // hook，用于程序化导航 ✅

// ❌ 不存在的写法（常见错误）
import { Link } from "next/navigation";
import Router from "next/router"; // 这是 Pages Router 的旧写法，App Router 里不用
```

### 4. 文件夹有但没有 page.tsx

```
src/app/
└── blog/
    └── drafts/       ← 没有 page.tsx，访问 /blog/drafts 会 404
        └── utils.ts  ← 放了工具文件，但无法访问
```

如果你需要一个文件夹仅用于组织代码而不产生路由，可以用「路由组」语法 `(groupName)`（第 03 章详述）。

### 5. URL 大小写陷阱

文件系统路由区分大小写（Linux 系统）。`About/page.tsx` 和 `about/page.tsx` 是不同的路由。推荐统一使用小写 + 连字符命名，例如 `about`、`blog-posts`。

---

## 八、小练习

完成以下练习来巩固本章知识：

1. **新增子页面**：在 `src/app/` 下创建 `contact/page.tsx`，添加一个联系页面，URL 应为 `/contact`。在根布局的子导航里加上指向它的 `<Link>`。

2. **验证状态保留**：在 `src/app/layout.tsx` 里加一个 `useState` 计数器（需加 `"use client"`，或抽成独立客户端组件），在页面之间切换，观察计数值是否保留。

3. **禁用预取**：找到概览页的「前往关于子页」链接，加上 `prefetch={false}`，用 Network 面板对比有无预取时的请求时机差异（需在生产模式下测试）。

4. **程序化导航**：把「关于页」的返回链接改为一个 `<button>`，通过 `useRouter().push()` 实现相同效果（注意需要加 `"use client"`）。

---

## 九、关键词速查

| 术语 | 含义 |
|---|---|
| App Router | Next.js 13+ 引入的新路由系统，基于 `src/app/` 目录 |
| Route Segment | 路由段，文件夹层级对应 URL 的一段 |
| Server Component | 服务端组件，在服务器渲染，默认类型，无法使用浏览器 API 和 hook |
| Client Component | 客户端组件，需加 `"use client"`，可使用 hook 和浏览器 API |
| Prefetching | 预取，Link 进入视口时提前下载目标页数据，加速跳转 |
| History API | 浏览器内置 API，允许修改 URL 而不刷新页面 |
| `children` prop | layout 接收的插槽，代表当前匹配到的子内容 |
