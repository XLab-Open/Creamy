# 第 03 章笔记：动态路由与路由组

## 1. 动态段语法对照表

| 文件夹命名 | 类型 | 匹配示例 | params 中的值 |
|---|---|---|---|
| `[id]` | 单个动态段 | `/products/42` | `{ id: "42" }` |
| `[...slug]` | Catch-all（贪婪，必须至少一段） | `/docs/a/b` | `{ slug: ["a", "b"] }` |
| `[[...slug]]` | 可选 Catch-all（零段也能匹配） | `/shop` 或 `/shop/a/b` | `{ slug: undefined }` 或 `{ slug: ["a","b"] }` |
| `(group)` | 路由组（不出现在 URL 中） | 不影响 URL | 无对应 params |

> 字段名由文件夹方括号内的标识符决定（`[id]` → `id`，`[...slug]` → `slug`）。

---

## 2. Next.js 15 重大变化：params 是 Promise

### 变化背景

Next.js 15 将 `params`（和 `searchParams`）的类型从普通对象改为了 `Promise`，
以支持未来的并发渲染和流式数据特性。这是一个**破坏性变更（Breaking Change）**，
从 Next.js 14 迁移时必须注意。

### 旧写法（Next.js 14，❌ 在 Next.js 15 中不能用）

```tsx
// ❌ 旧写法：直接访问 params，TypeScript 会报错
export default function Page({
  params,
}: {
  params: { id: string };   // ← 类型声明是普通对象
}) {
  const id = params.id;     // ← 旧 API
  return <div>{id}</div>;
}
```

### 新写法（Next.js 15，✅ 正确）

```tsx
// ✅ 新写法：async 组件 + await params
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;   // ← 类型是 Promise
}) {
  const { id } = await params;       // ← 必须 await
  return <div>{id}</div>;
}
```

### searchParams 同理

```tsx
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  return <div>搜索：{q ?? "（无关键词）"}</div>;
}
```

### 类型速查

| 场景 | 类型声明 |
|---|---|
| `[id]` 动态段 | `params: Promise<{ id: string }>` |
| `[...slug]` catch-all | `params: Promise<{ slug: string[] }>` |
| `[[...slug]]` 可选 catch-all | `params: Promise<{ slug?: string[] }>` |
| 多段：`[category]/[id]` | `params: Promise<{ category: string; id: string }>` |

---

## 3. generateStaticParams 与 SSG

### 作用

在动态路由页面中导出 `generateStaticParams` 函数，告诉 Next.js 构建时需要预渲染哪些路径。
Next.js 在执行 `next build` 时调用它，取得参数数组，并为每个参数组合生成一份静态 HTML。

### 基本写法

```tsx
// 在 products/[id]/page.tsx 中
export function generateStaticParams() {
  // 返回所有需要预渲染的参数组合
  return [
    { id: "1" },
    { id: "2" },
    { id: "3" },
  ];
}
```

### 配合数据库（真实场景）

```tsx
export async function generateStaticParams() {
  // 在构建期请求数据库，获取所有产品 id
  const products = await db.products.findMany({ select: { id: true } });
  return products.map((p) => ({ id: String(p.id) }));
}
```

### dynamicParams 控制

```tsx
// 对于没在 generateStaticParams 中列出的路径：
export const dynamicParams = true;   // 默认：运行时动态渲染
export const dynamicParams = false;  // 未列出的路径直接返回 404
```

### SSG vs SSR 对比

| | SSG（generateStaticParams）| SSR（不导出该函数）|
|---|---|---|
| 生成时机 | 构建期（build time）| 请求时（request time）|
| 响应速度 | 极快（CDN 缓存）| 取决于服务器/数据库响应 |
| 数据新鲜度 | 构建时快照 | 实时 |
| 适合场景 | 产品页、文档页等相对稳定的内容 | 用户个人页、实时数据 |

---

## 4. 路由组 (group)：组织文件，不影响 URL

### 语法

把文件夹命名为 `(groupName)`（圆括号包裹），这一层**不会出现在 URL 中**。

### 典型用途

#### 用途 1：让不同页面共享不同的 Layout

