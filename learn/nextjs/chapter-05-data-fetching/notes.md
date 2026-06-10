# 第 05 章 · 数据获取与缓存

> **核心问题**：在 Next.js App Router 中，数据从哪来、怎么缓存、怎么让慢数据不阻塞页面？

---

## 一、服务端组件直接 await 取数

### 为什么这是首选方式？

在传统 React（纯 CSR）中，数据获取几乎总是在客户端完成：

```tsx
// 旧模式（客户端组件）
useEffect(() => {
  fetch("/api/user").then(r => r.json()).then(setUser);
}, []);
```

这带来三个问题：

1. **多一次网络往返**：浏览器要先下载 JS、执行组件，才能发出数据请求。
2. **暴露实现细节**：API 地址、密钥名称等出现在客户端代码里。
3. **loading 状态管理**：必须维护 `isLoading`、`error` 等状态，代码冗余。

Next.js App Router 中，服务端组件（Server Component）是 **async 函数**，可以直接 await：

```tsx
// 新模式（服务端组件）
export default async function Page() {
  const user = await db.users.findFirst();  // 数据库直连，密钥不出服务器
  return <div>{user.name}</div>;
}
```

**优势一览：**

| 对比维度 | 客户端取数（useEffect） | 服务端取数（async 组件） |
|---|---|---|
| 请求时机 | JS 执行后 | 服务器渲染前 |
| 密钥安全 | 需要中间 API 层 | 直接访问，不泄露 |
| 代码量 | 多（状态管理） | 少（直接 await） |
| SEO | 难（内容在 JS 里） | 好（HTML 里有数据） |
| 首屏体验 | 二次请求后才显示 | 一次请求即可 |

---

## 二、fetch() 缓存三种模式

Next.js 对原生 `fetch()` 进行了**扩展**，在第二个参数中增加了缓存控制选项。理解这三种模式，就掌握了 Next.js 数据缓存的核心。

### 模式对照表

| 模式 | 写法 | 渲染策略 | 适用场景 |
|---|---|---|---|
| 实时获取 | `{ cache: "no-store" }` | 动态渲染（每次请求） | 实时数据、用户个性化内容、购物车 |
| 永久缓存 | `{ cache: "force-cache" }` | 静态渲染（构建时或首次） | 几乎不变的公共数据（城市列表、分类导航） |
| 定时重验 | `{ next: { revalidate: N } }` | ISR（增量静态再生成） | 博客文章、产品详情、新闻列表 |

### ① no-store（动态渲染）

```tsx
const res = await fetch("https://api.example.com/cart", {
  cache: "no-store",
});
```

- 每次收到请求，Next.js 都会重新执行 `fetch`，不使用任何缓存。
- 页面被标记为**动态渲染**（Dynamic Rendering）：不能被预渲染成静态 HTML。
- **Next.js 15 重要变化**：`fetch()` 的默认行为已改为 `no-store`（15 以前默认是 `force-cache`）。

### ② force-cache（静态渲染）

```tsx
const res = await fetch("https://api.example.com/categories", {
  cache: "force-cache",
});
```

- 首次获取后结果被缓存，之后的请求直接复用缓存，除非手动清除或重新部署。
- 页面可以在构建时预渲染（Static Site Generation 效果）。
- 适合数据稳定、不需要实时性的场景。

### ③ revalidate（ISR —— 增量静态再生成）

```tsx
const res = await fetch("https://api.example.com/posts", {
  next: { revalidate: 60 },  // 单位：秒
});
```

**ISR 的工作原理（stale-while-revalidate 策略）：**

1. 第一次访问：服务端获取数据，生成 HTML，存入缓存。
2. 60 秒内的后续访问：直接返回缓存的 HTML（极速）。
3. 60 秒后第一次访问：仍返回旧缓存（用户不等待），同时**在后台触发重新获取**。
4. 后台数据获取完成后，缓存更新，下一次访问拿到新数据。

这是「既要快、又要新」场景的最佳方案。用户始终秒开，数据最多落后 N 秒。

### 路由段级别的 revalidate

除了在 `fetch` 里配置，也可以在 `page.tsx` 顶部导出常量，影响整个路由段：

```tsx
// page.tsx 顶部
export const revalidate = 60;          // 整页 ISR，60 秒重验
export const dynamic = "force-dynamic"; // 等价于所有 fetch 都 no-store
```

---

## 三、静态渲染 vs 动态渲染

理解这两个概念是理解 Next.js 性能模型的关键：

**静态渲染（Static Rendering）**
- 发生时机：构建时（`next build`）或首次请求后缓存。
- 结果：预生成的 HTML，CDN 可缓存，响应极快。
- 触发条件：页面中没有动态数据源（所有 fetch 都有缓存，无 cookies()/headers() 调用）。

**动态渲染（Dynamic Rendering）**
- 发生时机：每次请求时实时执行。
- 结果：总是最新数据，但每次都需要服务器计算。
- 触发条件：任何 `no-store` 的 fetch，或调用了 `cookies()`、`headers()` 等动态 API。

**Next.js 会自动判断**：只要页面中存在一个"动态信号"，整张页面就退化为动态渲染。无需手动配置，框架帮你决定。

---

## 四、`<Suspense>` 与 Streaming

### 问题背景

假设一个页面需要两份数据：
- 用户基本信息：100ms
- 用户年度统计：1500ms