```
app/
├── (marketing)/
│   ├── layout.tsx       ← 营销页专用布局（大图头部）
│   ├── about/page.tsx   → URL: /about
│   └── landing/page.tsx → URL: /landing
│
└── (app)/
    ├── layout.tsx       ← 应用页专用布局（侧边栏）
    ├── dashboard/page.tsx → URL: /dashboard
    └── settings/page.tsx  → URL: /settings
```

#### 用途 2：按功能/团队分组文件，方便管理

```
app/
├── (auth)/
│   ├── login/page.tsx
│   └── register/page.tsx
└── (admin)/
    ├── users/page.tsx
    └── reports/page.tsx
```

### 关键点

- 圆括号文件夹名不进入 URL——`(marketing)/about/page.tsx` 路由是 `/about`，不是 `/marketing/about`。
- 同一个路由组内可以共享一个 `layout.tsx`，不同路由组的 layout 互不影响。
- 不同路由组中**不能有相同的 URL 段**，否则构建时报错（URL 冲突）。

---

## 5. 并行路由与拦截路由（简要提及）

Next.js 还提供了更高级的路由机制：
**并行路由**（`@slot` 命名文件夹）可以在同一 layout 中同时渲染多个页面槽；
**拦截路由**（`(.)` / `(..)` 前缀）可以在当前视图内「拦截」另一个 URL 的渲染（典型用例：在图片列表页打开图片时，URL 改变但不跳页，而是用弹窗展示）。这两个特性适合构建复杂的 UI 模态场景，超出本章范围，将在后续章节详细介绍。

---

## 6. 常见坑

### 坑 1：忘记 await params

```tsx
// ❌ 错误：params 是 Promise，直接访问 params.id 得到 undefined
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const id = params.id;          // ← 这是 Promise 对象，没有 .id 属性！
  return <div>{id}</div>;        // 渲染出 undefined 或空白
}

// ✅ 正确
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;   // ← await 之后才是真正的对象
  return <div>{id}</div>;
}
```

### 坑 2：忘记把组件声明为 async

```tsx
// ❌ 错误：非 async 函数内不能使用 await
export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;   // ← 语法错误！
}
```

### 坑 3：catch-all 类型写错

```tsx
// ❌ 错误：catch-all 收到的是数组，不是 string
params: Promise<{ slug: string }>   // ← 错！

// ✅ 正确
params: Promise<{ slug: string[] }> // ← 数组
```

### 坑 4：路由组括号写错

```
(marketing)/         ← ✅ 圆括号，路由组，不出现在 URL
[marketing]/         ← 动态段，URL 中会有这一层！
```

### 坑 5：catch-all 无法匹配父路径本身

```
[...slug] 在 /docs 下时：
  /docs        → ❌ 不匹配（需要至少一个片段）
  /docs/guide  → ✅ 匹配，slug = ["guide"]

解决方案：改用可选 catch-all [[...slug]]，或单独建 /docs/page.tsx
```

### 坑 6：generateStaticParams 中忘记把数字转字符串

```tsx
// ❌ 错误：params 中的值都是 string，不要传 number
return products.map((p) => ({ id: p.id }));          // p.id 如果是 number 会有问题

// ✅ 正确
return products.map((p) => ({ id: String(p.id) }));  // 确保是 string
```

---

## 7. 小练习

1. **基础**：在本项目中创建 `/users/[username]/page.tsx`，
   显示 "你好，{username}！" 并演示 Next.js 15 的 `await params` 写法。

2. **进阶**：为上题页面添加 `generateStaticParams`，预生成 `alice`、`bob`、`charlie` 三个用户的页面。

3. **挑战**：创建一个可选 catch-all 路由 `/shop/[[...filters]]/page.tsx`，
   使其能同时处理 `/shop`（无筛选）和 `/shop/电子产品/手机`（多级筛选）两种 URL。
   展示 `filters` 的值，并解释为什么选用可选 catch-all 而非普通 catch-all。

4. **思考**：如果有两个页面 `(marketing)/blog/page.tsx` 和 `(app)/blog/page.tsx`，
   Next.js 会怎么处理？（答：构建时报错，因为两个文件都对应 URL `/blog`，产生冲突。）