如果串行等待，页面要 1600ms 才出现。如果用两个 await 并行（`Promise.all`），仍需等 1500ms 页面才开始渲染。

### Suspense + Streaming 的解法

```tsx
export default async function Page() {
  const user = await getUser();  // 100ms，快

  return (
    <div>
      <UserCard user={user} />  {/* 先渲染这部分 */}

      {/* SlowStats 需要 1500ms，用 Suspense 包裹 */}
      <Suspense fallback={<div>统计加载中...</div>}>
        <SlowStats />  {/* 1500ms 后流式补充进来 */}
      </Suspense>
    </div>
  );
}
```

**渲染时间线：**

```
0ms    → 服务端开始渲染
100ms  → getUser 完成，开始发送外壳 HTML（含 UserCard）
100ms  → 浏览器收到外壳，显示页面和 fallback
1500ms → SlowStats 的数据就绪，服务端流式追加其 HTML
1500ms → 浏览器用真实内容替换 fallback
```

用户在 **100ms** 就看到有内容的页面，而不是等 **1500ms** 看白屏。

### Streaming 的价值

1. **更快的感知首屏（TTFB / FCP）**：关键内容先到达。
2. **并行加载多个慢数据源**：多个 `<Suspense>` 区块互不阻塞。
3. **渐进增强**：即使 JS 未加载完，HTML 内容已经可见。
4. **更好的 Core Web Vitals**：LCP（最大内容绘制）时间提前。

---

## 五、与客户端取数方案的取舍

**React Query / SWR 等客户端取数库**仍有其价值：纯客户端交互、需要轮询、离线支持、乐观更新等场景，客户端取数更灵活；但对于初始数据加载，Next.js 服务端取数在性能和安全性上几乎总是更优选择，二者可结合使用（服务端取初始数据，客户端库负责实时更新）。

---

## 六、常见坑与注意事项

### 坑 1：客户端组件不能直接 await

```tsx
"use client";

// ❌ 错误：客户端组件不能是 async 函数（React 不支持）
export default async function ClientPage() {
  const data = await fetchData();  // 运行时报错
}

// ✅ 正确：改用 useEffect 或把数据获取移到父级服务端组件
export default function ClientPage({ initialData }) {
  const [data, setData] = useState(initialData);
  // ...
}
```

**解决方案**：数据获取永远在服务端组件（无 "use client"）中完成，通过 props 把数据传给客户端组件。

### 坑 2：缓存导致看到旧数据

**症状**：修改了数据库，刷新页面却还是旧数据。

**原因**：使用了 `force-cache` 或 `revalidate`，缓存尚未过期。

**解决方案**：
- 开发时：Next.js 开发模式（`next dev`）默认不缓存，`next start` 才会缓存。
- 生产时：调小 `revalidate` 时间，或改用 `no-store`，或手动调用 `revalidatePath()`。

```tsx
// 手动清除指定路径的缓存（在 Server Action 中）
import { revalidatePath } from "next/cache";
revalidatePath("/posts");  // 下次访问 /posts 时重新获取
```

### 坑 3：Next.js 15 的 fetch 默认行为变化

Next.js 15 之前：`fetch()` 默认 `force-cache`（结果被缓存）。  
Next.js 15 起：`fetch()` 默认 `no-store`（每次都实时获取）。

升级时若发现性能下降（每次都请求数据），需要显式加上缓存选项。

### 坑 4：不要在循环中串行 await

```tsx
// ❌ 慢：串行，总时间 = 所有请求之和
for (const id of ids) {
  const item = await fetch(`/api/items/${id}`);
}

// ✅ 快：并行，总时间 = 最慢那个请求
const items = await Promise.all(ids.map(id => fetch(`/api/items/${id}`)));
```

---

## 七、小练习

1. **基础**：在 `page.tsx` 里写一个 `async` 服务端组件，`await` 一个返回 `{ message: string }` 的本地函数（模拟延迟），然后把 `message` 渲染出来。

2. **进阶**：创建两个 async 组件 `<FastWidget />`（100ms）和 `<SlowWidget />`（2000ms），用两个 `<Suspense>` 分别包裹它们，观察页面是先显示 FastWidget 还是同时显示。

3. **挑战**：理解 `revalidate` 的 stale-while-revalidate 语义：在本地用 `next start` 启动生产模式，访问一个设置了 `revalidate: 10` 的页面，等 10 秒后再访问，观察数据是否立刻变化（答：不会立刻变，要再访问一次才看到新数据）。

4. **思考题**：什么情况下你会选择在客户端用 SWR 而不是在服务端 async 组件里取数？（提示：考虑实时性、用户交互触发的请求、离线场景）

---

## 本章关键词速查

| 关键词 | 含义 |
|---|---|
| Server Component | 服务端组件，可以是 async 函数 |
| RSC Payload | 服务端组件序列化后发给客户端的格式 |
| Streaming | 分块发送 HTML，不等全部就绪才发送 |
| Suspense | React 原语，声明"这块内容可能还没准备好" |
| ISR | 增量静态再生成，stale-while-revalidate |
| revalidate | 缓存过期时间（秒），过期后后台刷新 |
| no-store | 不缓存，每次实时获取 |
| force-cache | 强制使用缓存 |
| revalidatePath | 手动清除指定路径的缓存 |
| Dynamic Rendering | 动态渲染，每次请求时实时计算 |
| Static Rendering | 静态渲染，构建时或首次后缓存 |
